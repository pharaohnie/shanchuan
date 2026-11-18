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
const SHARE_ID = "0123456789abcdef0123456789abcdef";
const SHARE_KEY = "fedcba9876543210fedcba9876543210";

test("deriveShareKey is stable and domain separated", async () => {
	const a = await sec.deriveShareKey("Zx9PassCode");
	const b = await sec.deriveShareKey("Zx9PassCode");
	assert.equal(a, b);
	assert.match(a, /^[0-9a-f]{32}$/);

	const room = await sec.deriveRoomId("Zx9PassCode");
	assert.notEqual(a, room.slice(0, 32));
	assert.equal(sec.SHARE_KEY_DOMAIN, "croc-wasm/share/v1");
});

test("deriveShareKey rejects empty codes", async () => {
	await assert.rejects(() => sec.deriveShareKey(""), /code required/);
	await assert.rejects(() => sec.deriveShareKey(undefined), /code required/);
});

test("buildCurlCommand produces a single-shot, retry-safe command", () => {
	const cmd = sec.buildCurlCommand({
		baseURL: "https://share.example.com",
		shareId: SHARE_ID,
		shareKey: SHARE_KEY,
	});
	assert.ok(cmd.includes("-f "), "must fail on HTTP errors");
	assert.ok(cmd.includes("--retry 5"), "must retry 503 while uploading");
	assert.ok(cmd.includes("--retry-delay 2"));
	assert.ok(cmd.includes(`X-Share-Key: ${SHARE_KEY}`));
	assert.ok(cmd.includes(`'https://share.example.com/s/${SHARE_ID}'`));
	assert.ok(cmd.includes("-o 'download'"), "falls back when no filename is known");
	assert.ok(!cmd.includes("-L"), "redirects would leak the key header");
	assert.ok(!cmd.includes("-J"), "-J refuses to overwrite and wedges --retry");
	assert.ok(!cmd.includes("--retry-all-errors"), "needs curl >= 7.71");
});

test("buildCurlCommand saves under the uploaded filename", () => {
	const base = { baseURL: "https://share.example.com", shareId: SHARE_ID, shareKey: SHARE_KEY };
	assert.ok(sec.buildCurlCommand({ ...base, filename: "报告 2024.pdf" }).includes("-o '报告 2024.pdf'"));
	assert.ok(sec.buildCurlCommand({ ...base, filename: "it's.txt" }).includes(`-o 'it'\\''s.txt'`));
	assert.ok(sec.buildCurlCommand({ ...base, filename: "../../etc/passwd" }).includes("-o 'passwd'"));
	assert.ok(sec.buildCurlCommand({ ...base, filename: "a$(date)b.txt" }).includes("-o 'a$(date)b.txt'"), "single quotes keep $() literal");
	assert.ok(sec.buildCurlCommand({ ...base, filename: "bad\u0000name\u001b.txt" }).includes("-o 'badname.txt'"));
});

test("buildCurlCommand trims trailing slashes", () => {
	const cmd = sec.buildCurlCommand({
		baseURL: "https://share.example.com/base/",
		shareId: SHARE_ID,
		shareKey: SHARE_KEY,
	});
	assert.ok(cmd.includes(`'https://share.example.com/base/s/${SHARE_ID}'`));
});

test("buildCurlCommand validates ids and keys", () => {
	const base = { baseURL: "https://share.example.com", shareId: SHARE_ID, shareKey: SHARE_KEY };
	assert.throws(() => sec.buildCurlCommand({ ...base, shareId: "abc" }), /invalid share id/);
	assert.throws(() => sec.buildCurlCommand({ ...base, shareId: SHARE_ID.toUpperCase() }), /invalid share id/);
	assert.throws(() => sec.buildCurlCommand({ ...base, shareKey: "../etc" }), /invalid share key/);
	assert.throws(() => sec.buildCurlCommand(), /invalid share id/);
});

test("buildCurlCommand requires https unless localhost", () => {
	const args = { shareId: SHARE_ID, shareKey: SHARE_KEY };
	assert.throws(() => sec.buildCurlCommand({ ...args, baseURL: "http://share.example.com" }), /https/);
	assert.throws(() => sec.buildCurlCommand({ ...args, baseURL: "ftp://share.example.com" }), /https/);
	assert.throws(() => sec.buildCurlCommand({ ...args, baseURL: "" }), /base URL required/);
	assert.doesNotThrow(() => sec.buildCurlCommand({ ...args, baseURL: "http://localhost:8154" }));
	assert.doesNotThrow(() => sec.buildCurlCommand({ ...args, baseURL: "http://127.0.0.1:8154" }));
});
