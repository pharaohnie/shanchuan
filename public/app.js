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
const GCM_OVERHEAD = 12 + 16; // nonce + tag
const SCTP_DEFAULT_MAX = 256 * 1024; // 262144
// Margin below SCTP maxMessageSize so encrypted payload fits in one DC message.
const P2P_MAX_PLAINTEXT = SCTP_DEFAULT_MAX - GCM_OVERHEAD - 64;

function effectiveChunkSize(transport) {
	return transport?.mode === "p2p"
		? Math.min(CHUNK_SIZE, P2P_MAX_PLAINTEXT)
		: CHUNK_SIZE;
}

function totalChunksForFile(file, transport) {
	const chunkSize = effectiveChunkSize(transport);
	return Math.ceil(file.size / chunkSize);
}

function batchTotalChunksForFiles(files, transport) {
	let total = 0;
	for (const file of files) {
		total += totalChunksForFile(file, transport);
	}
	return total;
}

function batchGlobalChunks(fileIndex, chunkInFile, files, transport) {
	let done = 0;
	for (let i = 0; i < fileIndex; i++) {
		done += totalChunksForFile(files[i], transport);
	}
	return done + chunkInFile;
}

function progressPercent(globalChunk, batchTotal) {
	return batchTotal > 0 ? (globalChunk / batchTotal) * 100 : 100;
}

function setProgressBar(el, percent, animate = false) {
	if (!el) return;
	const p = Math.min(100, Math.max(0, percent)) / 100;
	el.classList.toggle("is-complete", animate);
	el.style.transform = `scaleX(${p})`;
}

function formatTransferProgress(
	role,
	fileIndex,
	fileCount,
	fileName,
	globalChunk,
	batchTotal,
) {
	const icon = role === "send" ? "📤" : "📥";
	const verb = role === "send" ? "发送中" : "接收中";
	const pct = progressPercent(globalChunk, batchTotal).toFixed(1);
	const chunkPart = `Chunk ${globalChunk}/${batchTotal} (${pct}%)`;
	if (fileCount > 1) {
		return `${icon} ${verb} ${fileIndex + 1}/${fileCount} · ${fileName} · ${chunkPart}`;
	}
	return `${icon} ${verb}... ${chunkPart}`;
}

function receiveGlobalChunk() {
	return state.batchDoneChunks + state.currentChunk;
}

function updateReceiveProgressUI() {
	const global = receiveGlobalChunk();
	const batchTotal = state.batchTotalChunks;
	const name = state.receivedMetadata?.name ?? "";
	$("receive-status").textContent = formatTransferProgress(
		"receive",
		state.fileIndex,
		state.fileCount,
		name,
		global,
		batchTotal,
	);
	setProgressBar($("receive-progress-bar"), progressPercent(global, batchTotal));
}

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
	transport: null, // RelayTransport | P2pTransport
	transportMode: null, // 'p2p' | 'relay'
	stunReachable: null, // null=checking, true/false=STUN precheck result
	fileCount: 1, // batch total files (receiver)
	fileIndex: 0, // current file index in batch (receiver)
	saveDir: null, // showDirectoryPicker handle (multi-file batch)
	receivedFiles: [], // [{name, url}] in memory fallback mode
	batchTotalChunks: 0, // total chunks across batch (receiver)
	batchDoneChunks: 0, // chunks from fully received files (receiver)
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

function updateTransportModeUI(tab, mode) {
	state.transportMode = mode;
	const el = $(`${tab}-transport-mode`);
	if (!el) return;
	if (mode === "p2p") {
		el.textContent = "直连 (P2P)";
		el.className = "transport-mode transport-mode-p2p";
	} else {
		el.textContent = "中继转发";
		el.className = "transport-mode transport-mode-relay";
	}
	el.classList.remove("hidden");
}

const SIGNALING_MSG_TYPES = new Set([
	"webrtc-offer",
	"webrtc-answer",
	"ice-candidate",
	"transport-mode",
]);

function isSignalingMessage(msg) {
	return SIGNALING_MSG_TYPES.has(msg.type);
}

