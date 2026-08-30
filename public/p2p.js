// WebRTC P2P negotiation: ICE servers from /api/config, offer/answer/ICE via WebSocket signaling.

const DEFAULT_ICE_SERVERS = [{ urls: "stun:stun.cloudflare.com:3478" }];
const P2P_CONNECT_TIMEOUT_MS = 15000;
const P2P_CONNECT_TIMEOUT_WITH_TURN_MS = 30000;
const STUN_CHECK_TIMEOUT_MS = 5000;

let iceServers = DEFAULT_ICE_SERVERS.slice();
let stunCheckPromise = null;

function normalizeIceServer(entry) {
	if (!entry || !entry.urls) return null;
	const normalized = { urls: entry.urls };
	if (entry.username) normalized.username = entry.username;
	if (entry.credential) normalized.credential = entry.credential;
	return normalized;
}

function setIceServers(servers) {
	if (!Array.isArray(servers) || servers.length === 0) return;
	const next = servers.map(normalizeIceServer).filter(Boolean);
	if (next.length === 0) return;
	iceServers = next;
	stunCheckPromise = null;
}

function getIceServers() {
	return iceServers.slice();
}

function hasTurnConfigured() {
	for (const s of iceServers) {
		const urls =
			typeof s.urls === "string"
				? [s.urls]
				: Array.isArray(s.urls)
					? s.urls
					: [];
		for (const u of urls) {
			if (u.startsWith("turn:") || u.startsWith("turns:")) return true;
		}
	}
	return false;
}

function p2pConnectTimeoutMs() {
	return hasTurnConfigured()
		? P2P_CONNECT_TIMEOUT_WITH_TURN_MS
		: P2P_CONNECT_TIMEOUT_MS;
}

function primaryStunLabel() {
	for (const s of iceServers) {
		const urls =
			typeof s.urls === "string"
				? [s.urls]
				: Array.isArray(s.urls)
					? s.urls
					: [];
		for (const u of urls) {
			if (u.startsWith("stun:")) return u.slice("stun:".length);
		}
	}
	return "stun.cloudflare.com:3478";
}

function icePrecheckPassed(candidateTypes) {
	if (candidateTypes.has("srflx")) return true;
	if (candidateTypes.has("relay") && hasTurnConfigured()) return true;
	return false;
}

function candidateTypeFromLine(line) {
	const m = line.match(/\btyp (\w+)/);
	return m ? m[1] : "unknown";
}

// Probe ICE gathering: ok when srflx appears, or relay when TURN is configured.
function checkStunConnectivity() {
	if (stunCheckPromise) return stunCheckPromise;

	stunCheckPromise = (async () => {
		const started = Date.now();
		const candidateTypes = new Set();
		const pc = new RTCPeerConnection({ iceServers });
		pc.createDataChannel("stun-probe");

		return new Promise((resolve) => {
			let done = false;
			const finish = (ok, error) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				pc.close();
				resolve({
					ok,
					server: primaryStunLabel(),
					elapsedMs: Date.now() - started,
					candidateTypes: [...candidateTypes],
					error: error || undefined,
				});
			};

			const timer = setTimeout(
				() => finish(false, "timeout"),
				STUN_CHECK_TIMEOUT_MS,
			);

			pc.onicecandidate = (e) => {
				if (e.candidate) {
					const typ =
						e.candidate.type ||
						candidateTypeFromLine(e.candidate.candidate);
					candidateTypes.add(typ);
				} else {
					finish(icePrecheckPassed(candidateTypes));
				}
			};

			pc.createOffer()
				.then((offer) => pc.setLocalDescription(offer))
				.catch((err) => finish(false, err.message));
		});
	})();

	return stunCheckPromise;
}

const SIGNALING_TYPES = new Set([
	"webrtc-offer",
	"webrtc-answer",
	"ice-candidate",
	"transport-mode",
]);

class P2pNegotiator {
	constructor(ws, role) {
		this.ws = ws;
		this.role = role;
		this.pc = null;
		this.dc = null;
		this.pendingCandidates = [];
		this.remoteDescriptionSet = false;
		this._resolved = false;
		this._timeout = null;
		this._readyPromise = new Promise((resolve) => {
			this._resolveReady = resolve;
		});
	}

