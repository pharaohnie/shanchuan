package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestIPRateLimiter(t *testing.T) {
	rl := newIPRateLimiter(2, time.Minute, false)

	if !rl.allow("1.2.3.4") || !rl.allow("1.2.3.4") {
		t.Fatal("expected first two requests allowed")
	}
	if rl.allow("1.2.3.4") {
		t.Fatal("expected third request blocked")
	}
	if !rl.allow("5.6.7.8") {
		t.Fatal("expected different IP allowed")
	}
}

func TestRateLimitMiddleware(t *testing.T) {
	rl := newIPRateLimiter(1, time.Minute, false)
	handler := rl.middleware(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})

	req := httptest.NewRequest(http.MethodPost, "/api/stun-check", nil)
	req.RemoteAddr = "1.2.3.4:1234"
	rec := httptest.NewRecorder()
	handler(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("first request: expected 204, got %d", rec.Code)
	}

	rec = httptest.NewRecorder()
	handler(rec, req)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("second request: expected 429, got %d", rec.Code)
	}
}

func TestClientIPWithTrustForwardedIP(t *testing.T) {
	oldNets := trustedProxyNets
	t.Cleanup(func() { trustedProxyNets = oldNets })
	var err error
	trustedProxyNets, err = parseTrustedProxyCIDRs([]string{"10.0.0.0/8"})
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodGet, "/ws", nil)
	req.RemoteAddr = "10.0.0.1:1234"

	if got := clientIPWithTrust(req, false); got != "10.0.0.1" {
		t.Fatalf("without trust: got %q", got)
	}

	req.Header.Set("X-Forwarded-For", "203.0.113.5, 10.0.0.1")
	if got := clientIPWithTrust(req, true); got != "203.0.113.5" {
		t.Fatalf("trusted XFF from proxy: got %q", got)
	}

	req.Header.Del("X-Forwarded-For")
	req.Header.Set("X-Real-IP", "198.51.100.9")
	if got := clientIPWithTrust(req, true); got != "198.51.100.9" {
		t.Fatalf("trusted X-Real-IP: got %q", got)
	}

	direct := httptest.NewRequest(http.MethodGet, "/ws", nil)
	direct.RemoteAddr = "203.0.113.9:1234"
	direct.Header.Set("X-Forwarded-For", "1.2.3.4")
	if got := clientIPWithTrust(direct, true); got != "203.0.113.9" {
		t.Fatalf("ignored spoofed XFF on direct connect: got %q", got)
	}
}

func TestHandleConfigAPI(t *testing.T) {
	oldCfg := cfg
	t.Cleanup(func() { cfg = oldCfg })
	cfg = Config{
		Turn: TurnConfig{
			AuthSecret:           "test-secret",
			CredentialTTLSeconds: 3600,
			UserID:               "u",
		},
		Client: ClientConfig{
			RelayURL: "wss://relay.test/ws",
			IceServers: []IceServerConfig{
				{URLs: "turn:turn.test:3478"},
			},
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/api/config", nil)
	rec := httptest.NewRecorder()
	handleConfigAPI(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "wss://relay.test/ws") {
		t.Fatalf("unexpected body: %s", body)
	}
	if !strings.Contains(body, "turn:turn.test:3478") {
		t.Fatalf("expected ice_servers in body: %s", body)
	}
	if strings.Contains(body, `"credential":"p"`) {
		t.Fatalf("expected dynamic credential, not static: %s", body)
	}
	if !strings.Contains(body, `"username":"`) {
		t.Fatalf("expected dynamic username in body: %s", body)
	}
}

func TestTruncateForLogStripsControlChars(t *testing.T) {
	got := truncateForLog("line1\nline2", 100)
	if strings.Contains(got, "\n") {
		t.Fatalf("expected control chars stripped, got %q", got)
	}
}