async function reportStunCheck(result) {
	try {
		const resp = await fetch("/api/stun-check", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(result),
		});
		if (!resp.ok) {
			console.warn("STUN report failed: HTTP", resp.status);
		}
	} catch (err) {
		console.warn("STUN report failed:", err);
	}
	return result;
}

let stunPrecheckStarted = null;

function startStunPrecheck() {
	if (!stunPrecheckStarted) {
		stunPrecheckStarted = checkStunConnectivity()
			.then(reportStunCheck)
			.then((r) => {
				state.stunReachable = r.ok;
				return r;
			})
			.catch((err) => {
				state.stunReachable = false;
				console.warn("STUN precheck failed:", err);
				return {
					ok: false,
					server: STUN_SERVER,
					elapsedMs: 0,
					candidateTypes: [],
					error: err.message,
				};
			});
	}
	return stunPrecheckStarted;
}

async function waitForStunPrecheck() {
	if (state.stunReachable !== null) {
		return state.stunReachable;
	}
	const r = await startStunPrecheck();
	return r.ok;
}

function isBatchComplete() {
	const fileDone =
		state.totalChunks === 0 ||
		(state.totalChunks > 0 && state.currentChunk >= state.totalChunks);
	return fileDone && state.fileIndex >= state.fileCount - 1;
}

function resetForNextFile() {
	state._metadataReceived = false;
	state.currentChunk = 0;
	state.totalChunks = 0;
	state.merged = null;
	state.mergeOffset = 0;
	state.writable = null;
	state.fileHandle = null;
	state.streaming = false;
	state.receivedMetadata = null;
}

function bindReceiverTransport(transport, enqueue, resolveOnce) {
	state.transport = transport;
	transport.onMessage((data) => {
		enqueue(async () => {
			await handleReceivedData(data);
			if (isBatchComplete()) {
				resolveOnce();
			}
		});
	});
}

async function setupRelayOnlyTransport(ws, tab, role) {
	const transport = new RelayTransport(ws);
	if (role === "sender") {
		ws.send(JSON.stringify({ type: "transport-mode", mode: "relay" }));
	}
	updateTransportModeUI(tab, "relay");
	addLog(tab, "STUN 预检未通过，跳过 P2P，使用中继");
	return transport;
}

async function setupReceiverTransport(ws, negotiator, enqueue, resolveOnce) {
	const reachable = await waitForStunPrecheck();
	if (!reachable) {
		if (negotiator) negotiator.destroy();
		const transport = await setupRelayOnlyTransport(
			ws,
			"receive",
			"receiver",
		);
		bindReceiverTransport(transport, enqueue, resolveOnce);
		return;
	}

	const { mode, p2pTransport } = await negotiator.waitReady();
	const transport =
		mode === "p2p" ? p2pTransport : new RelayTransport(ws);
	state.transport = transport;
	updateTransportModeUI("receive", mode);
	addLog(
		"receive",
		mode === "p2p"
			? "P2P 直连已建立，等待接收文件..."
			: "P2P 不可用，使用中继转发...",
	);
	bindReceiverTransport(transport, enqueue, resolveOnce);
}

async function setupSenderTransport(ws, assignNegotiator, flushPendingSignaling) {
	const reachable = await waitForStunPrecheck();
	if (!reachable) {
		return setupRelayOnlyTransport(ws, "send", "sender");
	}

	const n = new P2pNegotiator(ws, "sender");
	if (assignNegotiator) assignNegotiator(n);
	await n.start();
	if (flushPendingSignaling) flushPendingSignaling();
	const { mode, p2pTransport } = await n.waitReady();
	const transport =
		mode === "p2p" ? p2pTransport : new RelayTransport(ws);
	n.sendSignaling({ type: "transport-mode", mode });
	updateTransportModeUI("send", mode);
	addLog(
		"send",
		mode === "p2p" ? "P2P 直连已建立" : "P2P 不可用，使用中继转发",
	);
	return transport;
}

