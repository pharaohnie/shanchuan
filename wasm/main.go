// Package wasm provides the WebAssembly entry point for Croc-WASM.
// It exports PAKE and encryption functions to JavaScript.
//
// Build: GOOS=js GOARCH=wasm go build -o ../public/croc.wasm .
package main

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"syscall/js"

	"github.com/schollz/pake/v3"
)

// Global PAKE instance (one at a time)
var currentPake *pake.Pake

// Cached AES-GCM cipher. The session key is constant for an entire transfer, so
// rebuilding the cipher (key schedule + GCM init) for every 64KB chunk is pure
// waste. We rebuild only when the key actually changes.
var (
	cachedKey    []byte
	cachedAESGCM cipher.AEAD
	nonceCounter uint64
)

// getCipher returns a cached AES-GCM cipher, rebuilding only when the key changes.
func getCipher(key []byte) (cipher.AEAD, error) {
	if cachedAESGCM != nil && bytes.Equal(cachedKey, key) {
		return cachedAESGCM, nil
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	cachedKey = append(cachedKey[:0], key...)
	cachedAESGCM = gcm
	nonceCounter = 0
	return gcm, nil
}

// nextNonce returns a 96-bit GCM nonce from an incrementing counter. GCM only
// requires nonces be unique per key; a counter is far cheaper than crypto/rand
// per chunk and doubles as an implicit chunk ordering.
func nextNonce(size int) []byte {
	nonce := make([]byte, size)
	binary.BigEndian.PutUint64(nonce[:8], nonceCounter)
	nonceCounter++
	return nonce
}

// Error response
type wasmError struct {
	Error string `json:"error"`
}

func returnError(msg string) js.Value {
	errResp, _ := json.Marshal(wasmError{Error: msg})
	return js.ValueOf(string(errResp))
}

func returnJSON(data interface{}) js.Value {
	b, _ := json.Marshal(data)
	return js.ValueOf(string(b))
}

// ─── PAKE Functions ───────────────────────────────────────────────────────

// initPAKE initializes a PAKE instance.
// role: 0 = sender, 1 = receiver
// secret: shared password/code phrase
// curve: "siec" (default) or "ed25519"
func initPAKE(this js.Value, args []js.Value) interface{} {
	if len(args) < 2 {
		return returnError("initPAKE: need role (0/1) and secret")
	}
	role := args[0].Int()
	secret := args[1].String()
	curve := "siec"
	if len(args) >= 3 {
		curve = args[2].String()
	}

	var err error
	currentPake, err = pake.InitCurve([]byte(secret), role, curve)
	if err != nil {
		return returnError("PAKE init failed: " + err.Error())
	}

	return returnJSON(map[string]interface{}{
		"success": true,
		"role":    role,
	})
}

// getPAKEMessage returns the current PAKE message to send to the other party.
func getPAKEMessage(this js.Value, args []js.Value) interface{} {
	if currentPake == nil {
		return returnError("PAKE not initialized")
	}
	bytes := currentPake.Bytes()
	encoded := base64.StdEncoding.EncodeToString(bytes)
	return returnJSON(map[string]interface{}{
		"message": encoded,
	})
}

// processPAKEMessage processes a received PAKE message from the other party.
// Returns the response message (if any) and whether the key exchange is complete.
func processPAKEMessage(this js.Value, args []js.Value) interface{} {
	if currentPake == nil {
		return returnError("PAKE not initialized")
	}
	if len(args) < 1 {
		return returnError("processPAKEMessage: need message")
	}

	encoded := args[0].String()

	otherBytes, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return returnError("processPAKEMessage: base64 decode failed: " + err.Error())
	}

	err = currentPake.Update(otherBytes)
	if err != nil {
		return returnError("PAKE update failed: " + err.Error())
	}

	hasKey := currentPake.HaveSessionKey()

	// Always send response for the receiver (role=1), even if key is computed.
	// The sender (role=0) needs the receiver's Y to compute the key.
	// SPAKE2: 1) sender sends X → 2) receiver sends Y → 3) both have key
	var response *string
	if !hasKey || currentPake.Role == 1 {
		bytes := currentPake.Bytes()
		encoded := base64.StdEncoding.EncodeToString(bytes)
		response = &encoded
	}

	result := map[string]interface{}{
		"complete": hasKey,
	}
	if response != nil {
		result["message"] = *response
	}

	return returnJSON(result)
}

