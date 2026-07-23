// ─── Croc-WASM Frontend ─────────────────────────────────────────────────
// Bridges the Go WASM module (running in a Web Worker), the WebSocket relay,
// and the browser UI. It handles:
//   1. WebSocket connection to the relay
//   2. PAKE key exchange via Go WASM (worker)
//   3. File chunking, encryption, and pipelined transfer
//   4. File reception, decryption, in-place reassembly, and download
//
// Stage 2 architecture: WASM runs in a Worker so encryption never blocks the
// main thread; sending is a pipelined (double-buffered) loop with backpressure;
// receiving writes decrypted chunks directly into a pre-allocated buffer.

const RELAY_URL = `ws://${window.location.host}/ws`;
const CHUNK_SIZE = 256 * 1024; // 256KB chunks
const BACKPRESSURE_THRESHOLD = 4 * 1024 * 1024; // pause when ws send buffer > 4MB

// ─── State ────────────────────────────────────────────────────────────────
const state = {
	role: null, // 'sender' | 'receiver'
	code: null, // room code / PAKE secret
	ws: null, // WebSocket connection
	transferId: null, // UUID for this transfer
	files: [], // selected files (sender)
	receivedMetadata: null, // file metadata from sender
	merged: null, // pre-allocated Uint8Array for received file (written in-place)
	mergeOffset: 0, // current write offset into merged
	totalChunks: 0,
	currentChunk: 0,
	sessionKey: null, // base64 session key (kept for debug)
	sessionKeyBytes: null, // Uint8Array session key (used for encrypt/decrypt)
	streaming: false, // true when writing to disk via File System Access API
	writable: null, // FileSystemWritableFileStream (when streaming)
	fileHandle: null, // FileSystemFileHandle (when streaming)
};

// ─── Worker Bridge ────────────────────────────────────────────────────────
// The Go WASM module runs in a dedicated Worker; calls return Promises and
// Uint8Array payloads are transferred zero-copy.
const worker = new Worker("/worker.js");
let reqId = 0;
const pending = new Map();

worker.onmessage = (e) => {
	const { id, result, error } = e.data;
	const p = pending.get(id);
	if (!p) return;
	pending.delete(id);
	if (error) {
		p.reject(new Error(error));
		return;
	}
	// encrypt/decrypt return Uint8Array; PAKE functions return a JSON string.
	if (result instanceof Uint8Array) {
		p.resolve(result);
	} else if (typeof result === "string") {
		let parsed;
		try {
			parsed = JSON.parse(result);
		} catch (err) {
			p.reject(new Error(`Invalid WASM response: ${err.message}`));
			return;
		}
		if (parsed.error) {
			p.reject(new Error(parsed.error));
			return;
		}
		p.resolve(parsed);
	} else {
		p.resolve(result);
	}
};

