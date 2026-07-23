import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

function loadSecurity() {
	const code = readFileSync(new URL("../public/security.js", import.meta.url), "utf8");
	const ctx = { crypto: globalThis.crypto, window: {} };
	vm.runInNewContext(code, ctx);
	return ctx.window.crocSecurity;
}

const sec = loadSecurity();

test("sanitizeFilename strips path traversal", () => {
	assert.equal(sec.sanitizeFilename("../../etc/passwd"), "passwd");
	assert.equal(sec.sanitizeFilename("foo/bar.txt"), "bar.txt");
	assert.equal(sec.sanitizeFilename(".."), "download");
	assert.equal(sec.sanitizeFilename(""), "download");
});

test("validateMetadata rejects oversized size", () => {
	assert.throws(
		() => sec.validateMetadata({ name: "a", size: sec.MAX_FILE_BYTES + 1, chunks: 1 }),
		/size exceeds/,
	);
});

test("validateMetadata rejects excessive chunks", () => {
	assert.throws(
		() =>
			sec.validateMetadata({
				name: "a",
				size: 100,
				chunks: sec.MAX_CHUNKS + 1,
			}),
		/chunks exceeds/,
	);
});

test("validateMetadata accepts valid payload", () => {
	const m = sec.validateMetadata({
		name: "../secret.txt",
		size: 1024,
		chunks: 4,
		fileIndex: 0,
		fileCount: 1,
		batchTotalChunks: 4,
	});
	assert.equal(m.name, "secret.txt");
	assert.equal(m.size, 1024);
});

test("validateSendFiles enforces per-file limit", () => {
	const big = { name: "a", size: sec.MAX_FILE_BYTES + 1 };
	assert.throws(() => sec.validateSendFiles([big]), /exceeds/);
});

test("generateSecureCode length and charset", () => {
	const code = sec.generateSecureCode();
	assert.equal(code.length, sec.CODE_LENGTH);
	assert.match(code, /^[A-Za-z0-9]+$/);
});
