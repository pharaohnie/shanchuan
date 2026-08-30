// Web Worker for Croc-WASM.
// Hosts the Go WASM module so PAKE + AES-GCM run off the main thread, keeping
// the UI responsive during large transfers. All calls are async (postMessage);
// Uint8Array results are transferred back zero-copy.
importScripts("/wasm_exec.js");

const WASM_FUNCTIONS = new Set([
	"wasmInitPAKE",
	"wasmGetPAKEMessage",
	"wasmProcessPAKEMessage",
	"wasmGetSessionKey",
	"wasmEncrypt",
	"wasmDecrypt",
]);

let goInstance = null;
let wasmReady = false;
let wasmLoading = null;
let wasmQueue = Promise.resolve();

const WASM_LOAD_TIMEOUT_MS = 30000;

async function waitForWasmExports() {
	const deadline = Date.now() + WASM_LOAD_TIMEOUT_MS;
	while (typeof self.wasmEncrypt !== "function") {
		if (Date.now() > deadline) {
			throw new Error(
				"WASM module failed to register exports within 30s",
			);
		}
		await new Promise((r) => setTimeout(r, 2));
	}
}

async function ensureWasm() {
	if (wasmReady) return;
	if (!wasmLoading) {
		wasmLoading = (async () => {
			try {
				goInstance = new Go();
				const resp = await fetch("/croc.wasm");
				if (!resp.ok) {
					throw new Error(
						`Failed to fetch croc.wasm: HTTP ${resp.status}`,
					);
				}
				const inst = await WebAssembly.instantiateStreaming(
					resp,
					goInstance.importObject,
				);
				goInstance.run(inst.instance);
				await waitForWasmExports();
				wasmReady = true;
			} catch (err) {
				wasmLoading = null;
				throw err;
			}
		})();
	}
	await wasmLoading;
}

async function handleWasmMessage({ id, fn, args }) {
	if (!WASM_FUNCTIONS.has(fn)) {
		throw new Error(`Unknown WASM function: ${fn}`);
	}
	await ensureWasm();
	const fnRef = self[fn];
	if (typeof fnRef !== "function") {
		throw new Error(`WASM export not available: ${fn}`);
	}
	const result = fnRef(...args);
	const transfer = result instanceof Uint8Array ? [result.buffer] : [];
	self.postMessage({ id, result }, transfer);
}

self.onmessage = (e) => {
	const { id, fn, args } = e.data;
	wasmQueue = wasmQueue.then(
		() => handleWasmMessage({ id, fn, args }),
		() => handleWasmMessage({ id, fn, args }),
	).catch((err) => {
		self.postMessage({ id, error: err.message });
	});
};

ensureWasm();
