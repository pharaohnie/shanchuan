package main

import (
	"os"
	"strings"
	"testing"
)

func TestLoadConfig(t *testing.T) {
	path := writeTempConfig(t, `
server:
  addr: ":9999"
cors:
  allowed_origins:
    - "https://example.com"
websocket:
  allowed_origins:
    - "https://example.com"
client:
  relay_url: "wss://relay.example.com/ws"
  ice_servers:
    - urls: "stun:stun.example.com:3478"
    - urls: "turn:turn.example.com:3478"
turn:
  auth_secret: "secret"
  credential_ttl_seconds: 7200
  user_id: "turnuser"
rate_limit:
  join_per_minute: 5
  stun_check_per_minute: 2
  trust_forwarded_ip: true
`)
	cfg, err := loadConfig(path)
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	if cfg.Server.Addr != ":9999" {
		t.Fatalf("addr: got %q", cfg.Server.Addr)
	}
	if cfg.Client.RelayURL != "wss://relay.example.com/ws" {
		t.Fatalf("relay_url: got %q", cfg.Client.RelayURL)
	}
	if len(cfg.Client.IceServers) != 2 {
		t.Fatalf("ice_servers: got %d entries", len(cfg.Client.IceServers))
	}
	if cfg.Turn.AuthSecret != "secret" || cfg.Turn.UserID != "turnuser" {
		t.Fatalf("turn config: got %+v", cfg.Turn)
	}
	if cfg.Turn.CredentialTTLSeconds != 7200 {
		t.Fatalf("credential_ttl_seconds: got %d", cfg.Turn.CredentialTTLSeconds)
	}
	if cfg.RateLimit.JoinPerMinute != 5 {
		t.Fatalf("join limit: got %d", cfg.RateLimit.JoinPerMinute)
	}
	if !cfg.RateLimit.TrustForwardedIP {
		t.Fatal("expected trust_forwarded_ip true")
	}
}

func TestOriginAllowed(t *testing.T) {
	cfg := Config{
		CORS: CORSConfig{AllowedOrigins: []string{"http://localhost:8154"}},
		WebSocket: WebSocketConfig{
			AllowedOrigins: []string{"http://localhost:8154", "*"},
		},
	}
	if !cfg.originAllowed(cfg.CORS.AllowedOrigins, "http://localhost:8154") {
		t.Fatal("expected localhost allowed for CORS")
	}
	if cfg.originAllowed(cfg.CORS.AllowedOrigins, "https://evil.com") {
		t.Fatal("expected evil.com rejected for CORS")
	}
	if !cfg.originAllowed(cfg.WebSocket.AllowedOrigins, "https://any.com") {
		t.Fatal("expected wildcard websocket origin")
	}
}

func TestResolveConfigPath(t *testing.T) {
	if got := resolveConfigPath("/custom/path.yaml"); got != "/custom/path.yaml" {
		t.Fatalf("expected custom path, got %q", got)
	}
}

func writeTempConfig(t *testing.T, content string) string {
	t.Helper()
	f, err := os.CreateTemp(t.TempDir(), "config-*.yaml")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString(strings.TrimSpace(content)); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	return f.Name()
}
