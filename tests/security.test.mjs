import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

function loadSecurity() {
	const code = readFileSync(new URL("../public/security.js", import.meta.url), "utf8");
	const ctx = { crypto: globalThis.crypto, TextEncoder, URL, window: {} };
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

test("MAX_IN_MEMORY_RECEIVE_BYTES is defined and below MAX_FILE_BYTES", () => {
	assert.ok(sec.MAX_IN_MEMORY_RECEIVE_BYTES > 0);
	assert.ok(sec.MAX_IN_MEMORY_RECEIVE_BYTES < sec.MAX_FILE_BYTES);
});

test("deriveRoomId returns stable 64-char hex under 128-char join limit", async () => {
	const code = "Ax3k9mN2pQ";
	const a = await sec.deriveRoomId(code);
	const b = await sec.deriveRoomId(code);
	assert.equal(a, b);
	assert.match(a, /^[0-9a-f]{64}$/);
	assert.ok(a.length <= 128);

	const other = await sec.deriveRoomId("DifferentCode");
	assert.notEqual(a, other);
});

test("encodeAAD round-trip layout", () => {
	const transferId = new Uint8Array(16).fill(0xab);
	const aad = sec.encodeAAD(transferId, 2, 42);
	assert.equal(aad.length, 24);
	assert.equal(aad[0], 0xab);
	assert.equal(new DataView(aad.buffer).getUint32(16, false), 2);
	assert.equal(new DataView(aad.buffer).getUint32(20, false), 42);
});

test("sanitizeFilename preserves double dots in basename", () => {
	assert.equal(sec.sanitizeFilename("报告..2026.pdf"), "报告..2026.pdf");
});

test("dedupeFilename avoids collisions", () => {
	const used = new Set(["file.txt"]);
	assert.equal(sec.dedupeFilename("file.txt", used), "file (1).txt");
	assert.equal(sec.dedupeFilename("file.txt", used), "file (2).txt");
});

test("isInsecureRelayURL blocks public ws", () => {
	assert.equal(sec.isInsecureRelayURL("ws://example.com/ws"), true);
	assert.equal(sec.isInsecureRelayURL("ws://localhost:8154/ws"), false);
	assert.equal(sec.isInsecureRelayURL("wss://example.com/ws"), false);
});
