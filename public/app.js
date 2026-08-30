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
//
// All DOM manipulation lives in ui.js behind the `ui` facade; this file is
// pure transfer logic and exposes `window.croc` for the UI to call into.

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

function hideProgressBar(role) {
	if (typeof window.ui?.hideProgressBar === "function") {
		window.ui.hideProgressBar(role);
	} else {
		document.getElementById(`${role}-progress-wrapper`)?.classList.add("hidden");
	}
}

function formatTransferProgress(role, fileIndex, fileCount, fileName) {
	const verb = role === "send" ? "发送中" : "接收中";
	if (fileCount > 1) {
		return `${verb} ${fileIndex + 1}/${fileCount} · ${fileName}`;
	}
	return `${verb}...`;
}

function receiveGlobalChunk() {
	return state.batchDoneChunks + state.currentChunk;
}

function updateReceiveProgressUI() {
	if (state.isTextPayload) return;
	const global = receiveGlobalChunk();
	const batchTotal = state.batchTotalChunks;
	const name = state.receivedMetadata?.name ?? "";
	ui.setStatus(
		"receive",
		formatTransferProgress(
			"receive",
			state.fileIndex,
			state.fileCount,
			name,
		),
		"progress",
	);
	ui.setProgress("receive", progressPercent(global, batchTotal));
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
	sendMode: "file", // "file" | "text"
	textSend: false, // true when sending prepared text file
	isTextPayload: false, // true when receiving kind:text metadata
	bytesWritten: 0, // streaming mode: cumulative bytes written
};

let relayUrlPromise = null;

async function getRelayURL() {
	if (!relayUrlPromise) {
		relayUrlPromise = (async () => {
			try {
				const resp = await fetch("/api/config");
				if (resp.ok) {
					const data = await resp.json();
					return crocSecurity.deriveRelayURL(data.relay_url);
				}
			} catch (err) {
				console.warn("Failed to load relay config, using default:", err);
			}
			return crocSecurity.deriveRelayURL("");
		})();
	}
	return relayUrlPromise;
}

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

function formatSize(bytes) {
	if (bytes === 0) return "0 B";
	const units = ["B", "KB", "MB", "GB", "TB"];
	const i = Math.floor(Math.log(bytes) / Math.log(1024));
	return (bytes / 1024 ** i).toFixed(i > 0 ? 1 : 0) + " " + units[i];
}

function updateTransportModeUI(tab, mode) {
	state.transportMode = mode;
	ui.setTransportMode(tab, mode);
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
	state.bytesWritten = 0;
}

