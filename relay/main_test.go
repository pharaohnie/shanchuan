package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

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
