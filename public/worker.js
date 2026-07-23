// Web Worker for Croc-WASM.
// Hosts the Go WASM module so PAKE + AES-GCM run off the main thread, keeping
// the UI responsive during large transfers. All calls are async (postMessage);
// Uint8Array results are transferred back zero-copy.
importScripts("/wasm_exec.js");

let goInstance = null;
let wasmReady = false;
let wasmLoading = null;

const WASM_LOAD_TIMEOUT_MS = 30000;

// Poll until Go main() has registered the exported functions on self.
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

// Load + instantiate the Go WASM module, then wait for main() to finish
// registering exported functions (it ends in select{} and never returns).
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
				goInstance.run(inst.instance); // instantiateStreaming returns {module, instance}; run needs the instance
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

self.onmessage = async (e) => {
	const { id, fn, args } = e.data;
	try {
		await ensureWasm();
		const fnRef = self[fn];
		if (typeof fnRef !== "function") {
			throw new Error(`Unknown WASM function: ${fn}`);
		}
		const result = fnRef(...args);
		// Transfer Uint8Array results back zero-copy; everything else is cloned.
		const transfer = result instanceof Uint8Array ? [result.buffer] : [];
		self.postMessage({ id, result }, transfer);
	} catch (err) {
		self.postMessage({ id, error: err.message });
	}
};

// Pre-load WASM as soon as the worker starts, so it's ready before first use.
ensureWasm();
