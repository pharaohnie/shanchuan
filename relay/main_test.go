package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func initTestRelay() {
	cfg = defaultConfig()
	cfg.WebSocket.AllowedOrigins = []string{"*"}
	initUpgrader()
	joinLimit = newIPRateLimiter(100, time.Minute)
	stunLimit = newIPRateLimiter(100, time.Minute)
}

func TestMain(m *testing.M) {
	initTestRelay()
	os.Exit(m.Run())
}

func TestRoomExpireUnblocksWaiter(t *testing.T) {
	room := &Room{
		name:      "test",
		createdAt: time.Now(),
		ready:     make(chan struct{}),
		done:      make(chan struct{}),
	}

	unblocked := make(chan struct{})
	go func() {
		<-room.ready
		close(unblocked)
	}()

	room.expire("Room expired due to inactivity")

	select {
	case <-unblocked:
	case <-time.After(time.Second):
		t.Fatal("expire did not close room.ready")
	}

	room.mu.Lock()
	defer room.mu.Unlock()
	if room.first != nil || room.second != nil {
		t.Fatal("expire should nil out connections")
	}
}

func TestRoomExpireSafeWhenReadyAlreadyClosed(t *testing.T) {
	room := &Room{
		ready: make(chan struct{}),
	}
	close(room.ready)

	// Must not panic when ready is already closed.
	room.expire("Room expired due to inactivity")
}

func TestHandleStunCheck(t *testing.T) {
	body := `{"ok":true,"server":"stun.cloudflare.com:3478","elapsedMs":120,"candidateTypes":["host","srflx"]}`
	req := httptest.NewRequest(http.MethodPost, "/api/stun-check", strings.NewReader(body))
	rec := httptest.NewRecorder()
	handleStunCheck(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d", rec.Code)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/stun-check", nil)
	rec = httptest.NewRecorder()
	handleStunCheck(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", rec.Code)
	}

	req = httptest.NewRequest(http.MethodPost, "/api/stun-check", strings.NewReader("not json"))
	rec = httptest.NewRecorder()
	handleStunCheck(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
}

func TestTransportModeFromMessage(t *testing.T) {
	mode, ok := transportModeFromMessage([]byte(`{"type":"transport-mode","mode":"p2p"}`))
	if !ok || mode != "p2p" {
		t.Fatalf("expected p2p, got %q ok=%v", mode, ok)
	}

	mode, ok = transportModeFromMessage([]byte(`{"type":"transport-mode","mode":"relay"}`))
	if !ok || mode != "relay" {
		t.Fatalf("expected relay, got %q ok=%v", mode, ok)
	}

	_, ok = transportModeFromMessage([]byte(`{"type":"webrtc-offer"}`))
	if ok {
		t.Fatal("expected false for non transport-mode message")
	}

	_, ok = transportModeFromMessage([]byte(`not json`))
	if ok {
		t.Fatal("expected false for invalid json")
	}
}

func TestHandleWebSocketFirstClientExpires(t *testing.T) {
	relay.rooms = make(map[string]*Room)

	server := httptest.NewServer(http.HandlerFunc(handleWebSocket))
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")

	dialer := websocket.Dialer{}
	conn, _, err := dialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	if err := conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"join","room":"expire-test"}`)); err != nil {
		t.Fatalf("write join: %v", err)
	}

	_, msg, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read waiting: %v", err)
	}
	if !strings.Contains(string(msg), `"waiting"`) {
		t.Fatalf("expected waiting message, got %q", msg)
	}

	room := relay.getOrCreateRoom("expire-test")
	room.expire("Room expired due to inactivity")

	_, msg, err = conn.ReadMessage()
	if err != nil {
		t.Fatalf("read error after expire: %v", err)
	}
	if !strings.Contains(string(msg), `"error"`) {
		t.Fatalf("expected error message after expire, got %q", msg)
	}
}