	sendSignaling(obj) {
		this.ws.send(JSON.stringify(obj));
	}

	_resetConnectTimeout() {
		if (this._resolved) return;
		clearTimeout(this._timeout);
		this._timeout = setTimeout(
			() => this._resolve("relay", null, "timeout"),
			p2pConnectTimeoutMs(),
		);
	}

	async start() {
		this.pc = new RTCPeerConnection({ iceServers });

		this.pc.onicecandidate = (e) => {
			if (e.candidate) {
				this.sendSignaling({
					type: "ice-candidate",
					candidate: e.candidate.toJSON(),
				});
			}
		};

		this.pc.oniceconnectionstatechange = () => {
			const st = this.pc?.iceConnectionState;
			if (typeof crocLog !== "undefined") {
				crocLog.log(this.role, "ICE state:", st);
			}
			if (st === "failed") {
				this._resolve("relay", null, "ice-failed");
			}
		};

		if (this.role === "sender") {
			this.dc = this.pc.createDataChannel("croc", { ordered: true });
			this._setupDataChannel(this.dc);
			const offer = await this.pc.createOffer();
			await this.pc.setLocalDescription(offer);
			this.sendSignaling({ type: "webrtc-offer", sdp: this.pc.localDescription });
		} else {
			this.pc.ondatachannel = (e) => {
				this.dc = e.channel;
				this._setupDataChannel(this.dc);
			};
		}

		this._resetConnectTimeout();
	}

	_setupDataChannel(dc) {
		dc.binaryType = "arraybuffer";
		dc.onopen = () => {
			if (this._resolved) return;
			this._resolve("p2p", new P2pTransport(dc), "datachannel-open");
		};
	}

	async _flushCandidates() {
		for (const cand of this.pendingCandidates) {
			await this.pc.addIceCandidate(cand);
		}
		this.pendingCandidates = [];
	}

	async handleMessage(msg) {
		if (!SIGNALING_TYPES.has(msg.type)) return false;

		switch (msg.type) {
			case "webrtc-offer": {
				if (this.role !== "receiver" || !this.pc) return true;
				await this.pc.setRemoteDescription(msg.sdp);
				this.remoteDescriptionSet = true;
				await this._flushCandidates();
				const answer = await this.pc.createAnswer();
				await this.pc.setLocalDescription(answer);
				this.sendSignaling({
					type: "webrtc-answer",
					sdp: this.pc.localDescription,
				});
				this._resetConnectTimeout();
				return true;
			}
			case "webrtc-answer": {
				if (this.role !== "sender" || !this.pc) return true;
				await this.pc.setRemoteDescription(msg.sdp);
				this.remoteDescriptionSet = true;
				await this._flushCandidates();
				this._resetConnectTimeout();
				return true;
			}
			case "ice-candidate": {
				if (!this.pc || !msg.candidate) return true;
				const cand = new RTCIceCandidate(msg.candidate);
				if (this.remoteDescriptionSet) {
					await this.pc.addIceCandidate(cand);
				} else {
					this.pendingCandidates.push(cand);
				}
				return true;
			}
			case "transport-mode": {
				if (msg.mode === "relay") {
					this._resolve("relay", null, "peer-relay");
				}
				return true;
			}
			default:
				return false;
		}
	}

	_resolve(mode, p2pTransport, reason) {
		if (this._resolved) return;
		this._resolved = true;
		clearTimeout(this._timeout);
		if (typeof crocLog !== "undefined") {
			crocLog.log(this.role, "P2P negotiate ->", mode, reason || "");
		}
		if (mode === "relay") {
			this.sendSignaling({ type: "transport-mode", mode: "relay" });
		}
		if (this.pc && mode === "relay") {
			this.pc.close();
			this.pc = null;
			this.dc = null;
		}
		this._resolveReady({ mode, p2pTransport });
	}

	waitReady() {
		return this._readyPromise;
	}

	destroy() {
		clearTimeout(this._timeout);
		if (this.pc) {
			this.pc.close();
			this.pc = null;
		}
	}
}
