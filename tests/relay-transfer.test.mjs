import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

function loadTransferPolicy() {
	const code = readFileSync(
		new URL("../public/transfer-policy.js", import.meta.url),
		"utf8",
	);
	const ctx = { window: {} };
	vm.runInNewContext(code, ctx);
	return ctx.window.crocTransferPolicy;
}

const policy = loadTransferPolicy();

test("P2P mode closes sender WebSocket immediately after send", () => {
	assert.equal(policy.shouldCloseSenderWebSocketImmediately("p2p"), true);
});

test("relay mode defers sender WebSocket close until receiver ack", () => {
	assert.equal(policy.shouldCloseSenderWebSocketImmediately("relay"), false);
});

test("relay shutdown uses transfer-done and transfer-ack messages", () => {
	assert.equal(policy.TRANSFER_DONE, "transfer-done");
	assert.equal(policy.TRANSFER_ACK, "transfer-ack");
});

test("relay shutdown sequence: sender signals done, receiver acks before close", () => {
	const events = [];
	const sender = {
		mode: "relay",
		sendDone() {
			if (policy.shouldCloseSenderWebSocketImmediately(this.mode)) {
				events.push("sender:close");
				return;
			}
			events.push(`sender:${policy.TRANSFER_DONE}`);
		},
		onAck() {
			events.push("sender:close");
		},
	};
	const receiver = {
		mode: "relay",
		onBatchComplete() {
			events.push(`receiver:${policy.TRANSFER_ACK}`);
			events.push("receiver:close");
		},
	};

	sender.sendDone();
	receiver.onBatchComplete();
	sender.onAck();

	assert.deepEqual(events, [
		"sender:transfer-done",
		"receiver:transfer-ack",
		"receiver:close",
		"sender:close",
	]);
});