// ─── Send Flow ────────────────────────────────────────────────────────────
function renderSelectedFiles() {
	const list = $("send-file-list");
	const totalEl = $("send-file-total-size");
	list.innerHTML = "";
	let totalBytes = 0;
	for (const file of state.files) {
		totalBytes += file.size;
		const li = document.createElement("li");
		li.className = "file-list-item";
		const name = document.createElement("span");
		name.className = "file-name";
		name.textContent = file.name;
		name.title = file.name;
		const size = document.createElement("span");
		size.className = "file-size";
		size.textContent = formatSize(file.size);
		li.append(name, size);
		list.appendChild(li);
	}
	const n = state.files.length;
	totalEl.textContent =
		n === 1
			? formatSize(totalBytes)
			: `共 ${n} 个文件，${formatSize(totalBytes)}`;
	$("send-file-info").classList.remove("hidden");
	$("btn-start-send").disabled = false;
}

function handleFileSelect(event) {
	const files = Array.from(event.target.files || []);
	if (files.length === 0) return;
	state.files = files;
	renderSelectedFiles();
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
	const fileLabel =
		state.files.length === 1
			? "📤 发送文件"
			: `📤 发送 ${state.files.length} 个文件`;
	$("send-progress-card").querySelector("h2").textContent = fileLabel;
	addLog("send", `Code phrase: ${state.code}`);
	if (state.files.length > 1) {
		addLog("send", `Sending ${state.files.length} files`);
	}

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
		let negotiator = null;
		const pendingSignaling = [];

		const flushPendingSignaling = () => {
			if (!negotiator) return;
			for (const msg of pendingSignaling.splice(0)) {
				negotiator.handleMessage(msg).catch((e) => rejectOnce(e));
			}
		};

		const handleSignaling = (msg) => {
			if (negotiator) {
				negotiator.handleMessage(msg).catch((e) => rejectOnce(e));
			} else {
				pendingSignaling.push(msg);
			}
		};
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
					} else if (isSignalingMessage(msg)) {
						handleSignaling(msg);
					} else if (msg.type === "error") {
						rejectOnce(new Error(msg.msg || "Relay error"));
					}
					return;
				}
				if (event.data instanceof ArrayBuffer) {
					const data = new Uint8Array(event.data);
					if (pakeState === "pake") {
						enqueue(() => handleBinary(data));
					} else if (
						pakeState === "complete" &&
						state.transport?.mode === "relay"
					) {
						state.transport.dispatch(data);
					}
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
				if (state.role === "receiver" && isBatchComplete()) {
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
							"🔑 密钥已建立，协商 P2P 连接...";
						const transport = await setupSenderTransport(
							ws,
							(n) => {
								negotiator = n;
							},
							flushPendingSignaling,
						);
						$("send-status").textContent =
							"🔑 密钥已建立，开始发送文件...";
						await sendAllFiles(transport);
						resolveOnce();
						ws.close();
					} else {
						$("receive-status").textContent =
							"🔑 密钥已建立，协商 P2P 连接...";
						state._metadataReceived = false;
						state.merged = null;
						state.mergeOffset = 0;
						state.currentChunk = 0;
						state.totalChunks = 0;
						state.receivedMetadata = null;
						state.fileCount = 1;
						state.fileIndex = 0;
						state.saveDir = null;
						state.receivedFiles = [];
						state.batchTotalChunks = 0;
						state.batchDoneChunks = 0;
						if (!negotiator) {
							negotiator = new P2pNegotiator(ws, "receiver");
							await negotiator.start();
							flushPendingSignaling();
						}
						await setupReceiverTransport(
							ws,
							negotiator,
							enqueue,
							resolveOnce,
						);
					}
				}
				return;
			}
		}
	});
}

// ─── Sender: Pipelined File Transfer ─────────────────────────────────────
// Double-buffered pipeline: while chunk i is being sent, chunk i+1 is already
// being read + encrypted in the Worker. This overlaps file I/O, Worker
// encryption, and transport.send so throughput is bounded by the slowest stage
// rather than their sum. Backpressure (bufferedAmount) prevents unbounded buffering.
async function sendAllFiles(transport) {
	const files = state.files;
	const fileCount = files.length;
	const batchTotalChunks = batchTotalChunksForFiles(files, transport);
	setProgressBar($("send-progress-bar"), 0);
	for (let i = 0; i < fileCount; i++) {
		await sendOneFile(transport, files[i], i, fileCount, batchTotalChunks);
	}
	$("send-status").textContent =
		fileCount > 1 ? `✅ ${fileCount} 个文件发送完成！` : "✅ 文件发送完成！";
	setProgressBar($("send-progress-bar"), 100, true);
	addLog(
		"send",
		fileCount > 1 ? `All ${fileCount} files sent` : "File transfer complete!",
	);
}

