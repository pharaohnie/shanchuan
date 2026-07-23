// ─── Croc-WASM Frontend ─────────────────────────────────────────────────
// This file bridges the Go WASM module, WebSocket relay, and browser UI.
// It handles:
//   1. WebSocket connection to the relay
//   2. PAKE key exchange via Go WASM
//   3. File chunking, encryption, and transfer
//   4. File reception, decryption, and download

const RELAY_URL = `ws://${window.location.host}/ws`;
const CHUNK_SIZE = 64 * 1024; // 64KB chunks (matching croc's default)

// ─── State ────────────────────────────────────────────────────────────────
const state = {
	role: null, // 'sender' | 'receiver'
	code: null, // room code / PAKE secret
	ws: null, // WebSocket connection
	transferId: null, // UUID for this transfer
	files: [], // selected files (sender) or received chunks (receiver)
	receivedChunks: [], // accumulated received data
	receivedMetadata: null, // file metadata from sender
	totalChunks: 0,
	currentChunk: 0,
	wasmReady: false, // WASM module loaded
};

// ─── WASM Loading ─────────────────────────────────────────────────────────
const go = new Go();

async function loadWASM() {
	try {
		const result = await WebAssembly.instantiateStreaming(
			fetch("/croc.wasm"),
			go.importObject,
		);
		go.run(result.instance);
		state.wasmReady = true;
		console.log("🐊 Croc-WASM module loaded");
		return true;
	} catch (err) {
		console.error("Failed to load WASM:", err);
		return false;
	}
}

// ─── WASM Helpers ─────────────────────────────────────────────────────────
function wasmCall(fn, ...args) {
	if (!state.wasmReady) throw new Error("WASM not ready");
	const resultStr = fn(...args);
	if (typeof resultStr !== "string")
		throw new Error("Unexpected WASM return type");
	const result = JSON.parse(resultStr);
	if (result.error) throw new Error(result.error);
	return result;
}

// ─── UI Elements ──────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

function showTab(tab) {
	document
		.querySelectorAll(".tab-btn")
		.forEach((b) => b.classList.remove("active"));
	document
		.querySelectorAll(".tab-content")
		.forEach((c) => c.classList.remove("active"));
	document.querySelector(`.tab-btn[data-tab="${tab}"]`).classList.add("active");
	document.getElementById(`tab-${tab}`).classList.add("active");
}

function formatSize(bytes) {
	if (bytes === 0) return "0 B";
	const units = ["B", "KB", "MB", "GB", "TB"];
	const i = Math.floor(Math.log(bytes) / Math.log(1024));
	return (bytes / 1024 ** i).toFixed(i > 0 ? 1 : 0) + " " + units[i];
}

function addLog(tab, text) {
	const el = $(`${tab}-log`);
	if (!el) return;
	const ts = new Date().toLocaleTimeString();
	el.textContent += `[${ts}] ${text}\n`;
	el.scrollTop = el.scrollHeight;
}

// ─── Send Flow ────────────────────────────────────────────────────────────
function handleFileSelect(event) {
	const file = event.target.files[0];
	if (!file) return;
	state.files = [file];
	$("send-file-name").textContent = file.name;
	$("send-file-size").textContent = formatSize(file.size);
	$("send-file-info").classList.remove("hidden");
	$("btn-start-send").disabled = false;
}

async function startSend() {
	if (state.files.length === 0) return;

	const btn = $("btn-start-send");
	btn.disabled = true;
	btn.textContent = "⏳ 连接中继...";

	// Generate a room code
	state.code = generateCode();
	state.role = "sender";

	// Show the code
	$("send-code").textContent = state.code;
	$("send-upload-card").classList.add("hidden");
	$("send-progress-card").classList.remove("hidden");
	$("send-progress-card").querySelector("h2").textContent = "📤 发送文件";
	addLog("send", `Code phrase: ${state.code}`);

	try {
		await connectAndTransfer();
	} catch (err) {
		$("send-status").textContent = `❌ ${err.message}`;
		addLog("send", `ERROR: ${err.message}`);
	}
}

// ─── Receive Flow ─────────────────────────────────────────────────────────
async function startReceive() {
	const code = $("receive-code-input").value.trim();
	if (!code) return;

	state.code = code;
	state.role = "receiver";

	$("receive-code-card").classList.add("hidden");
	$("receive-progress-card").classList.remove("hidden");
	$("receive-progress-card").querySelector("h2").textContent = "📥 接收文件";
	addLog("receive", `Code phrase: ${code}`);

	$("btn-start-receive").disabled = true;
	$("btn-start-receive").textContent = "⏳ 连接中...";

	try {
		await connectAndTransfer();
	} catch (err) {
		$("receive-status").textContent = `❌ ${err.message}`;
		addLog("receive", `ERROR: ${err.message}`);
		$("btn-start-receive").disabled = false;
		$("btn-start-receive").textContent = "📥 接收文件";
	}
}

