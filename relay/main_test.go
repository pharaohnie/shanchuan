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
	wildcard := "*"
	cfg.WebSocket.AllowedOrigins = []string{wildcard}
	cfg.Server.MaxRooms = 1000
	initUpgrader()
	joinLimit = newIPRateLimiter(100, time.Minute, false)
	wsConnLimit = newIPConnLimiter(cfg.RateLimit.MaxWSConnsPerIP)
	stunLimit = newIPRateLimiter(100, time.Minute, false)
}

func resetWSLimits(t *testing.T) {
	t.Helper()
	reset := func() {
		joinLimit = newIPRateLimiter(1000, time.Minute, false)
		wsConnLimit = newIPConnLimiter(8)
		cfg.WebSocket.JoinTimeoutSeconds = 10
	}
	reset()
	t.Cleanup(reset)
}

func TestMain(m *testing.M) {
	initTestRelay()
	os.Exit(m.Run())
}

func TestRoomExpireUnblocksWaiter(t *testing.T) {
	now := time.Now()
	room := &Room{
		name:         "test",
		createdAt:    now,
		lastActivity: now,
		ready:        make(chan struct{}),
		done:         make(chan struct{}),
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

func TestRoomCloseDoneIdempotent(t *testing.T) {
	room := &Room{done: make(chan struct{})}
	room.closeDone()
	room.closeDone()
	select {
	case <-room.done:
	default:
		t.Fatal("done should be closed")
	}
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

	room, err := relay.getOrCreateRoom("expire-test")
	if err != nil {
		t.Fatalf("getOrCreateRoom: %v", err)
	}
	room.expire("Room expired due to inactivity")

	_, _, err = conn.ReadMessage()
	if err == nil {
		t.Fatal("expected connection closed after expire")
	}
}

func TestSecurityHeadersIncludeHSTS(t *testing.T) {
	cfg = defaultConfig()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	securityMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})).ServeHTTP(rec, req)
	if hsts := rec.Header().Get("Strict-Transport-Security"); !strings.Contains(hsts, "max-age=") {
		t.Fatalf("missing HSTS header: %q", hsts)
	}
}

func TestJoinRateLimitBeforeUpgrade(t *testing.T) {
	resetWSLimits(t)
	joinLimit = newIPRateLimiter(1, time.Minute, false)

	req := httptest.NewRequest(http.MethodGet, "/ws", nil)
	rec := httptest.NewRecorder()
	handleWebSocket(rec, req)
	if rec.Code == http.StatusTooManyRequests {
		t.Fatal("first request should not be rate limited")
	}

	req = httptest.NewRequest(http.MethodGet, "/ws", nil)
	rec = httptest.NewRecorder()
	handleWebSocket(rec, req)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("second request: expected 429 before upgrade, got %d", rec.Code)
	}
}

func TestWSConcurrentLimitPerIP(t *testing.T) {
	resetWSLimits(t)
	wsConnLimit = newIPConnLimiter(1)
	relay.rooms = make(map[string]*Room)

	server := httptest.NewServer(http.HandlerFunc(handleWebSocket))
	defer server.Close()
	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	dialer := websocket.Dialer{}

	first, _, err := dialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("first dial: %v", err)
	}
	if err := first.WriteMessage(websocket.TextMessage, []byte(`{"type":"join","room":"conn-limit"}`)); err != nil {
		t.Fatalf("write join: %v", err)
	}
	if _, _, err := first.ReadMessage(); err != nil {
		t.Fatalf("read waiting: %v", err)
	}

	second, resp, err := dialer.Dial(wsURL, nil)
	if err == nil {
		second.Close()
		t.Fatal("second dial should be rejected")
	}
	if resp == nil || resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("expected 429 handshake rejection, got %+v", resp)
	}

	first.Close()
	// 服务端未在读首帧后继续读，CloseHandler 不会自行触发；显式过期房间以释放名额。
	if room, err := relay.getOrCreateRoom("conn-limit"); err == nil {
		room.expire("test cleanup")
		room.closeDone()
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		conn, _, err := dialer.Dial(wsURL, nil)
		if err == nil {
			conn.Close()
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("connection slot not released: %v", err)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestJoinTimeoutClosesIdleConnection(t *testing.T) {
	resetWSLimits(t)
	cfg.WebSocket.JoinTimeoutSeconds = 1
	relay.rooms = make(map[string]*Room)

	server := httptest.NewServer(http.HandlerFunc(handleWebSocket))
	defer server.Close()
	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")

	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, _, err := conn.ReadMessage(); err == nil {
		t.Fatal("expected connection to close after join timeout")
	}
}

func TestMaxRoomsRejectsJoin(t *testing.T) {
	relay.rooms = make(map[string]*Room)
	cfg.Server.MaxRooms = 1

	now := time.Now()
	relay.rooms["occupied"] = &Room{
		name:         "occupied",
		createdAt:    now,
		lastActivity: now,
		ready:        make(chan struct{}),
		done:         make(chan struct{}),
	}

	server := httptest.NewServer(http.HandlerFunc(handleWebSocket))
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	dialer := websocket.Dialer{}
	conn, _, err := dialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	_ = conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"join","room":"new-room"}`))
	_, msg, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if !strings.Contains(string(msg), "Server busy") {
		t.Fatalf("expected busy error, got %q", msg)
	}
}