async function sendOneFile(transport, file, fileIndex, fileCount, batchTotalChunks) {
	const chunkSize = effectiveChunkSize(transport);
	const totalChunks = Math.ceil(file.size / chunkSize);
	state.totalChunks = totalChunks;
	state.currentChunk = 0;
	const keyBytes = state.sessionKeyBytes;

	addLog(
		"send",
		`File ${fileIndex + 1}/${fileCount}: ${file.name}, Size: ${formatSize(file.size)}, Chunks: ${totalChunks}`,
	);

	const metadataBytes = new TextEncoder().encode(
		JSON.stringify({
			name: file.name,
			size: file.size,
			chunks: totalChunks,
			fileIndex,
			fileCount,
			batchTotalChunks,
		}),
	);
	const metadataEnc = await wasmCall("wasmEncrypt", keyBytes, null, metadataBytes);
	transport.send(metadataEnc);
	addLog("send", "Metadata sent");

	const updateSendProgress = (chunkInFile) => {
		const global = batchGlobalChunks(
			fileIndex,
			chunkInFile,
			state.files,
			transport,
		);
		$("send-status").textContent = formatTransferProgress(
			"send",
			fileIndex,
			fileCount,
			file.name,
			global,
			batchTotalChunks,
		);
		setProgressBar(
			$("send-progress-bar"),
			progressPercent(global, batchTotalChunks),
		);
	};

	const logSendChunk = (chunkInFile) => {
		const global = batchGlobalChunks(
			fileIndex,
			chunkInFile,
			state.files,
			transport,
		);
		const fileNote =
			fileCount > 1 ? ` (file ${fileIndex + 1}/${fileCount})` : "";
		addLog(
			"send",
			`Chunk ${global}/${batchTotalChunks} sent${fileNote}`,
		);
	};

	updateSendProgress(0);

	if (totalChunks === 0) {
		return;
	}

	const fileReader = new FileReader();

	const readChunk = (i) =>
		new Promise((resolve) => {
			const start = i * chunkSize;
			const end = Math.min(start + chunkSize, file.size);
			fileReader.onload = () => resolve(new Uint8Array(fileReader.result));
			fileReader.readAsArrayBuffer(file.slice(start, end));
		});

	const encryptChunk = async (i) => {
		const chunkData = await readChunk(i);
		return wasmCall("wasmEncrypt", keyBytes, encodeSeq(i), chunkData);
	};

	const drain = () => transport.drain(BACKPRESSURE_THRESHOLD);

	let prefetch = encryptChunk(0);
	for (let i = 0; i < totalChunks; i++) {
		const encrypted = await prefetch;
		if (i + 1 < totalChunks) {
			prefetch = encryptChunk(i + 1);
		}
		await drain();
		transport.send(encrypted);

		state.currentChunk = i + 1;
		updateSendProgress(i + 1);
		logSendChunk(i + 1);
	}
}

// ─── Receiver: File Reception ──────────────────────────────────────────────
function renderDownloadList() {
	const list = $("receive-download-list");
	list.innerHTML = "";
	for (const f of state.receivedFiles) {
		const btn = document.createElement("button");
		btn.className = "btn btn-success";
		btn.textContent = `⬇️ ${f.name}`;
		btn.onclick = () => {
			const a = document.createElement("a");
			a.href = f.url;
			a.download = f.name;
			a.click();
		};
		list.appendChild(btn);
	}
	$("receive-download-section").classList.remove("hidden");
}

