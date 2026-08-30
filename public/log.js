// Debug logging (off by default). Enable only: ?debug=1 in page URL
(function (global) {
	const nativeConsole = {
		log: console.log.bind(console),
		warn: console.warn.bind(console),
		error: console.error.bind(console),
		debug: (console.debug || console.log).bind(console),
		info: (console.info || console.log).bind(console),
	};

	function noop() {}

	function enabled() {
		try {
			if (typeof location === "undefined") return false;
			const qs = new URLSearchParams(location.search);
			if (qs.has("debug")) {
				// ?debug=0 clears any legacy persisted flag from older builds
				if (qs.get("debug") === "0" && typeof localStorage !== "undefined") {
					localStorage.removeItem("croc-debug");
				}
				return qs.get("debug") === "1";
			}
			return false;
		} catch {
			return false;
		}
	}

	function applyConsoleSilence() {
		if (enabled()) {
			console.log = nativeConsole.log;
			console.warn = nativeConsole.warn;
			console.error = nativeConsole.error;
			console.debug = nativeConsole.debug;
			console.info = nativeConsole.info;
		} else {
			console.log = noop;
			console.warn = noop;
			console.error = noop;
			console.debug = noop;
			console.info = noop;
		}
	}

	function prefix(role) {
		return `[闪传${role ? `:${role}` : ""}]`;
	}

	function log(role, ...args) {
		if (!enabled()) return;
		nativeConsole.log(prefix(role), ...args);
	}

	function warn(role, ...args) {
		if (!enabled()) return;
		nativeConsole.warn(prefix(role), ...args);
	}

	function error(role, ...args) {
		if (!enabled()) return;
		nativeConsole.error(prefix(role), ...args);
	}

	function hexPreview(bytes, n = 8) {
		if (!bytes || !bytes.length) return "(empty)";
		const slice = bytes.slice(0, n);
		return (
			[...slice].map((b) => b.toString(16).padStart(2, "0")).join("") +
			(bytes.length > n ? "…" : "")
		);
	}

	applyConsoleSilence();

	global.crocLog = { log, warn, error, hexPreview, enabled };
})(typeof window !== "undefined" ? window : globalThis);