// ─── Core Transfer Logic ──────────────────────────────────────────────────
async function connectAndTransfer() {
	return new Promise((resolve, reject) => {
		addLog(state.role, "Connecting to relay...");
		const ws = new WebSocket(RELAY_URL);
		state.ws = ws;

		let pakeState = "init"; // init → waiting → paired → pake → complete

		ws.onopen = () => {
			addLog(state.role, "Connected to relay, joining room...");
			ws.send(JSON.stringify({ type: "join", room: state.code }));
		};

		// Helper to read binary data from event
		const readBinary = (event) =>
			new Promise((res) => {
				if (event.data instanceof ArrayBuffer) {
					res(new Uint8Array(event.data));
				} else {
					const reader = new FileReader();
					reader.onload = () => res(new Uint8Array(reader.result));
					reader.readAsArrayBuffer(event.data);
				}
			});

		ws.onmessage = (event) => {
			try {
				if (typeof event.data === "string") {
					const msg = JSON.parse(event.data);

					if (msg.type === "waiting") {
						pakeState = "waiting";
						addLog(state.role, "Waiting for peer to connect...");
						if (state.role === "sender") {
							$("send-status").textContent = "⏳ 等待接收方输入口令码...";
						}
						return;
					}

					if (msg.type === "paired") {
						pakeState = "paired";
						addLog(state.role, `Connected as ${state.role}! Starting PAKE...`);

						const role = state.role === "sender" ? 0 : 1;
						wasmCall(wasmInitPAKE, role, state.code);

						if (state.role === "sender") {
							const result = wasmCall(wasmGetPAKEMessage);
							ws.send(new TextEncoder().encode(result.message));
							addLog(state.role, "PAKE message sent");
							$("send-status").textContent = "🔐 正在协商加密密钥...";
						} else {
							$("receive-status").textContent = "🔐 正在协商加密密钥...";
						}
						pakeState = "pake";
						return;
					}

					if (msg.type === "error") {
						reject(new Error(msg.msg || "Relay error"));
						return;
					}

					if (msg.type === "peer_disconnected") {
						reject(new Error("Peer disconnected"));
						return;
					}
				}

				// ── Binary message (PAKE or encrypted data) ──
				if (event.data instanceof ArrayBuffer || event.data instanceof Blob) {
					readBinary(event)
						.then((data) => {
							if (pakeState === "pake") {
								const msgStr = new TextDecoder().decode(data);
								const result = wasmCall(wasmProcessPAKEMessage, msgStr);

								if (result.message) {
									ws.send(new TextEncoder().encode(result.message));
									addLog(state.role, "PAKE response sent");
								}

								if (result.complete) {
									pakeState = "complete";
									const keyResult = wasmCall(wasmGetSessionKey);
									state.sessionKey = keyResult.key;
									addLog(state.role, "PAKE complete! Shared key established.");

									if (state.role === "sender") {
										$("send-status").textContent =
											"🔑 密钥已建立，开始发送文件...";
										sendFile(ws)
											.then(() => resolve())
											.catch(reject);
									} else {
										$("receive-status").textContent =
											"🔑 密钥已建立，等待接收文件...";
										state._metadataReceived = false;
										state.receivedChunks = [];
										state.receivedMetadata = null;
									}
								} else {
									// No message and not complete (shouldn't normally happen)
								}
								return;
							}

							if (pakeState === "complete" && state.role === "receiver") {
								handleReceivedData(data)
									.then(() => {
										// Check if all chunks received
										if (
											state.totalChunks > 0 &&
											state.receivedChunks.length >= state.totalChunks
										) {
											resolve();
										}
									})
									.catch(reject);
								return;
							}
						})
						.catch(reject);
					return;
				}
			} catch (err) {
				reject(err);
			}
		};

		ws.onerror = (_err) => {
			reject(new Error("WebSocket error"));
		};

		ws.onclose = (event) => {
			addLog(state.role, `WebSocket closed (code: ${event.code})`);
			if (pakeState !== "complete") {
				reject(new Error(`Connection closed: code=${event.code}`));
			}
		};
	});
}

