// Package wasm provides the WebAssembly entry point for Croc-WASM.
// It exports PAKE and encryption functions to JavaScript.
//
// Build: GOOS=js GOARCH=wasm go build -o ../public/croc.wasm .
package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"syscall/js"

	"github.com/schollz/pake/v3"
)

// Global PAKE instance (one at a time)
var currentPake *pake.Pake

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
// key: base64-encoded 32-byte key
// data: base64-encoded plaintext
// Returns: base64-encoded ciphertext (IV + ciphertext)
func encrypt(this js.Value, args []js.Value) interface{} {
	if len(args) < 2 {
		return returnError("encrypt: need key and data")
	}

	key, err := base64.StdEncoding.DecodeString(args[0].String())
	if err != nil {
		return returnError("encrypt: key decode failed: " + err.Error())
	}
	data, err := base64.StdEncoding.DecodeString(args[1].String())
	if err != nil {
		return returnError("encrypt: data decode failed: " + err.Error())
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return returnError("encrypt: AES init failed: " + err.Error())
	}

	aesgcm, err := cipher.NewGCM(block)
	if err != nil {
		return returnError("encrypt: GCM init failed: " + err.Error())
	}

	nonce := make([]byte, aesgcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return returnError("encrypt: nonce generation failed: " + err.Error())
	}

	ciphertext := aesgcm.Seal(nil, nonce, data, nil)
	// Prepend nonce to ciphertext
	result := append(nonce, ciphertext...)
	encoded := base64.StdEncoding.EncodeToString(result)

	return returnJSON(map[string]interface{}{
		"ciphertext": encoded,
		"size":       len(result),
	})
}

// decrypt decrypts data using AES-256-GCM.
// key: base64-encoded 32-byte key
// data: base64-encoded ciphertext (IV + ciphertext)
// Returns: base64-encoded plaintext
func decrypt(this js.Value, args []js.Value) interface{} {
	if len(args) < 2 {
		return returnError("decrypt: need key and data")
	}

	key, err := base64.StdEncoding.DecodeString(args[0].String())
	if err != nil {
		return returnError("decrypt: key decode failed: " + err.Error())
	}
	ciphertext, err := base64.StdEncoding.DecodeString(args[1].String())
	if err != nil {
		return returnError("decrypt: data decode failed: " + err.Error())
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return returnError("decrypt: AES init failed: " + err.Error())
	}

	aesgcm, err := cipher.NewGCM(block)
	if err != nil {
		return returnError("decrypt: GCM init failed: " + err.Error())
	}

	nonceSize := aesgcm.NonceSize()
	if len(ciphertext) < nonceSize {
		return returnError("decrypt: ciphertext too short")
	}

	nonce, data := ciphertext[:nonceSize], ciphertext[nonceSize:]
	plaintext, err := aesgcm.Open(nil, nonce, data, nil)
	if err != nil {
		return returnError("decrypt: AES-GCM open failed: " + err.Error())
	}

	encoded := base64.StdEncoding.EncodeToString(plaintext)
	return returnJSON(map[string]interface{}{
		"plaintext": encoded,
		"size":      len(plaintext),
	})
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
