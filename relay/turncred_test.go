package main

import (
	"encoding/base64"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestGenerateTurnCredential(t *testing.T) {
	secret := "test-secret"
	userID := "shanchuan"
	ttl := time.Hour

	username, credential := generateTurnCredential(secret, userID, ttl)
	parts := strings.SplitN(username, ":", 2)
	if len(parts) != 2 || parts[1] != userID {
		t.Fatalf("unexpected username format: %q", username)
	}

	expiry, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		t.Fatalf("parse expiry: %v", err)
	}
	now := time.Now().Unix()
	if expiry < now+3500 || expiry > now+3700 {
		t.Fatalf("expiry out of range: got %d now %d", expiry, now)
	}

	if credential == "" {
		t.Fatal("expected non-empty credential")
	}
	if _, err := base64.StdEncoding.DecodeString(credential); err != nil {
		t.Fatalf("credential not valid base64: %v", err)
	}

	u2, c2 := generateTurnCredential(secret, userID, ttl)
	if u2 != username || c2 != credential {
		t.Fatal("expected deterministic credential within same second")
	}
}

func TestIsTurnURL(t *testing.T) {
	if !isTurnURL("turn:example.com:3478") {
		t.Fatal("expected turn URL")
	}
	if !isTurnURL("turns:example.com:5349") {
		t.Fatal("expected turns URL")
	}
	if isTurnURL("stun:example.com:3478") {
		t.Fatal("stun should not match")
	}
}

func TestBuildClientIceServersDynamic(t *testing.T) {
	cfg := Config{
		Turn: TurnConfig{
			AuthSecret:           "secret",
			CredentialTTLSeconds: 3600,
			UserID:               "shanchuan",
		},
		Client: ClientConfig{
			IceServers: []IceServerConfig{
				{URLs: "stun:stun.example.com:3478"},
				{URLs: "turn:turn.example.com:3478?transport=udp"},
			},
		},
	}
	out := buildClientIceServers(cfg)
	if len(out) != 2 {
		t.Fatalf("expected 2 servers, got %d", len(out))
	}
	if out[0].Username != "" || out[0].Credential != "" {
		t.Fatalf("stun should have no credentials: %+v", out[0])
	}
	if out[1].Username == "" || out[1].Credential == "" {
		t.Fatalf("turn should have dynamic credentials: %+v", out[1])
	}
	if !strings.Contains(out[1].Username, ":shanchuan") {
		t.Fatalf("username should contain user id: %q", out[1].Username)
	}
}

func TestBuildClientIceServersStaticFallback(t *testing.T) {
	cfg := Config{
		Client: ClientConfig{
			IceServers: []IceServerConfig{
				{URLs: "turn:turn.example.com:3478", Username: "u", Credential: "p"},
			},
		},
	}
	out := buildClientIceServers(cfg)
	if out[0].Username != "u" || out[0].Credential != "p" {
		t.Fatalf("expected static fallback: %+v", out[0])
	}
}