// getSessionKey returns the derived session key (base64 encoded).
func getSessionKey(this js.Value, args []js.Value) interface{} {
	if currentPake == nil {
		return returnError("PAKE not initialized")
	}
	key, err := currentPake.SessionKey()
	if err != nil {
		return returnError("No session key: " + err.Error())
	}
	encoded := base64.StdEncoding.EncodeToString(key)
	return returnJSON(map[string]interface{}{
		"key": encoded,
	})
}

// ─── Encryption Functions ─────────────────────────────────────────────────

// encrypt encrypts data using AES-256-GCM.
// key:  Uint8Array (32 bytes)
// aad:  Uint8Array or null (additional authenticated data; binds chunk order)
// data: Uint8Array plaintext
// Returns: Uint8Array (nonce || ciphertext), or a JSON error string on failure.
//
// Zero base64: bytes are copied directly between JS and Go via CopyBytesToGo /
// CopyBytesToJS, and the result is a Uint8Array JS can ws.send() with no further
// conversion. Eliminates the 4x base64 round-trips + per-byte string loops that
// were the dominant transfer bottleneck.
func encrypt(this js.Value, args []js.Value) interface{} {
	if len(args) < 3 {
		return returnError("encrypt: need key (Uint8Array), aad (Uint8Array|null), data (Uint8Array)")
	}

	key := make([]byte, args[0].Get("byteLength").Int())
	if len(key) != 32 {
		return returnError("encrypt: key must be 32 bytes")
	}
	js.CopyBytesToGo(key, args[0])

	var aad []byte
	if args[1].Truthy() {
		aad = make([]byte, args[1].Get("byteLength").Int())
		js.CopyBytesToGo(aad, args[1])
	}

	data := make([]byte, args[2].Get("byteLength").Int())
	js.CopyBytesToGo(data, args[2])

	aesgcm, err := getCipher(key)
	if err != nil {
		return returnError("encrypt: cipher init failed: " + err.Error())
	}

	nonce := nextNonce(aesgcm.NonceSize())
	ciphertext := aesgcm.Seal(nil, nonce, data, aad)
	// Prepend nonce to ciphertext
	result := append(nonce, ciphertext...)

	out := js.Global().Get("Uint8Array").New(len(result))
	js.CopyBytesToJS(out, result)
	return out
}

// decrypt decrypts data using AES-256-GCM.
// key: Uint8Array (32 bytes)
// aad: Uint8Array or null (must match the encrypt AAD)
// data: Uint8Array (nonce || ciphertext)
// Returns: Uint8Array plaintext, or a JSON error string on failure.
func decrypt(this js.Value, args []js.Value) interface{} {
	if len(args) < 3 {
		return returnError("decrypt: need key (Uint8Array), aad (Uint8Array|null), data (Uint8Array)")
	}

	key := make([]byte, args[0].Get("byteLength").Int())
	if len(key) != 32 {
		return returnError("decrypt: key must be 32 bytes")
	}
	js.CopyBytesToGo(key, args[0])

	var aad []byte
	if args[1].Truthy() {
		aad = make([]byte, args[1].Get("byteLength").Int())
		js.CopyBytesToGo(aad, args[1])
	}

	ciphertext := make([]byte, args[2].Get("byteLength").Int())
	js.CopyBytesToGo(ciphertext, args[2])

	aesgcm, err := getCipher(key)
	if err != nil {
		return returnError("decrypt: cipher init failed: " + err.Error())
	}

	nonceSize := aesgcm.NonceSize()
	if len(ciphertext) < nonceSize {
		return returnError("decrypt: ciphertext too short")
	}

	nonce, data := ciphertext[:nonceSize], ciphertext[nonceSize:]
	plaintext, err := aesgcm.Open(nil, nonce, data, aad)
	if err != nil {
		return returnError("decrypt: AES-GCM open failed: " + err.Error())
	}

	out := js.Global().Get("Uint8Array").New(len(plaintext))
	js.CopyBytesToJS(out, plaintext)
	return out
}

// ─── WASM Entry Point ─────────────────────────────────────────────────────

func main() {
	// Export functions to JavaScript
	js.Global().Set("wasmInitPAKE", js.FuncOf(initPAKE))
	js.Global().Set("wasmGetPAKEMessage", js.FuncOf(getPAKEMessage))
	js.Global().Set("wasmProcessPAKEMessage", js.FuncOf(processPAKEMessage))
	js.Global().Set("wasmGetSessionKey", js.FuncOf(getSessionKey))
	js.Global().Set("wasmEncrypt", js.FuncOf(encrypt))
	js.Global().Set("wasmDecrypt", js.FuncOf(decrypt))

	// Signal that the WASM module is ready
	js.Global().Get("console").Call("log", "🐊 Croc-WASM module loaded and ready")

	// Block forever to keep the WASM module alive
	select {}
}
