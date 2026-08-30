// Debug logging (off by default). Enable: localStorage.setItem("croc-debug", "1")
(function (global) {
	function enabled() {
		try {
			return localStorage.getItem("croc-debug") === "1";
		} catch {
			return false;
		}
	}

	function prefix(role) {
		return `[闪传${role ? `:${role}` : ""}]`;
	}

	function log(role, ...args) {
		if (!enabled()) return;
		console.log(prefix(role), ...args);
	}

	function warn(role, ...args) {
		if (!enabled()) return;
		console.warn(prefix(role), ...args);
	}

	function error(role, ...args) {
		if (!enabled()) return;
		console.error(prefix(role), ...args);
	}

	function hexPreview(bytes, n = 8) {
		if (!bytes || !bytes.length) return "(empty)";
		const slice = bytes.slice(0, n);
		return (
			[...slice].map((b) => b.toString(16).padStart(2, "0")).join("") +
			(bytes.length > n ? "…" : "")
		);
	}

	global.crocLog = { log, warn, error, hexPreview, enabled };
})(typeof window !== "undefined" ? window : globalThis);
