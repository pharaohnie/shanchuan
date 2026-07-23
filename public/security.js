// Security helpers for Croc-WASM (limits, filename sanitization, passcode generation).
// Loaded before app.js; exposed as window.crocSecurity for tests.
(function (global) {
	const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB per file
	const MAX_BATCH_BYTES = 5 * 1024 * 1024 * 1024; // 5 GiB per batch
	const MAX_CHUNKS = 8192;
	const MAX_FILE_COUNT = 100;
	const MAX_FILENAME_LENGTH = 255;
	const CODE_LENGTH = 10;
	const CODE_CHARS =
		"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	const CODE_CHARS_LEN = CODE_CHARS.length;

	function sanitizeFilename(name) {
		if (typeof name !== "string" || !name.trim()) {
			return "download";
		}
		// Strip path components (handles / and \).
		let base = name.split(/[/\\]/).pop() || "download";
		// Remove control characters and null bytes.
		base = base.replace(/[\x00-\x1f\x7f]/g, "");
		// Collapse dangerous sequences.
		base = base.replace(/\.\.+/g, ".");
		base = base.trim();
		if (!base || base === "." || base === "..") {
			return "download";
		}
		if (base.length > MAX_FILENAME_LENGTH) {
			base = base.slice(0, MAX_FILENAME_LENGTH);
		}
		return base;
	}

	function validatePositiveInt(value, field, max) {
		if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
			throw new Error(`Invalid metadata: ${field} must be a non-negative integer`);
		}
		if (value > max) {
			throw new Error(`Invalid metadata: ${field} exceeds limit (${max})`);
		}
		return value;
	}

	function validateMetadata(metadata) {
		if (!metadata || typeof metadata !== "object") {
			throw new Error("Invalid metadata: expected object");
		}
		const fileCount = validatePositiveInt(
			metadata.fileCount ?? 1,
			"fileCount",
			MAX_FILE_COUNT,
		);
		const fileIndex = validatePositiveInt(
			metadata.fileIndex ?? 0,
			"fileIndex",
			MAX_FILE_COUNT - 1,
		);
		if (fileIndex >= fileCount) {
			throw new Error("Invalid metadata: fileIndex out of range");
		}
		const chunks = validatePositiveInt(metadata.chunks, "chunks", MAX_CHUNKS);
		const size = validatePositiveInt(metadata.size, "size", MAX_FILE_BYTES);
		const batchTotalChunks = validatePositiveInt(
			metadata.batchTotalChunks ?? chunks,
			"batchTotalChunks",
			MAX_CHUNKS * MAX_FILE_COUNT,
		);
		if (size > 0 && chunks === 0) {
			throw new Error("Invalid metadata: chunks must be > 0 when size > 0");
		}
		const name = sanitizeFilename(metadata.name);
		return { ...metadata, name, fileCount, fileIndex, chunks, size, batchTotalChunks };
	}

	function validateSendFiles(files) {
		if (!files.length) {
			throw new Error("No files selected");
		}
		if (files.length > MAX_FILE_COUNT) {
			throw new Error(`Too many files (max ${MAX_FILE_COUNT})`);
		}
		let totalBytes = 0;
		for (const file of files) {
			if (file.size > MAX_FILE_BYTES) {
				throw new Error(
					`File "${file.name}" exceeds ${formatBytes(MAX_FILE_BYTES)} limit`,
				);
			}
			totalBytes += file.size;
			if (totalBytes > MAX_BATCH_BYTES) {
				throw new Error(
					`Total batch size exceeds ${formatBytes(MAX_BATCH_BYTES)} limit`,
				);
			}
		}
	}

	function formatBytes(bytes) {
		if (bytes >= 1024 * 1024 * 1024) {
			return `${bytes / (1024 * 1024 * 1024)} GiB`;
		}
		return `${bytes / (1024 * 1024)} MiB`;
	}

	// Unbiased random index into CODE_CHARS via rejection sampling.
	function secureCodeChar() {
		const limit = Math.floor(256 / CODE_CHARS_LEN) * CODE_CHARS_LEN;
		const buf = new Uint8Array(1);
		do {
			crypto.getRandomValues(buf);
		} while (buf[0] >= limit);
		return CODE_CHARS[buf[0] % CODE_CHARS_LEN];
	}

	function generateSecureCode() {
		let code = "";
		for (let i = 0; i < CODE_LENGTH; i++) {
			code += secureCodeChar();
		}
		return code;
	}

	function deriveRelayURL(configuredUrl) {
		if (configuredUrl && typeof configuredUrl === "string" && configuredUrl.trim()) {
			return configuredUrl.trim();
		}
		const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
		return `${proto}//${window.location.host}/ws`;
	}

	global.crocSecurity = {
		MAX_FILE_BYTES,
		MAX_BATCH_BYTES,
		MAX_CHUNKS,
		MAX_FILE_COUNT,
		MAX_FILENAME_LENGTH,
		CODE_LENGTH,
		sanitizeFilename,
		validateMetadata,
		validateSendFiles,
		generateSecureCode,
		deriveRelayURL,
	};
})(typeof window !== "undefined" ? window : globalThis);
