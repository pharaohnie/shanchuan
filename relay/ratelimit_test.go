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
	req := httptest.NewRequest(http.MethodGet, "/ws", nil)
	req.RemoteAddr = "10.0.0.1:1234"

	if got := clientIPWithTrust(req, false); got != "10.0.0.1" {
		t.Fatalf("without trust: got %q", got)
	}

	req.Header.Set("X-Forwarded-For", "203.0.113.5, 10.0.0.1")
	if got := clientIPWithTrust(req, false); got != "10.0.0.1" {
		t.Fatalf("ignored XFF: got %q", got)
	}

	if got := clientIPWithTrust(req, true); got != "203.0.113.5" {
		t.Fatalf("trusted XFF: got %q", got)
	}

	req.Header.Del("X-Forwarded-For")
	req.Header.Set("X-Real-IP", "198.51.100.9")
	if got := clientIPWithTrust(req, true); got != "198.51.100.9" {
		t.Fatalf("trusted X-Real-IP: got %q", got)
	}
}

func TestHandleConfigAPI(t *testing.T) {
	cfg = Config{
		Client: ClientConfig{RelayURL: "wss://relay.test/ws"},
	}

	req := httptest.NewRequest(http.MethodGet, "/api/config", nil)
	rec := httptest.NewRecorder()
	handleConfigAPI(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "wss://relay.test/ws") {
		t.Fatalf("unexpected body: %s", rec.Body.String())
	}
}