// ─── Sender: File Transfer ────────────────────────────────────────────────
async function sendFile(ws) {
	const file = state.files[0];
	const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
	state.totalChunks = totalChunks;
	state.currentChunk = 0;

	addLog(
		"send",
		`File: ${file.name}, Size: ${formatSize(file.size)}, Chunks: ${totalChunks}`,
	);

	// Send metadata (encrypted JSON)
	const metadata = JSON.stringify({
		name: file.name,
		size: file.size,
		chunks: totalChunks,
	});
	const metadataEnc = wasmCall(
		wasmEncrypt,
		state.sessionKey,
		stringToBase64(metadata),
	);
	ws.send(base64ToArrayBuffer(metadataEnc.ciphertext));
	addLog("send", "Metadata sent");

	$("send-status").textContent = `📤 发送中... 0/${totalChunks}`;

	// Read and send chunks
	const fileReader = new FileReader();

	for (let i = 0; i < totalChunks; i++) {
		const start = i * CHUNK_SIZE;
		const end = Math.min(start + CHUNK_SIZE, file.size);
		const chunk = file.slice(start, end);

		const chunkData = await new Promise((resolve) => {
			fileReader.onload = () => resolve(new Uint8Array(fileReader.result));
			fileReader.readAsArrayBuffer(chunk);
		});

		// Send raw chunk data to WASM for encryption
		const chunkB64 = arrayBufferToBase64(chunkData);
		const encrypted = wasmCall(wasmEncrypt, state.sessionKey, chunkB64);
		const encryptedBytes = base64ToArrayBuffer(encrypted.ciphertext);

		ws.send(encryptedBytes);

		state.currentChunk = i + 1;
		$("send-status").textContent = `📤 发送中... ${i + 1}/${totalChunks}`;
		$("send-progress-bar").style.width = `${((i + 1) / totalChunks) * 100}%`;
		addLog("send", `Chunk ${i + 1}/${totalChunks} sent`);
	}

	$("send-status").textContent = "✅ 文件发送完成！";
	$("send-progress-bar").style.width = "100%";
	addLog("send", "File transfer complete!");
	ws.close();
}

// ─── Receiver: File Reception (handled by ws.onmessage in connectAndTransfer) ──

async function handleReceivedData(data) {
	// Decrypt the data
	const dataB64 = arrayBufferToBase64(data);
	const decrypted = wasmCall(wasmDecrypt, state.sessionKey, dataB64);

	if (!state._metadataReceived) {
		// First message is metadata
		state._metadataReceived = true;
		const metadataStr = base64ToString(decrypted.plaintext);
		state.receivedMetadata = JSON.parse(metadataStr);
		state.totalChunks = state.receivedMetadata.chunks;
		state.receivedChunks = [];

		addLog(
			"receive",
			`Receiving: ${state.receivedMetadata.name} (${formatSize(state.receivedMetadata.size)}), ${state.receivedMetadata.chunks} chunks`,
		);
		$("receive-status").textContent =
			`📥 接收中... 0/${state.receivedMetadata.chunks}`;
		$("receive-progress-container").classList.remove("hidden");
		return;
	}

	// Decrypt and store the chunk
	const chunkData = Uint8Array.from(atob(decrypted.plaintext), (c) =>
		c.charCodeAt(0),
	);
	state.receivedChunks.push(chunkData);
	state.currentChunk = state.receivedChunks.length;

	$("receive-status").textContent =
		`📥 接收中... ${state.currentChunk}/${state.totalChunks}`;
	$("receive-progress-bar").style.width =
		`${(state.currentChunk / state.totalChunks) * 100}%`;
	addLog(
		"receive",
		`Chunk ${state.currentChunk}/${state.totalChunks} received`,
	);

	// Check if transfer is complete
	if (state.currentChunk >= state.totalChunks) {
		// Reassemble the file
		const totalSize = state.receivedChunks.reduce(
			(sum, chunk) => sum + chunk.length,
			0,
		);
		const merged = new Uint8Array(totalSize);
		let offset = 0;
		for (const chunk of state.receivedChunks) {
			merged.set(chunk, offset);
			offset += chunk.length;
		}

		// Create download
		const blob = new Blob([merged]);
		const url = URL.createObjectURL(blob);
		state._downloadUrl = url;
		state._downloadName = state.receivedMetadata.name;

		$("receive-status").textContent = "✅ 文件接收完成！";
		$("receive-progress-bar").style.width = "100%";
		addLog(
			"receive",
			`File received: ${state.receivedMetadata.name} (${formatSize(state.receivedMetadata.size)})`,
		);
		$("receive-download-section").classList.remove("hidden");
		$("btn-download").onclick = () => downloadReceivedFile();

		// Promise resolved in connectAndTransfer's ws.onmessage handler
	}
}

