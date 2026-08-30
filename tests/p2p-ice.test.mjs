import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

function loadP2pHelpers() {
	const code = readFileSync(
		new URL("../public/p2p.js", import.meta.url),
		"utf8",
	);
	const ctx = {
		RTCPeerConnection: class {},
		P2pTransport: class {},
		crocLog: { log() {} },
	};
	vm.runInNewContext(code, ctx);
	return ctx;
}

test("setIceServers accepts config from API shape", () => {
	const ctx = loadP2pHelpers();
	ctx.setIceServers([
		{ urls: "stun:stun.cloudflare.com:3478" },
		{
			urls: "turn:turn.sc.bjedu.pro:3478",
			username: "shanchuan",
			credential: "secret",
		},
	]);
	const servers = ctx.getIceServers();
	assert.equal(servers.length, 2);
	assert.equal(servers[1].username, "shanchuan");
});

test("ice precheck passes on relay when TURN configured", () => {
	const ctx = loadP2pHelpers();
	ctx.setIceServers([
		{ urls: "stun:stun.cloudflare.com:3478" },
		{ urls: "turn:turn.example.com:3478", username: "u", credential: "p" },
	]);
	const types = new Set(["host", "relay"]);
	assert.equal(ctx.icePrecheckPassed(types), true);
});

test("ice precheck fails on relay without TURN configured", () => {
	const ctx = loadP2pHelpers();
	ctx.setIceServers([{ urls: "stun:stun.cloudflare.com:3478" }]);
	const types = new Set(["host", "relay"]);
	assert.equal(ctx.icePrecheckPassed(types), false);
});