function bindReceiverTransport(ws, transport, enqueue, resolveOnce) {
	state.transport = transport;
	transport.onMessage((data) => {
		enqueue(async () => {
			await handleReceivedData(data);
			if (isBatchComplete()) {
				resolveOnce();
				if (transport.mode === "relay") {
					ws.send(
						JSON.stringify({ type: crocTransferPolicy.TRANSFER_ACK }),
					);
					ws.close();
				}
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
		bindReceiverTransport(ws, transport, enqueue, resolveOnce);
		return;
	}

	const { mode, p2pTransport } = await negotiator.waitReady();
	const transport =
		mode === "p2p" ? p2pTransport : new RelayTransport(ws);
	state.transport = transport;
	updateTransportModeUI("receive", mode);
	bindReceiverTransport(ws, transport, enqueue, resolveOnce);
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
	return transport;
}

// ─── Send Flow ────────────────────────────────────────────────────────────
const MAX_TEXT_BYTES = 1024 * 1024;

function prepareTextFile(text) {
	if (!text || !text.trim()) throw new Error("请输入要发送的文本");
	const bytes = new TextEncoder().encode(text);
	if (bytes.length > MAX_TEXT_BYTES) throw new Error("文本超过 1MB 限制");
	return new File([bytes], "message.txt", { type: "text/plain" });
}

async function startSend(text) {
	if (state.sendMode === "text") {
		try {
			state.files = [prepareTextFile(text)];
			state.textSend = true;
		} catch (err) {
			ui.showError("send", err.message);
			return;
		}
	} else if (state.files.length === 0) {
		return;
	} else {
		state.textSend = false;
	}

	try {
		crocSecurity.validateSendFiles(state.files);
	} catch (err) {
		ui.showError("send", err.message);
		return;
	}

	ui.setBusy("send", true);

	// Generate a room code
	state.code = crocSecurity.generateSecureCode();
	state.role = "sender";

	// Show the code and switch to the transfer view
	ui.setCode(state.code);
	ui.enterTransfer("send");
	let fileLabel;
	if (state.textSend) {
		fileLabel = "发送文本";
	} else if (state.files.length === 1) {
		fileLabel = "发送文件";
	} else {
		fileLabel = `发送 ${state.files.length} 个文件`;
	}
	ui.setCardTitle("send", fileLabel);

	if (state.textSend) {
		hideProgressBar("send");
	}

	try {
		await connectAndTransfer();
	} catch (err) {
		ui.showError("send", err.message);
	}
}

// ─── Receive Flow ─────────────────────────────────────────────────────────
async function startReceive(code) {
	code = (code || "").trim();
	if (!code) return;
	if (code.length > 128) {
		ui.showError("receive", "口令码过长");
		return;
	}

	state.code = code;
	state.role = "receiver";

	ui.enterTransfer("receive");
	ui.setCardTitle("receive", "接收文件");
	ui.resetReceiveView();
	ui.setBusy("receive", true);

	try {
		await connectAndTransfer();
	} catch (err) {
		ui.showError("receive", err.message);
		ui.setBusy("receive", false);
	}
}

// ─── Core Transfer Logic ──────────────────────────────────────────────────
async function connectAndTransfer() {
	const relayURL = await getRelayURL();
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(relayURL);
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
			ws.send(JSON.stringify({ type: "join", room: state.code }));
		};

		ws.onmessage = (event) => {
			try {
				if (typeof event.data === "string") {
					const msg = JSON.parse(event.data);
					if (msg.type === "waiting") {
						pakeState = "waiting";
						if (state.role === "sender") {
							ui.setStatus("send", "等待接收方输入口令码…", "wait");
						}
					} else if (msg.type === "paired") {
						pakeState = "paired";
						enqueue(() => runPAKEInit());
					} else if (isSignalingMessage(msg)) {
						handleSignaling(msg);
					} else if (msg.type === "error") {
						rejectOnce(new Error(msg.msg || "Relay error"));
					} else if (msg.type === crocTransferPolicy.TRANSFER_ACK) {
						if (state.role === "sender") {
							ws.close();
						}
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
			ui.setStatus(
				state.role === "sender" ? "send" : "receive",
				"正在协商加密密钥…",
				"key",
			);
			const role = state.role === "sender" ? 0 : 1;
			await wasmCall("wasmInitPAKE", role, state.code);
			pakeState = "pake";
			if (state.role === "sender") {
				const result = await wasmCall("wasmGetPAKEMessage");
				ws.send(new TextEncoder().encode(result.message));
			}
		}

		// ─── Binary handler (PAKE payload or encrypted data) ───────────────
		async function handleBinary(data) {
			if (pakeState === "pake") {
				const msgStr = new TextDecoder().decode(data);
				const result = await wasmCall("wasmProcessPAKEMessage", msgStr);
				if (result.message) {
					ws.send(new TextEncoder().encode(result.message));
				}
				if (result.complete) {
					pakeState = "complete";
					const keyResult = await wasmCall("wasmGetSessionKey");
					state.sessionKey = keyResult.key;
					state.sessionKeyBytes = base64ToUint8Array(keyResult.key);

					if (state.role === "sender") {
						ui.setStatus("send", "密钥已建立，协商 P2P 连接…", "key");
						const transport = await setupSenderTransport(
							ws,
							(n) => {
								negotiator = n;
							},
							flushPendingSignaling,
						);
						ui.setStatus("send", "密钥已建立，开始发送文件…", "key");
						await sendAllFiles(transport);
						resolveOnce();
						if (
							crocTransferPolicy.shouldCloseSenderWebSocketImmediately(
								transport.mode,
							)
						) {
							ws.close();
						} else {
							ws.send(
								JSON.stringify({
									type: crocTransferPolicy.TRANSFER_DONE,
								}),
							);
						}
					} else {
						ui.setStatus("receive", "密钥已建立，协商 P2P 连接…", "key");
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
						state.isTextPayload = false;
						ui.resetReceiveView();
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
	if (state.textSend) {
		ui.setStatus("send", "正在发送文本…", "progress");
	} else {
		ui.setProgress("send", 0);
	}
	for (let i = 0; i < fileCount; i++) {
		await sendOneFile(transport, files[i], i, fileCount, batchTotalChunks);
	}
	ui.setStatus(
		"send",
		state.textSend
			? "文本发送完成！"
			: fileCount > 1
				? `${fileCount} 个文件发送完成！`
				: "文件发送完成！",
		"success",
	);
	ui.setProgress("send", 100, true);
	state.textSend = false;
}

async function sendOneFile(transport, file, fileIndex, fileCount, batchTotalChunks) {
	const chunkSize = effectiveChunkSize(transport);
	const totalChunks = Math.ceil(file.size / chunkSize);
	state.totalChunks = totalChunks;
	state.currentChunk = 0;
	const keyBytes = state.sessionKeyBytes;

	const metadataBytes = new TextEncoder().encode(
		JSON.stringify({
			name: file.name,
			size: file.size,
			chunks: totalChunks,
			fileIndex,
			fileCount,
			batchTotalChunks,
			...(state.textSend ? { kind: "text" } : {}),
		}),
	);
	const metadataEnc = await wasmCall("wasmEncrypt", keyBytes, null, metadataBytes);
	transport.send(metadataEnc);

	const updateSendProgress = (chunkInFile) => {
		if (state.textSend) return;
		const global = batchGlobalChunks(
			fileIndex,
			chunkInFile,
			state.files,
			transport,
		);
		ui.setStatus(
			"send",
			formatTransferProgress(
				"send",
				fileIndex,
				fileCount,
				file.name,
			),
			"progress",
		);
		ui.setProgress("send", progressPercent(global, batchTotalChunks));
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
	}
}

// ─── Receiver: File Reception ──────────────────────────────────────────────
async function finishCurrentFile() {
	const metadata = state.receivedMetadata;
	if (metadata.kind === "text") {
		const text = new TextDecoder().decode(state.merged);
		ui.showReceivedText(text);
	} else if (state.streaming) {
		await state.writable.close();
		state.writable = null;
	} else {
		const blob = new Blob([state.merged]);
		const url = URL.createObjectURL(blob);
		state.receivedFiles.push({ name: metadata.name, url });
	}

	if (state.fileIndex < state.fileCount - 1) {
		state.batchDoneChunks += metadata.chunks;
		resetForNextFile();
		return false;
	}

	if (state.streaming) {
		ui.setStatus(
			"receive",
			state.fileCount > 1
				? `已接收 ${state.fileCount} 个文件`
				: "文件已保存到磁盘！",
			"success",
		);
	} else if (metadata.kind === "text") {
		ui.setStatus("receive", "文本已接收", "success");
	} else {
		ui.setStatus(
			"receive",
			state.fileCount > 1
				? `已接收 ${state.fileCount} 个文件`
				: "文件接收完成！",
			"success",
		);
		ui.showDownloads(state.receivedFiles);
	}
	ui.setProgress("receive", 100, true);
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
		metadata = crocSecurity.validateMetadata(metadata);
		const fileIndex = metadata.fileIndex;
		const fileCount = metadata.fileCount;
		state.receivedMetadata = metadata;
		state.fileIndex = fileIndex;
		state.fileCount = fileCount;
		state.totalChunks = metadata.chunks;
		state.currentChunk = 0;
		state.batchTotalChunks =
			metadata.batchTotalChunks ?? metadata.chunks;

		const isText = metadata.kind === "text";
		state.isTextPayload = isText;
		state.streaming = false;
		state.writable = null;
		state.bytesWritten = 0;

		if (!isText && fileIndex === 0 && fileCount > 1 && window.showDirectoryPicker) {
			try {
				state.saveDir = await window.showDirectoryPicker();
			} catch (err) {
				if (err.name === "AbortError") {
					throw new Error("用户取消了保存位置选择");
				}
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
			} catch (err) {
				throw new Error(`无法写入文件 ${metadata.name}: ${err.message}`);
			}
		} else if (!isText && window.showSaveFilePicker) {
			try {
				state.fileHandle = await window.showSaveFilePicker({
					suggestedName: metadata.name,
				});
				state.writable = await state.fileHandle.createWritable();
				state.streaming = true;
			} catch (err) {
				if (err.name === "AbortError") {
					throw new Error("用户取消了保存位置选择");
				}
			}
		}
		if (!state.streaming) {
			if (metadata.size > crocSecurity.MAX_IN_MEMORY_RECEIVE_BYTES) {
				const limit = formatSize(crocSecurity.MAX_IN_MEMORY_RECEIVE_BYTES);
				if (window.showSaveFilePicker) {
					throw new Error(
						`文件超过 ${limit} 内存接收上限，请选择保存位置以流式写入`,
					);
				}
				throw new Error(
					`文件超过 ${limit} 内存接收上限，当前浏览器不支持流式保存`,
				);
			}
			state.merged = new Uint8Array(metadata.size);
			state.mergeOffset = 0;
		}

		if (isText) {
			ui.setCardTitle("receive", "接收文本");
			hideProgressBar("receive");
			ui.setStatus("receive", "正在接收文本…", "progress");
		} else {
			ui.showProgressBar("receive");
			updateReceiveProgressUI();
		}

		if (metadata.chunks === 0) {
			await finishCurrentFile();
		}
		return;
	}

	if (state.streaming) {
		state.bytesWritten += decrypted.length;
		if (state.bytesWritten > state.receivedMetadata.size) {
			throw new Error("Received data exceeds declared file size");
		}
		await state.writable.write(decrypted);
	} else {
		const nextOffset = state.mergeOffset + decrypted.length;
		if (nextOffset > state.receivedMetadata.size) {
			throw new Error("Received data exceeds declared file size");
		}
		state.merged.set(decrypted, state.mergeOffset);
		state.mergeOffset = nextOffset;
	}
	state.currentChunk++;

	updateReceiveProgressUI();

	if (state.currentChunk >= state.totalChunks) {
		await finishCurrentFile();
	}
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

// ─── UI-facing API ────────────────────────────────────────────────────────
// ui.js binds all DOM events to these. Session keys are never exposed.
function publicState() {
	return {
		role: state.role,
		sendMode: state.sendMode,
		files: state.files,
		transportMode: state.transportMode,
	};
}

window.croc = {
	setFiles(files) {
		state.sendMode = "file";
		state.files = files;
	},
	setSendMode(mode) {
		state.sendMode = mode;
	},
	startSend,
	startReceive,
	startStunPrecheck,
	MAX_TEXT_BYTES,
	get state() {
		return publicState();
	},
};