function downloadReceivedFile() {
	if (state._downloadUrl) {
		const a = document.createElement("a");
		a.href = state._downloadUrl;
		a.download = state._downloadName;
		a.click();
	}
}

// ─── Code Generation ──────────────────────────────────────────────────────
function generateCode() {
	const adjs = [
		"swift",
		"calm",
		"bold",
		"cool",
		"warm",
		"kind",
		"safe",
		"pure",
		"keen",
		"fair",
		"slim",
		"neat",
		"rare",
		"vast",
		"firm",
		"deep",
		"high",
		"long",
		"full",
		"glad",
		"soft",
		"flat",
		"rich",
		"wild",
		"busy",
		"free",
		"dark",
		"bright",
		"strong",
		"quick",
		"brave",
		"clear",
		"clean",
		"crisp",
		"fresh",
		"grand",
		"happy",
		"light",
		"loyal",
		"noble",
		"proud",
		"sharp",
		"silent",
		"smart",
		"smooth",
		"solid",
		"steady",
		"sunny",
		"super",
		"sweet",
		"tough",
		"vivid",
		"agile",
		"elite",
		"exact",
		"fleet",
		"fluid",
		"grace",
		"jewel",
		"lunar",
		"merry",
		"rapid",
		"solar",
		"spark",
		"steel",
		"stone",
		"surge",
		"tiger",
		"trail",
		"ultra",
		"valid",
		"valor",
		"vigor",
		"vista",
		"vocal",
		"water",
		"white",
		"world",
		"youth",
		"zebra",
		"zesty",
		"zonal",
	];
	const nouns = [
		"falcon",
		"tiger",
		"eagle",
		"panda",
		"otter",
		"coral",
		"ridge",
		"brook",
		"cloud",
		"flame",
		"stone",
		"ocean",
		"maple",
		"amber",
		"creek",
		"dawn",
		"ember",
		"frost",
		"glade",
		"hazel",
		"koala",
		"lunar",
		"marsh",
		"noble",
		"orbit",
		"pearl",
		"quartz",
		"raven",
		"sable",
		"timber",
		"umbra",
		"valley",
		"acorn",
		"bloom",
		"cider",
		"dunes",
		"feather",
		"grove",
		"harbor",
		"iris",
		"jasmine",
		"lagoon",
		"mango",
		"nectar",
		"olive",
		"plum",
		"reef",
		"salmon",
		"thyme",
		"violet",
		"willow",
		"zephyr",
		"aster",
		"basil",
		"cedar",
		"dahlia",
		"fern",
		"garden",
		"heather",
		"indigo",
		"juniper",
		"kiwi",
		"lilac",
		"mint",
		"orchid",
		"peony",
		"rose",
		"sage",
		"tulip",
		"wisteria",
	];
	const a = adjs[Math.floor(Math.random() * adjs.length)];
	const n1 = nouns[Math.floor(Math.random() * nouns.length)];
	const n2 = nouns[Math.floor(Math.random() * nouns.length)];
	const num = Math.floor(Math.random() * 100);
	return `${a}-${n1}-${n2}-${num}`;
}

// ─── Utility Functions ────────────────────────────────────────────────────
function arrayBufferToBase64(bytes) {
	let binary = "";
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary);
}

function stringToBase64(str) {
	const bytes = new TextEncoder().encode(str);
	let binary = "";
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary);
}

function base64ToString(b64) {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return new TextDecoder().decode(bytes);
}

function base64ToArrayBuffer(base64) {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes.buffer;
}

function copyCode() {
	const code = $("send-code").textContent;
	navigator.clipboard.writeText(code).then(() => {
		const btn = document.querySelector(".btn-small");
		btn.textContent = "✅ 已复制";
		setTimeout(() => (btn.textContent = "📋 复制"), 2000);
	});
}

// ─── Initialization ───────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
	const loaded = await loadWASM();
	if (loaded) {
		document.querySelector(".loading-overlay")?.remove();
		$("app-content").classList.remove("hidden");
	} else {
		const errDiv = document.createElement("div");
		errDiv.style.cssText = "padding:40px;text-align:center;color:#f87171";
		const h1 = document.createElement("h1");
		h1.textContent = "❌ WASM 加载失败";
		const p = document.createElement("p");
		p.textContent = "请检查浏览器是否支持 WebAssembly";
		errDiv.appendChild(h1);
		errDiv.appendChild(p);
		document.body.appendChild(errDiv);
	}
});