// wasmCall invokes a WASM function in the worker and returns a Promise.
// Only the LAST Uint8Array argument is transferred (the data payload); the
// session key is small and reused, so it is cloned rather than transferred
// (transferring would detach its buffer and break the next call).
function wasmCall(fn, ...args) {
	return new Promise((resolve, reject) => {
		const id = ++reqId;
		pending.set(id, { resolve, reject });
		const transfer = [];
		for (let i = args.length - 1; i >= 0; i--) {
			if (args[i] instanceof Uint8Array) {
				transfer.push(args[i].buffer);
				break; // only the last Uint8Array arg
			}
		}
		worker.postMessage({ id, fn, args }, transfer);
	});
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
		ws.binaryType = "arraybuffer"; // receive binary as ArrayBuffer (no FileReader)
		state.ws = ws;

		let pakeState = "init"; // init -> waiting -> paired -> pake -> complete
		let settled = false;
		const resolveOnce = (v) => {
			if (!settled) {
				settled = true;
				resolve(v);
			}
		};
		const rejectOnce = (e) => {
			if (!settled) {
				settled = true;
				reject(e);
			}
		};

		// In-order async processing queue. Decryption runs in the Worker (async),
		// so without serialization a later chunk could finish before an earlier
		// one and write out of order into the receive buffer.
		let chain = Promise.resolve();
		const enqueue = (task) => {
			chain = chain.then(task, (e) => {
				rejectOnce(e);
				throw e; // halt the chain after an error
			});
		};

		ws.onopen = () => {
			addLog(state.role, "Connected to relay, joining room...");
			ws.send(JSON.stringify({ type: "join", room: state.code }));
		};

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
					} else if (msg.type === "paired") {
						pakeState = "paired";
						addLog(state.role, `Connected as ${state.role}! Starting PAKE...`);
						enqueue(() => runPAKEInit());
					} else if (msg.type === "error") {
						rejectOnce(new Error(msg.msg || "Relay error"));
					}
					return;
				}
				if (event.data instanceof ArrayBuffer) {
					const data = new Uint8Array(event.data);
					enqueue(() => handleBinary(data));
					return;
				}
			} catch (err) {
				rejectOnce(err);
			}
		};

		ws.onerror = () => rejectOnce(new Error("WebSocket error"));

		ws.onclose = async (event) => {
			addLog(state.role, `WebSocket closed (code: ${event.code})`);
			try {
				await chain;
			} catch {
				return; // chain already reported the error
			}
			if (!settled) {
				if (
					state.role === "receiver" &&
					state.totalChunks > 0 &&
					state.currentChunk >= state.totalChunks
				) {
					resolveOnce();
				} else {
					rejectOnce(new Error(`Connection closed: code=${event.code}`));
				}
			}
		};

		// ─── PAKE init (sender sends the first PAKE message) ───────────────
		async function runPAKEInit() {
			if (state.role === "sender") {
				$("send-status").textContent = "🔐 正在协商加密密钥...";
			} else {
				$("receive-status").textContent = "🔐 正在协商加密密钥...";
			}
			const role = state.role === "sender" ? 0 : 1;
			await wasmCall("wasmInitPAKE", role, state.code);
			pakeState = "pake";
			if (state.role === "sender") {
				const result = await wasmCall("wasmGetPAKEMessage");
				ws.send(new TextEncoder().encode(result.message));
				addLog(state.role, "PAKE message sent");
			}
		}

		// ─── Binary handler (PAKE payload or encrypted data) ───────────────
		async function handleBinary(data) {
			if (pakeState === "pake") {
				const msgStr = new TextDecoder().decode(data);
				const result = await wasmCall("wasmProcessPAKEMessage", msgStr);
				if (result.message) {
					ws.send(new TextEncoder().encode(result.message));
					addLog(state.role, "PAKE response sent");
				}
				if (result.complete) {
					pakeState = "complete";
					const keyResult = await wasmCall("wasmGetSessionKey");
					state.sessionKey = keyResult.key;
					state.sessionKeyBytes = base64ToUint8Array(keyResult.key);
					addLog(state.role, "PAKE complete! Shared key established.");

					if (state.role === "sender") {
						$("send-status").textContent =
							"🔑 密钥已建立，开始发送文件...";
						await sendFile(ws);
						resolveOnce();
						ws.close();
					} else {
						$("receive-status").textContent =
							"🔑 密钥已建立，等待接收文件...";
						state._metadataReceived = false;
						state.merged = null;
						state.mergeOffset = 0;
						state.currentChunk = 0;
						state.totalChunks = 0;
						state.receivedMetadata = null;
					}
				}
				return;
			}

			if (pakeState === "complete" && state.role === "receiver") {
				await handleReceivedData(data);
				if (
					state.totalChunks > 0 &&
					state.currentChunk >= state.totalChunks
				) {
					resolveOnce();
				}
				return;
			}
		}
	});
}

// ─── Sender: Pipelined File Transfer ─────────────────────────────────────
// Double-buffered pipeline: while chunk i is being sent, chunk i+1 is already
// being read + encrypted in the Worker. This overlaps file I/O, Worker
// encryption, and ws.send so throughput is bounded by the slowest stage rather
// than their sum. Backpressure (bufferedAmount) prevents unbounded buffering.
async function sendFile(ws) {
	const file = state.files[0];
	const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
	state.totalChunks = totalChunks;
	state.currentChunk = 0;
	const keyBytes = state.sessionKeyBytes;

	addLog(
		"send",
		`File: ${file.name}, Size: ${formatSize(file.size)}, Chunks: ${totalChunks}`,
	);

	// Send metadata (encrypted JSON).
	const metadataBytes = new TextEncoder().encode(
		JSON.stringify({
			name: file.name,
			size: file.size,
			chunks: totalChunks,
		}),
	);
	const metadataEnc = await wasmCall("wasmEncrypt", keyBytes, null, metadataBytes);
	ws.send(metadataEnc);
	addLog("send", "Metadata sent");

	$("send-status").textContent = `📤 发送中... 0/${totalChunks}`;

	const fileReader = new FileReader();

	// Read file chunk i into a Uint8Array.
	const readChunk = (i) =>
		new Promise((resolve) => {
			const start = i * CHUNK_SIZE;
			const end = Math.min(start + CHUNK_SIZE, file.size);
			fileReader.onload = () => resolve(new Uint8Array(fileReader.result));
			fileReader.readAsArrayBuffer(file.slice(start, end));
		});

	// Read + encrypt chunk i (encryption runs in the Worker).
	const encryptChunk = async (i) => {
		const chunkData = await readChunk(i);
		return wasmCall("wasmEncrypt", keyBytes, encodeSeq(i), chunkData);
	};

	// Wait if the ws send buffer is too full (backpressure).
	const drain = () =>
		new Promise((resolve) => {
			const check = () => {
				if (ws.bufferedAmount <= BACKPRESSURE_THRESHOLD) resolve();
				else setTimeout(check, 1);
			};
			check();
		});

	// Pipelined send: prefetch chunk i+1 while sending chunk i.
	let prefetch = encryptChunk(0);
	for (let i = 0; i < totalChunks; i++) {
		const encrypted = await prefetch;
		if (i + 1 < totalChunks) {
			prefetch = encryptChunk(i + 1); // start next read+encrypt now
		}
		await drain();
		ws.send(encrypted);

		state.currentChunk = i + 1;
		$("send-status").textContent = `📤 发送中... ${i + 1}/${totalChunks}`;
		$("send-progress-bar").style.width = `${((i + 1) / totalChunks) * 100}%`;
		addLog("send", `Chunk ${i + 1}/${totalChunks} sent`);
	}

	$("send-status").textContent = "✅ 文件发送完成！";
	$("send-progress-bar").style.width = "100%";
	addLog("send", "File transfer complete!");
	// ws is closed by the caller after resolveOnce(); receiver onclose awaits
	// the enqueue chain before deciding whether the close was an error.
}

