// Web Worker for Croc-WASM.
// Hosts the Go WASM module so PAKE + AES-GCM run off the main thread, keeping
// the UI responsive during large transfers. All calls are async (postMessage);
// Uint8Array results are transferred back zero-copy.
importScripts("/wasm_exec.js");

let goInstance = null;
let wasmReady = false;
let wasmLoading = null;

// Load + instantiate the Go WASM module, then wait for main() to finish
// registering exported functions (it ends in select{} and never returns).
async function ensureWasm() {
	if (wasmReady) return;
	if (!wasmLoading) {
		wasmLoading = (async () => {
			goInstance = new Go();
			const resp = await fetch("/croc.wasm");
			const inst = await WebAssembly.instantiateStreaming(
				resp,
				goInstance.importObject,
			);
			goInstance.run(inst.instance); // instantiateStreaming returns {module, instance}; run needs the instance
		})();
	}
	await wasmLoading;
	// Poll until Go main() has registered the exported functions on self.
	while (typeof self.wasmEncrypt !== "function") {
		await new Promise((r) => setTimeout(r, 2));
	}
	wasmReady = true;
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
