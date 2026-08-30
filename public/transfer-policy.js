// Relay/P2P transfer shutdown policy (testable, loaded before app.js).
(function (global) {
	const TRANSFER_DONE = "transfer-done";
	const TRANSFER_ACK = "transfer-ack";

	function shouldCloseSenderWebSocketImmediately(transportMode) {
		return transportMode === "p2p";
	}

	global.crocTransferPolicy = {
		TRANSFER_DONE,
		TRANSFER_ACK,
		shouldCloseSenderWebSocketImmediately,
	};
})(typeof window !== "undefined" ? window : globalThis);
