// Transfer transport abstraction: relay (WebSocket) or P2P (RTCDataChannel).

class RelayTransport {
	constructor(ws) {
		this.ws = ws;
		this._mode = "relay";
		this._handlers = [];
		this._pending = [];
	}

	get mode() {
		return this._mode;
	}

	get bufferedAmount() {
		return this.ws.bufferedAmount;
	}

	send(data) {
		this.ws.send(data);
	}

	onMessage(handler) {
		this._handlers.push(handler);
		for (const data of this._pending) {
			handler(data);
		}
		this._pending = [];
	}

	dispatch(data) {
		if (this._handlers.length === 0) {
			this._pending.push(data);
			return;
		}
		for (const h of this._handlers) h(data);
	}

	async drain(threshold) {
		let delay = 1;
		return new Promise((resolve) => {
			const check = () => {
				if (this.ws.bufferedAmount <= threshold) {
					resolve();
					return;
				}
				setTimeout(check, delay);
				delay = Math.min(delay * 2, 8);
			};
			check();
		});
	}

	close() {
		// WebSocket lifecycle is managed by app.js.
	}
}

class P2pTransport {
	constructor(dc) {
		this.dc = dc;
		this._mode = "p2p";
		this._handlers = [];
		this._pending = [];
		dc.binaryType = "arraybuffer";
		dc.onmessage = (e) => {
			const data =
				e.data instanceof ArrayBuffer
					? new Uint8Array(e.data)
					: new Uint8Array(e.data);
			if (this._handlers.length === 0) {
				this._pending.push(data);
				return;
			}
			for (const h of this._handlers) h(data);
		};
	}

	get mode() {
		return this._mode;
	}

	get bufferedAmount() {
		return this.dc.bufferedAmount;
	}

	send(data) {
		this.dc.send(data);
	}

	onMessage(handler) {
		this._handlers.push(handler);
		for (const data of this._pending) {
			handler(data);
		}
		this._pending = [];
	}

	async drain(threshold) {
		if (this.dc.bufferedAmount <= threshold) {
			return;
		}
		if ("bufferedAmountLowThreshold" in this.dc) {
			this.dc.bufferedAmountLowThreshold = threshold;
		}
		return new Promise((resolve) => {
			const onLow = () => {
				this.dc.removeEventListener("bufferedamountlow", onLow);
				resolve();
			};
			this.dc.addEventListener("bufferedamountlow", onLow);
			if (this.dc.bufferedAmount <= threshold) {
				this.dc.removeEventListener("bufferedamountlow", onLow);
				resolve();
			}
		});
	}

	close() {
		if (this.dc.readyState === "open") {
			this.dc.close();
		}
	}
}
