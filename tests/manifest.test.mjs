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

assert.equal(sec.MANIFEST_FILE_INDEX, 0xfffffffe);

function validManifest() {
	return {
		fileCount: 2,
		totalBytes: 5,
		files: [
			{ index: 0, name: "a.txt", size: 3, chunks: 1 },
			{ index: 1, name: "b.bin", size: 2, chunks: 1 },
		],
	};
}

function meta(index, name, size) {
	return {
		name,
		size,
		chunks: 1,
		fileIndex: index,
		fileCount: 2,
		batchTotalChunks: 2,
	};
}

test("validateManifest accepts a complete manifest", () => {
	const m = sec.validateManifest(validManifest());
	assert.equal(m.fileCount, 2);
	assert.equal(m.totalBytes, 5);
	assert.deepEqual(
		m.files.map((f) => f.index),
		[0, 1],
	);
});

test("validateManifest rejects duplicate and out-of-range indexes", () => {
	const dup = validManifest();
	dup.files[1].index = 0;
	assert.throws(() => sec.validateManifest(dup), /duplicate file index/);

	const range = validManifest();
	range.files[1].index = 2;
	assert.throws(() => sec.validateManifest(range), /fileIndex exceeds/);
});

test("validateManifest rejects count and byte total mismatches", () => {
	const count = validManifest();
	count.fileCount = 3;
	assert.throws(() => sec.validateManifest(count), /files must match fileCount/);

	const bytes = validManifest();
	bytes.totalBytes = 4;
	assert.throws(() => sec.validateManifest(bytes), /totalBytes does not match/);
});

test("tracker marks complete only after every manifest file finishes", () => {
	const tracker = sec.createManifestTracker(validManifest());
	// A malicious relay only forwards the last file.
	tracker.claim(meta(1, "b.bin", 2));
	tracker.finish(1);
	assert.equal(tracker.complete(), false);
	assert.equal(tracker.receivedCount(), 1);
	assert.deepEqual(tracker.missing(), [0]);

	tracker.claim(meta(0, "a.txt", 3));
	tracker.finish(0);
	assert.equal(tracker.complete(), true);
	assert.deepEqual(tracker.missing(), []);
});

test("tracker rejects duplicate file indexes", () => {
	const tracker = sec.createManifestTracker(validManifest());
	tracker.claim(meta(0, "a.txt", 3));
	assert.throws(
		() => tracker.claim(meta(0, "a.txt", 3)),
		/duplicate file index/,
	);
});

test("tracker rejects indexes outside the manifest", () => {
	const tracker = sec.createManifestTracker(validManifest());
	assert.throws(
		() => tracker.claim(meta(2, "c.bin", 1)),
		/is not in the manifest/,
	);
});

test("tracker rejects metadata that does not match the manifest", () => {
	const tracker = sec.createManifestTracker(validManifest());
	assert.throws(
		() => tracker.claim(meta(0, "a.txt", 4)),
		/does not match manifest/,
	);
	assert.throws(
		() => tracker.claim(meta(0, "evil.txt", 3)),
		/does not match manifest/,
	);
});

test("legacy v1 metadata still validates without a manifest", () => {
	const legacy = sec.validateMetadata({
		name: "legacy.txt",
		size: 1,
		chunks: 1,
		fileIndex: 0,
		fileCount: 1,
	});
	assert.equal(legacy.name, "legacy.txt");
	assert.equal(legacy.fileIndex, 0);
});
