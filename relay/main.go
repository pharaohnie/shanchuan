// WebSocket Relay Server for Croc-WASM
// Handles room-based connection stapling with message forwarding

package main

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin:     func(r *http.Request) bool { return true },
	ReadBufferSize:  256 * 1024, // was 4KB; a single chunk+overhead now fits in one read
	WriteBufferSize: 256 * 1024,
}

// Room manages two paired WebSocket connections
type Room struct {
	name      string
	first     *websocket.Conn
	second    *websocket.Conn
	createdAt time.Time
	ready     chan struct{} // closed when second client arrives
	done      chan struct{} // closed when pipeConnections finishes
	mu        sync.Mutex
}

// Relay manages all rooms
type Relay struct {
	rooms map[string]*Room
	mu    sync.RWMutex
}

var relay = &Relay{
	rooms: make(map[string]*Room),
}

type RelayMessage struct {
	Type string `json:"type"`
	Room string `json:"room,omitempty"`
	Role string `json:"role,omitempty"`
	Msg  string `json:"msg,omitempty"`
}

func (r *Relay) getOrCreateRoom(name string) *Room {
	r.mu.Lock()
	defer r.mu.Unlock()
	if room, ok := r.rooms[name]; ok {
		return room
	}
	room := &Room{
		name:      name,
		createdAt: time.Now(),
		ready:     make(chan struct{}),
		done:      make(chan struct{}),
	}
	r.rooms[name] = room
	return room
}

func (r *Relay) deleteRoom(name string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	log.Printf("[relay] delete room '%s'", name)
	delete(r.rooms, name)
}

// expire closes connections and unblocks any waiter on room.ready.
// The caller must hold relay.mu and have removed the room from the map.
func (room *Room) expire(reason string) {
	room.mu.Lock()
	defer room.mu.Unlock()

	select {
	case <-room.ready:
	default:
		close(room.ready)
	}

	if room.first != nil {
		errMsg, _ := json.Marshal(RelayMessage{Type: "error", Msg: reason})
		room.first.WriteMessage(websocket.TextMessage, errMsg)
		room.first.Close()
		room.first = nil
	}
	if room.second != nil {
		room.second.Close()
		room.second = nil
	}
}

func (r *Relay) cleanupLoop() {
	ticker := time.NewTicker(5 * time.Minute)
	for range ticker.C {
		var stale []*Room
		r.mu.Lock()
		for name, room := range r.rooms {
			if time.Since(room.createdAt) > 30*time.Minute {
				log.Printf("[relay] cleanup stale room '%s'", name)
				delete(r.rooms, name)
				stale = append(stale, room)
			}
		}
		r.mu.Unlock()

		for _, room := range stale {
			room.expire("Room expired due to inactivity")
		}
	}
}

// pipeConnections forwards messages between two WebSocket connections.
// Returns when either connection closes.
func pipeConnections(a, b *websocket.Conn) {
	var wg sync.WaitGroup
	wg.Add(2)

	// a → b
	go func() {
		defer wg.Done()
		defer b.Close()
		for {
			msgType, msg, err := a.ReadMessage()
			if err != nil {
				return
			}
			if err := b.WriteMessage(msgType, msg); err != nil {
				return
			}
		}
	}()

	// b → a
	go func() {
		defer wg.Done()
		defer a.Close()
		for {
			msgType, msg, err := b.ReadMessage()
			if err != nil {
				return
			}
			if err := a.WriteMessage(msgType, msg); err != nil {
				return
			}
		}
	}()

	wg.Wait()
}

func handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("Upgrade error: %v", err)
		return
	}

	remoteAddr := conn.RemoteAddr().String()
	log.Printf("[relay] new connection from %s", remoteAddr)

	// Read join message
	_, msg, err := conn.ReadMessage()
	if err != nil {
		log.Printf("[relay] %s: read join error: %v", remoteAddr, err)
		conn.Close()
		return
	}

	var joinMsg RelayMessage
	if err := json.Unmarshal(msg, &joinMsg); err != nil {
		log.Printf("[relay] %s: JSON error: %v", remoteAddr, err)
		conn.Close()
		return
	}

	if joinMsg.Type != "join" || joinMsg.Room == "" {
		log.Printf("[relay] %s: invalid join message", remoteAddr)
		conn.Close()
		return
	}

	log.Printf("[relay] %s joining room '%s'", remoteAddr, joinMsg.Room)

	room := relay.getOrCreateRoom(joinMsg.Room)
	room.mu.Lock()

	if room.first == nil {
		// ── First client ──
		room.first = conn
		room.mu.Unlock()

		pairMsg, _ := json.Marshal(RelayMessage{Type: "waiting", Role: "sender"})
		conn.WriteMessage(websocket.TextMessage, pairMsg)

		// Wait for second client (or room expiry from cleanupLoop).
		<-room.ready

		room.mu.Lock()
		first, second := room.first, room.second
		room.mu.Unlock()

		if first == nil || second == nil {
			return
		}

		pipeConnections(first, second)

		close(room.done)
		relay.deleteRoom(joinMsg.Room)

	} else if room.second == nil {
		// ── Second client ──
		room.second = conn
		room.mu.Unlock()

		pairedFirst, _ := json.Marshal(RelayMessage{Type: "paired", Role: "sender"})
		pairedSecond, _ := json.Marshal(RelayMessage{Type: "paired", Role: "receiver"})

		room.mu.Lock()
		room.first.WriteMessage(websocket.TextMessage, pairedFirst)
		room.second.WriteMessage(websocket.TextMessage, pairedSecond)
		room.mu.Unlock()

		close(room.ready)

		<-room.done
		relay.deleteRoom(joinMsg.Room)

	} else {
		// Room is full
		room.mu.Unlock()
		fullMsg, _ := json.Marshal(RelayMessage{Type: "error", Msg: "Room is full"})
		conn.WriteMessage(websocket.TextMessage, fullMsg)
		conn.Close()
	}
}

func main() {
	go relay.cleanupLoop()

	http.HandleFunc("/ws", handleWebSocket)
	http.Handle("/", http.FileServer(http.Dir("../public")))

	addr := ":8154"
	log.Printf("🐊 Croc-WASM Relay Server starting on %s", addr)
	log.Printf("   WebSocket endpoint: ws://localhost%s/ws", addr)
	log.Printf("   Frontend: http://localhost%s", addr)

	// Wrap the default mux to add CORS and logging
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "http://localhost:8154")
		http.DefaultServeMux.ServeHTTP(w, r)
	})

	if err := http.ListenAndServe(addr, handler); err != nil {
		log.Fatal(err)
	}
}