async function finishCurrentFile() {
	const metadata = state.receivedMetadata;
	if (state.streaming) {
		await state.writable.close();
		state.writable = null;
		addLog(
			"receive",
			`File saved: ${metadata.name} (${formatSize(metadata.size)})`,
		);
	} else {
		const blob = new Blob([state.merged]);
		const url = URL.createObjectURL(blob);
		state.receivedFiles.push({ name: metadata.name, url });
		addLog(
			"receive",
			`File received: ${metadata.name} (${formatSize(metadata.size)})`,
		);
	}

	if (state.fileIndex < state.fileCount - 1) {
		state.batchDoneChunks += metadata.chunks;
		resetForNextFile();
		return false;
	}

	if (state.streaming) {
		$("receive-status").textContent =
			state.fileCount > 1
				? `✅ 已接收 ${state.fileCount} 个文件`
				: "✅ 文件已保存到磁盘！";
	} else {
		$("receive-status").textContent =
			state.fileCount > 1
				? `✅ 已接收 ${state.fileCount} 个文件`
				: "✅ 文件接收完成！";
		renderDownloadList();
	}
	setProgressBar($("receive-progress-bar"), 100, true);
	return true;
}

async function handleReceivedData(data) {
	// 3.2: AAD binds each chunk's position. Metadata uses no AAD; data chunk k
	// uses seq=k, so reordering/replay fails GCM authentication on decrypt.
	const aad = state._metadataReceived ? encodeSeq(state.currentChunk) : null;
	const decrypted = await wasmCall("wasmDecrypt", state.sessionKeyBytes, aad, data);

	if (!state._metadataReceived) {
		state._metadataReceived = true;
		const metadataStr = new TextDecoder().decode(decrypted);
		let metadata;
		try {
			metadata = JSON.parse(metadataStr);
		} catch (err) {
			throw new Error(`Invalid metadata: ${err.message}`);
		}
		const fileIndex = metadata.fileIndex ?? 0;
		const fileCount = metadata.fileCount ?? 1;
		state.receivedMetadata = metadata;
		state.fileIndex = fileIndex;
		state.fileCount = fileCount;
		state.totalChunks = metadata.chunks;
		state.currentChunk = 0;
		state.batchTotalChunks =
			metadata.batchTotalChunks ?? metadata.chunks;

		state.streaming = false;
		state.writable = null;

		if (fileIndex === 0 && fileCount > 1 && window.showDirectoryPicker) {
			try {
				state.saveDir = await window.showDirectoryPicker();
				addLog("receive", "Save directory selected for batch");
			} catch (err) {
				if (err.name === "AbortError") {
					throw new Error("用户取消了保存位置选择");
				}
				addLog(
					"receive",
					`Directory picker unavailable: ${err.message}`,
				);
			}
		}

		if (state.saveDir) {
			try {
				state.fileHandle = await state.saveDir.getFileHandle(
					metadata.name,
					{ create: true },
				);
				state.writable = await state.fileHandle.createWritable();
				state.streaming = true;
				addLog("receive", "Streaming to disk (File System Access API)");
			} catch (err) {
				throw new Error(`无法写入文件 ${metadata.name}: ${err.message}`);
			}
		} else if (window.showSaveFilePicker) {
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
		$("receive-progress-container").classList.remove("hidden");
		void $("receive-progress-bar").offsetWidth;
		updateReceiveProgressUI();

		if (metadata.chunks === 0) {
			await finishCurrentFile();
		}
		return;
	}

	if (state.streaming) {
		await state.writable.write(decrypted);
	} else {
		state.merged.set(decrypted, state.mergeOffset);
		state.mergeOffset += decrypted.length;
	}
	state.currentChunk++;

	updateReceiveProgressUI();
	const global = receiveGlobalChunk();
	const fileNote =
		state.fileCount > 1
			? ` (file ${state.fileIndex + 1}/${state.fileCount})`
			: "";
	addLog(
		"receive",
		`Chunk ${global}/${state.batchTotalChunks} received${fileNote}`,
	);

	if (state.currentChunk >= state.totalChunks) {
		await finishCurrentFile();
	}
}

function downloadReceivedFile() {
	for (const f of state.receivedFiles) {
		const a = document.createElement("a");
		a.href = f.url;
		a.download = f.name;
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
	startStunPrecheck();
});
