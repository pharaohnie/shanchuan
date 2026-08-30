// WebRTC P2P negotiation: Cloudflare STUN, offer/answer/ICE via WebSocket signaling.

const ICE_SERVERS = [{ urls: "stun:stun.cloudflare.com:3478" }];
const STUN_SERVER = "stun.cloudflare.com:3478";
const P2P_CONNECT_TIMEOUT_MS = 15000;
const STUN_CHECK_TIMEOUT_MS = 5000;

let stunCheckPromise = null;

function candidateTypeFromLine(line) {
	const m = line.match(/\btyp (\w+)/);
	return m ? m[1] : "unknown";
}

// Probe Cloudflare STUN via ICE gathering. ok when at least one srflx candidate appears.
function checkStunConnectivity() {
	if (stunCheckPromise) return stunCheckPromise;

	stunCheckPromise = (async () => {
		const started = Date.now();
		const candidateTypes = new Set();
		const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
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
					server: STUN_SERVER,
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
					finish(candidateTypes.has("srflx"));
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

	async start() {
		this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

		this.pc.onicecandidate = (e) => {
			if (e.candidate) {
				this.sendSignaling({
					type: "ice-candidate",
					candidate: e.candidate.toJSON(),
				});
			}
		};

		this.pc.oniceconnectionstatechange = () => {
			if (this.pc?.iceConnectionState === "failed") {
				this._resolve("relay", null);
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

		this._timeout = setTimeout(
			() => this._resolve("relay", null),
			P2P_CONNECT_TIMEOUT_MS,
		);
	}

	_setupDataChannel(dc) {
		dc.binaryType = "arraybuffer";
		dc.onopen = () => {
			if (this._resolved) return;
			this._resolve("p2p", new P2pTransport(dc));
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
				return true;
			}
			case "webrtc-answer": {
				if (this.role !== "sender" || !this.pc) return true;
				await this.pc.setRemoteDescription(msg.sdp);
				this.remoteDescriptionSet = true;
				await this._flushCandidates();
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
					this._resolve("relay", null);
				}
				return true;
			}
			default:
				return false;
		}
	}

	_resolve(mode, p2pTransport) {
		if (this._resolved) return;
		this._resolved = true;
		clearTimeout(this._timeout);
		if (typeof crocLog !== "undefined") {
			crocLog.log(this.role, "P2P negotiate ->", mode);
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
