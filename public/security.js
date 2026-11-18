// Security helpers for Croc-WASM (limits, filename sanitization, passcode generation).
// Loaded before app.js; exposed as window.crocSecurity for tests.
(function (global) {
	const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB per file
	const MAX_BATCH_BYTES = 5 * 1024 * 1024 * 1024; // 5 GiB per batch
	const MAX_IN_MEMORY_RECEIVE_BYTES = 256 * 1024 * 1024; // 256 MiB without streaming API
	const MAX_CHUNKS = 8192;
	const MAX_FILE_COUNT = 100;
	const MAX_FILENAME_LENGTH = 255;
	const CODE_LENGTH = 12;
	const CODE_CHARS =
		"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	const CODE_CHARS_LEN = CODE_CHARS.length;
	const ROOM_ID_DOMAIN = "croc-wasm/room/v1";
	const TRANSFER_ID_DOMAIN = "croc-wasm/transfer/v1";
	const SHARE_ID_RE = /^[0-9a-f]{32}$/;
	const METADATA_AAD_SEQ = 0xffffffff;
	const METADATA_FILE_INDEX = 0xffffffff;
	const MANIFEST_FILE_INDEX = 0xfffffffe;
	const WINDOWS_RESERVED = new Set([
		"CON", "PRN", "AUX", "NUL",
		"COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
		"LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
	]);

	async function deriveRoomId(code) {
		if (typeof code !== "string" || !code) {
			throw new Error("deriveRoomId: code required");
		}
		const data = new TextEncoder().encode(ROOM_ID_DOMAIN + code);
		const hash = await crypto.subtle.digest("SHA-256", data);
		return [...new Uint8Array(hash)]
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
	}

	// 32 hex chars from 16 random bytes. Independent of the passcode, so the
	// relay cannot link a staged file back to a room even if it logs both.
	function generateShareKey() {
		const buf = new Uint8Array(16);
		crypto.getRandomValues(buf);
		return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
	}

	function isSecureShareBase(url) {
		let parsed;
		try {
			parsed = new URL(url);
		} catch {
			return false;
		}
		if (parsed.protocol === "https:") {
			return true;
		}
		if (parsed.protocol !== "http:") {
			return false;
		}
		const host = parsed.hostname.toLowerCase();
		return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
	}

	// One-off command for downloading a staged file. No -L (curl forwards custom
	// headers across redirects), no -OJ (refuses to overwrite, wedges --retry).
	function shellQuote(value) {
		return `'${String(value).replace(/'/g, "'\\''")}'`;
	}

	function buildCurlCommand({ baseURL, shareId, shareKey, filename } = {}) {
		if (!SHARE_ID_RE.test(String(shareId))) {
			throw new Error("buildCurlCommand: invalid share id");
		}
		if (!SHARE_ID_RE.test(String(shareKey))) {
			throw new Error("buildCurlCommand: invalid share key");
		}
		if (typeof baseURL !== "string" || !baseURL.trim()) {
			throw new Error("buildCurlCommand: base URL required");
		}
		const base = baseURL.trim().replace(/\/+$/, "");
		if (!isSecureShareBase(base)) {
			throw new Error("buildCurlCommand: https base URL required");
		}
		const outName = shellQuote(sanitizeFilename(filename));
		return `curl -f --retry 5 --retry-delay 2 -H 'X-Share-Key: ${shareKey}' -o ${outName} '${base}/s/${shareId}'`;
	}

	async function deriveTransferId(sessionKeyBytes) {
		const prefix = new TextEncoder().encode(TRANSFER_ID_DOMAIN);
		const combined = new Uint8Array(prefix.length + sessionKeyBytes.length);
		combined.set(prefix, 0);
		combined.set(sessionKeyBytes, prefix.length);
		const hash = await crypto.subtle.digest("SHA-256", combined);
		return new Uint8Array(hash).slice(0, 16);
	}

	function encodeAAD(transferIdBytes, fileIndex, seq) {
		const aad = new Uint8Array(24);
		aad.set(transferIdBytes.slice(0, 16), 0);
		const view = new DataView(aad.buffer);
		view.setUint32(16, fileIndex >>> 0, false);
		view.setUint32(20, seq >>> 0, false);
		return aad;
	}

	function dedupeFilename(name, usedNames) {
		if (!usedNames.has(name)) {
			usedNames.add(name);
			return name;
		}
		const dot = name.lastIndexOf(".");
		const base = dot > 0 ? name.slice(0, dot) : name;
		const ext = dot > 0 ? name.slice(dot) : "";
		let n = 1;
		let candidate;
		do {
			candidate = `${base} (${n})${ext}`;
			n++;
		} while (usedNames.has(candidate));
		usedNames.add(candidate);
		return candidate;
	}

	function isInsecureRelayURL(url) {
		try {
			const parsed = new URL(url);
			if (parsed.protocol !== "ws:") return false;
			const host = parsed.hostname.toLowerCase();
			return host !== "localhost" && host !== "127.0.0.1" && host !== "::1";
		} catch {
			return false;
		}
	}

	function sanitizeFilename(name) {
		if (typeof name !== "string" || !name.trim()) {
			return "download";
		}
		// Strip path components (handles / and \).
		let base = name.split(/[/\\]/).pop() || "download";
		// Remove control characters and null bytes.
		base = base.replace(/\p{Cc}/gu, "");
		base = base.trim().replace(/[.\s]+$/g, "");
		if (!base || base === "." || base === "..") {
			return "download";
		}
		const upper = base.toUpperCase().replace(/\.+$/, "");
		if (WINDOWS_RESERVED.has(upper)) {
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

	function normalizeKind(kind) {
		if (kind === undefined || kind === null || kind === "" || kind === "file") {
			return "file";
		}
		if (kind === "text") return "text";
		throw new Error(`Invalid manifest: unsupported kind ${String(kind)}`);
	}

	function validateManifest(manifest) {
		if (!manifest || typeof manifest !== "object") {
			throw new Error("Invalid manifest: expected object");
		}
		const fileCount = validatePositiveInt(
			manifest.fileCount,
			"fileCount",
			MAX_FILE_COUNT,
		);
		if (fileCount < 1) {
			throw new Error("Invalid manifest: fileCount must be positive");
		}
		const totalBytes = validatePositiveInt(
			manifest.totalBytes,
			"totalBytes",
			MAX_BATCH_BYTES,
		);
		if (!Array.isArray(manifest.files) || manifest.files.length !== fileCount) {
			throw new Error("Invalid manifest: files must match fileCount");
		}
		const seen = new Set();
		let sum = 0;
		const files = manifest.files.map((entry) => {
			if (!entry || typeof entry !== "object") {
				throw new Error("Invalid manifest: bad file entry");
			}
			const index = validatePositiveInt(
				entry.index,
				"fileIndex",
				fileCount - 1,
			);
			if (seen.has(index)) {
				throw new Error(`Invalid manifest: duplicate file index ${index}`);
			}
			seen.add(index);
			const size = validatePositiveInt(entry.size, "size", MAX_FILE_BYTES);
			const chunks = validatePositiveInt(entry.chunks, "chunks", MAX_CHUNKS);
			if (size > 0 && chunks === 0) {
				throw new Error("Invalid manifest: chunks must be > 0 when size > 0");
			}
			if (size === 0 && chunks !== 0) {
				throw new Error("Invalid manifest: empty file must have 0 chunks");
			}
			sum += size;
			return {
				index,
				name: sanitizeFilename(entry.name),
				size,
				chunks,
				kind: normalizeKind(entry.kind),
			};
		});
		if (sum !== totalBytes) {
			throw new Error("Invalid manifest: totalBytes does not match files");
		}
		files.sort((a, b) => a.index - b.index);
		return { fileCount, totalBytes, files };
	}

	function createManifestTracker(manifest) {
		const normalized = validateManifest(manifest);
		const byIndex = new Map(normalized.files.map((f) => [f.index, f]));
		const claimed = new Set();
		const done = new Set();

		function claim(metadata) {
			if (!metadata || typeof metadata !== "object") {
				throw new Error("Manifest check: expected metadata object");
			}
			const index = metadata.fileIndex;
			const entry = byIndex.get(index);
			if (!entry) {
				throw new Error(`Manifest check: file index ${index} is not in the manifest`);
			}
			if (claimed.has(index)) {
				throw new Error(`Manifest check: duplicate file index ${index}`);
			}
			if (metadata.fileCount !== normalized.fileCount) {
				throw new Error("Manifest check: fileCount does not match manifest");
			}
			if (
				metadata.name !== entry.name ||
				metadata.size !== entry.size ||
				metadata.chunks !== entry.chunks ||
				normalizeKind(metadata.kind) !== entry.kind
			) {
				throw new Error(`Manifest check: file ${index} does not match manifest`);
			}
			claimed.add(index);
		}

		function finish(index) {
			if (!claimed.has(index)) {
				throw new Error(
					`Manifest check: file ${index} finished before metadata`,
				);
			}
			done.add(index);
		}

		return {
			manifest: normalized,
			total: normalized.fileCount,
			claim,
			finish,
			complete: () => done.size === normalized.fileCount,
			receivedCount: () => done.size,
			missing: () =>
				normalized.files
					.filter((f) => !done.has(f.index))
					.map((f) => f.index),
		};
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
		MAX_IN_MEMORY_RECEIVE_BYTES,
		MAX_CHUNKS,
		MAX_FILE_COUNT,
		MAX_FILENAME_LENGTH,
		CODE_LENGTH,
		sanitizeFilename,
		validateMetadata,
		validateManifest,
		createManifestTracker,
		validateSendFiles,
		generateSecureCode,
		deriveRelayURL,
		deriveRoomId,
		deriveTransferId,
		generateShareKey,
		buildCurlCommand,
		encodeAAD,
		dedupeFilename,
		isInsecureRelayURL,
		ROOM_ID_DOMAIN,
		TRANSFER_ID_DOMAIN,
		METADATA_AAD_SEQ,
		METADATA_FILE_INDEX,
		MANIFEST_FILE_INDEX,
	};
})(typeof window === "undefined" ? globalThis : window);