// ─── Receiver: File Reception ──────────────────────────────────────────────
async function handleReceivedData(data) {
	// 3.2: AAD binds each chunk's position. Metadata uses no AAD; data chunk k
	// uses seq=k, so reordering/replay fails GCM authentication on decrypt.
	const aad = state._metadataReceived ? encodeSeq(state.currentChunk) : null;
	const decrypted = await wasmCall("wasmDecrypt", state.sessionKeyBytes, aad, data);

	if (!state._metadataReceived) {
		// First message is metadata.
		state._metadataReceived = true;
		const metadataStr = new TextDecoder().decode(decrypted);
		let metadata;
		try {
			metadata = JSON.parse(metadataStr);
		} catch (err) {
			throw new Error(`Invalid metadata: ${err.message}`);
		}
		state.receivedMetadata = metadata;
		state.totalChunks = metadata.chunks;
		state.currentChunk = 0;

		// 3.1: stream to disk via File System Access API when available (supports
		// GB files without holding the whole file in memory). Falls back to an
		// in-memory buffer otherwise.
		state.streaming = false;
		state.writable = null;
		if (window.showSaveFilePicker) {
			try {
				state.fileHandle = await window.showSaveFilePicker({
					suggestedName: metadata.name,
				});
				state.writable = await state.fileHandle.createWritable();
				state.streaming = true;
				addLog("receive", "Streaming to disk (File System Access API)");
			} catch (err) {
				if (err.name === "AbortError") {
					throw new Error("用户取消了保存位置选择");
				}
				addLog(
					"receive",
					`File System API unavailable, buffering in memory: ${err.message}`,
				);
			}
		}
		if (!state.streaming) {
			state.merged = new Uint8Array(metadata.size);
			state.mergeOffset = 0;
		}

		addLog(
			"receive",
			`Receiving: ${metadata.name} (${formatSize(metadata.size)}), ${metadata.chunks} chunks`,
		);
		$("receive-status").textContent =
			`📥 接收中... 0/${metadata.chunks}`;
		$("receive-progress-container").classList.remove("hidden");
		return;
	}

	// Write the decrypted chunk to disk (streaming) or in-memory buffer.
	if (state.streaming) {
		await state.writable.write(decrypted);
	} else {
		state.merged.set(decrypted, state.mergeOffset);
		state.mergeOffset += decrypted.length;
	}
	state.currentChunk++;

	$("receive-status").textContent =
		`📥 接收中... ${state.currentChunk}/${state.totalChunks}`;
	$("receive-progress-bar").style.width =
		`${(state.currentChunk / state.totalChunks) * 100}%`;
	addLog("receive", `Chunk ${state.currentChunk}/${state.totalChunks} received`);

	// Check if transfer is complete.
	if (state.currentChunk >= state.totalChunks) {
		if (state.streaming) {
			await state.writable.close();
			state.writable = null;
			$("receive-status").textContent = "✅ 文件已保存到磁盘！";
			$("receive-progress-bar").style.width = "100%";
			addLog(
				"receive",
				`File saved: ${state.receivedMetadata.name} (${formatSize(state.receivedMetadata.size)})`,
			);
			// No download button: file is already on disk.
		} else {
			const blob = new Blob([state.merged]);
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
		}
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
// Decode a base64 string to Uint8Array. Used only once per transfer to convert
// the PAKE session key; the data path is zero-copy Uint8Array end-to-end.
function base64ToUint8Array(b64) {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

// Encode a chunk sequence number as 8-byte big-endian for AES-GCM AAD.
// Binds each chunk's position so reordering/replay is detected on decrypt.
function encodeSeq(n) {
	const aad = new Uint8Array(8);
	new DataView(aad.buffer).setBigUint64(0, BigInt(n), false);
	return aad;
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
document.addEventListener("DOMContentLoaded", () => {
	// WASM loads in the worker (started at module load). Show UI immediately;
	// the first wasmCall awaits worker readiness if needed.
	document.querySelector(".loading-overlay")?.remove();
	$("app-content").classList.remove("hidden");
});
