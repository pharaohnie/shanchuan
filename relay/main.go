// WebSocket Relay Server for Croc-WASM
// Handles room-based connection stapling with message forwarding

package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

var (
	cfg       Config
	upgrader  websocket.Upgrader
	joinLimit *ipRateLimiter
	stunLimit *ipRateLimiter
)

// maxWSMessageBytes caps a single WebSocket frame (256 KiB chunk + GCM overhead + headroom).
const maxWSMessageBytes = 2 * 1024 * 1024

const roomDoneWait = 35 * time.Minute

var errTooManyRooms = errors.New("too many rooms")

// Room manages two paired WebSocket connections
type Room struct {
	name         string
	first        *websocket.Conn
	second       *websocket.Conn
	createdAt    time.Time
	lastActivity time.Time
	ready        chan struct{} // closed when second client arrives
	done         chan struct{} // closed when pipeConnections finishes
	doneOnce     sync.Once
	mu           sync.Mutex
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
	Mode string `json:"mode,omitempty"`
}

type StunReport struct {
	Ok             bool     `json:"ok"`
	Server         string   `json:"server"`
	ElapsedMs      int      `json:"elapsedMs"`
	CandidateTypes []string `json:"candidateTypes,omitempty"`
	Error          string   `json:"error,omitempty"`
}

func initUpgrader() {
	upgrader = websocket.Upgrader{
		CheckOrigin: func(r *http.Request) bool {
			return cfg.websocketOriginAllowed(r)
		},
		ReadBufferSize:  256 * 1024,
		WriteBufferSize: 256 * 1024,
	}
}

func handleConfigAPI(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(ClientAPIResponse{
		RelayURL:  cfg.Client.RelayURL,
		PublicURL: cfg.Client.PublicURL,
	})
}

func handleStunCheck(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 4096)

	var report StunReport
	if err := json.NewDecoder(r.Body).Decode(&report); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}

	if len(report.Server) > 256 {
		http.Error(w, "server field too long", http.StatusBadRequest)
		return
	}
	if len(report.Error) > 512 {
		http.Error(w, "error field too long", http.StatusBadRequest)
		return
	}
	if len(report.CandidateTypes) > 32 {
		http.Error(w, "too many candidate types", http.StatusBadRequest)
		return
	}
	for i, typ := range report.CandidateTypes {
		if len(typ) > 32 {
			http.Error(w, "candidate type too long", http.StatusBadRequest)
			return
		}
		report.CandidateTypes[i] = typ
	}

	remote := r.RemoteAddr
	if report.Ok {
		log.Printf(
			"[relay] STUN check from %s: ok server=%s elapsed=%dms types=%v",
			remote, truncateForLog(report.Server, 256), report.ElapsedMs, report.CandidateTypes,
		)
	} else {
		errMsg := report.Error
		if errMsg == "" {
			errMsg = "no srflx candidate"
		}
		log.Printf(
			"[relay] STUN check from %s: failed server=%s elapsed=%dms types=%v error=%s",
			remote, truncateForLog(report.Server, 256), report.ElapsedMs, report.CandidateTypes,
			truncateForLog(errMsg, 512),
		)
	}

	w.WriteHeader(http.StatusNoContent)
}

// transportModeFromMessage returns the mode from a transport-mode signaling message.
func transportModeFromMessage(msg []byte) (string, bool) {
	var m RelayMessage
	if err := json.Unmarshal(msg, &m); err != nil {
		return "", false
	}
	if m.Type != "transport-mode" {
		return "", false
	}
	if m.Mode != "p2p" && m.Mode != "relay" {
		return "", false
	}
	return m.Mode, true
}

func logTransportMode(room string, msgType int, msg []byte) {
	if room == "" || msgType != websocket.TextMessage {
		return
	}
	mode, ok := transportModeFromMessage(msg)
	if !ok {
		return
	}
	switch mode {
	case "p2p":
		log.Printf("[relay] room '%s': transfer via P2P (file data bypasses relay)", room)
	case "relay":
		log.Printf("[relay] room '%s': transfer via relay fallback (file data forwarded)", room)
	}
}

func (room *Room) touchActivity() {
	room.mu.Lock()
	room.lastActivity = time.Now()
	room.mu.Unlock()
}

func (room *Room) touchActivityLocked() {
	room.lastActivity = time.Now()
}

func (room *Room) closeReady() {
	select {
	case <-room.ready:
	default:
		close(room.ready)
	}
}

func (room *Room) closeDone() {
	room.doneOnce.Do(func() { close(room.done) })
}

func (r *Relay) getOrCreateRoom(name string) (*Room, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if room, ok := r.rooms[name]; ok {
		room.touchActivityLocked()
		return room, nil
	}
	if len(r.rooms) >= cfg.Server.MaxRooms {
		return nil, errTooManyRooms
	}
	now := time.Now()
	room := &Room{
		name:         name,
		createdAt:    now,
		lastActivity: now,
		ready:        make(chan struct{}),
		done:         make(chan struct{}),
	}
	r.rooms[name] = room
	return room, nil
}

func (r *Relay) deleteRoom(name string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	log.Printf("[relay] delete room '%s'", name)
	delete(r.rooms, name)
}

// expire closes connections and unblocks any waiter on room.ready.
// Does not write to connections (avoids concurrent WriteMessage with pipeConnections).
func (room *Room) expire(reason string) {
	room.mu.Lock()
	defer room.mu.Unlock()

	room.closeReady()

	if room.first != nil {
		room.first.Close()
		room.first = nil
	}
	if room.second != nil {
		room.second.Close()
		room.second = nil
	}
	_ = reason
}

func (r *Relay) cleanupLoop() {
	ticker := time.NewTicker(5 * time.Minute)
	inactivity := time.Duration(cfg.Server.RoomInactivityMins) * time.Minute
	for range ticker.C {
		var stale []*Room
		r.mu.Lock()
		for name, room := range r.rooms {
			room.mu.Lock()
			last := room.lastActivity
			room.mu.Unlock()
			if time.Since(last) > inactivity {
				log.Printf("[relay] cleanup stale room '%s'", name)
				delete(r.rooms, name)
				stale = append(stale, room)
			}
		}
		r.mu.Unlock()

		for _, room := range stale {
			room.expire("Room expired due to inactivity")
			room.closeDone()
		}
	}
}

func watchFirstClientDisconnect(conn *websocket.Conn, room *Room, ctx context.Context) {
	// Use CloseHandler only — never ReadMessage here; pipeConnections owns the reader.
	conn.SetCloseHandler(func(code int, text string) error {
		if ctx.Err() != nil {
			return nil
		}
		log.Printf("[relay] room '%s': first client disconnected (code=%d)", room.name, code)
		room.expire("Peer disconnected")
		room.closeDone()
		return nil
	})
	<-ctx.Done()
}

func pipeConnections(room *Room, roomName string, a, b *websocket.Conn) {
	a.SetReadLimit(maxWSMessageBytes)
	b.SetReadLimit(maxWSMessageBytes)

	var wg sync.WaitGroup
	wg.Add(2)

	log.Printf("[relay] room '%s': both peers connected, piping traffic", roomName)

	forward := func(src, dst *websocket.Conn) {
		defer wg.Done()
		defer dst.Close()
		for {
			msgType, msg, err := src.ReadMessage()
			if err != nil {
				log.Printf("[relay] room '%s': forward read ended: %v", roomName, err)
				return
			}
			room.touchActivity()
			logTransportMode(roomName, msgType, msg)
			if err := dst.WriteMessage(msgType, msg); err != nil {
				log.Printf("[relay] room '%s': forward write failed: %v", roomName, err)
				return
			}
		}
	}

	go forward(a, b)
	go forward(b, a)

	wg.Wait()
}

func handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("Upgrade error: %v", err)
		return
	}
	conn.SetReadLimit(maxWSMessageBytes)

	remoteAddr := conn.RemoteAddr().String()
	log.Printf("[relay] new connection from %s", remoteAddr)

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

	if len(joinMsg.Room) > 128 {
		fullMsg, _ := json.Marshal(RelayMessage{Type: "error", Msg: "Room code too long"})
		conn.WriteMessage(websocket.TextMessage, fullMsg)
		conn.Close()
		return
	}

	if !joinLimit.allow(clientIP(r)) {
		log.Printf("[relay] %s: join rate limit exceeded", remoteAddr)
		fullMsg, _ := json.Marshal(RelayMessage{Type: "error", Msg: "Rate limit exceeded"})
		conn.WriteMessage(websocket.TextMessage, fullMsg)
		conn.Close()
		return
	}

	log.Printf("[relay] %s joining room '%s'", remoteAddr, joinMsg.Room)

	room, err := relay.getOrCreateRoom(joinMsg.Room)
	if err != nil {
		log.Printf("[relay] %s: room limit exceeded", remoteAddr)
		fullMsg, _ := json.Marshal(RelayMessage{Type: "error", Msg: "Server busy, try again later"})
		conn.WriteMessage(websocket.TextMessage, fullMsg)
		conn.Close()
		return
	}
	room.touchActivity()

	room.mu.Lock()

	if room.first == nil {
		room.first = conn
		room.mu.Unlock()

		pairMsg, _ := json.Marshal(RelayMessage{Type: "waiting", Role: "sender"})
		conn.WriteMessage(websocket.TextMessage, pairMsg)

		watchCtx, watchCancel := context.WithCancel(context.Background())
		defer watchCancel()
		go watchFirstClientDisconnect(conn, room, watchCtx)

		<-room.ready
		watchCancel()

		room.mu.Lock()
		first, second := room.first, room.second
		room.mu.Unlock()

		defer room.closeDone()

		if first == nil || second == nil {
			relay.deleteRoom(joinMsg.Room)
			return
		}

		pipeConnections(room, joinMsg.Room, first, second)
		relay.deleteRoom(joinMsg.Room)

	} else if room.second == nil {
		room.second = conn

		pairedFirst, _ := json.Marshal(RelayMessage{Type: "paired", Role: "sender"})
		pairedSecond, _ := json.Marshal(RelayMessage{Type: "paired", Role: "receiver"})
		log.Printf("[relay] room '%s': peers paired, sending paired msgs", joinMsg.Room)

		if room.first != nil {
			room.first.WriteMessage(websocket.TextMessage, pairedFirst)
		}
		room.second.WriteMessage(websocket.TextMessage, pairedSecond)

		room.closeReady()
		room.mu.Unlock()

		select {
		case <-room.done:
		case <-time.After(roomDoneWait):
			log.Printf("[relay] room '%s': second client timed out waiting for transfer", joinMsg.Room)
		}
		relay.deleteRoom(joinMsg.Room)

	} else {
		room.mu.Unlock()
		fullMsg, _ := json.Marshal(RelayMessage{Type: "error", Msg: "Room is full"})
		conn.WriteMessage(websocket.TextMessage, fullMsg)
		conn.Close()
	}
}

func securityMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		if csp := cfg.Security.ContentSecurityPolicy; csp != "" {
			w.Header().Set("Content-Security-Policy", csp)
		}
		// Avoid stale CSP/HTML during local development after config changes.
		if r.URL.Path == "/" || strings.HasSuffix(r.URL.Path, ".html") {
			w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
		}
		if origin := cfg.corsOrigin(r); origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
		}
		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// noCacheStatic 让浏览器每次对静态资源协商验证而非启发式强缓存。
// 无 Cache-Control 时浏览器会按 Last-Modified 启发式缓存 HTML/JS，前端更新后旧文件仍命中缓存不拉新。
func noCacheStatic(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		next.ServeHTTP(w, r)
	})
}

func main() {
	configPath := flag.String("config", "", "path to config.yaml (default: auto-detect)")
	flag.Parse()

	resolved := resolveConfigPath(*configPath)
	var err error
	cfg, err = loadConfig(resolved)
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}
	log.Printf("[relay] loaded config from %s", resolved)

	initUpgrader()
	joinLimit = newIPRateLimiter(cfg.RateLimit.JoinPerMinute, time.Minute, cfg.RateLimit.TrustForwardedIP)
	stunLimit = newIPRateLimiter(cfg.RateLimit.StunCheckPerMinute, time.Minute, cfg.RateLimit.TrustForwardedIP)
	go joinLimit.cleanupLoop(5 * time.Minute)
	go stunLimit.cleanupLoop(5 * time.Minute)

	go relay.cleanupLoop()

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", handleWebSocket)
	mux.HandleFunc("/api/config", handleConfigAPI)
	mux.HandleFunc("/api/stun-check", stunLimit.middleware(handleStunCheck))
	mux.Handle("/", noCacheStatic(http.FileServer(http.Dir("../public"))))

	addr := cfg.Server.Addr
	log.Printf("🐊 Croc-WASM Relay Server starting on %s", addr)
	log.Printf("   WebSocket endpoint: ws://localhost%s/ws", addr)
	log.Printf("   Frontend: http://localhost%s", addr)
	log.Printf("   CORS origins: %v", cfg.CORS.AllowedOrigins)
	log.Printf("   WebSocket origins: %v", cfg.WebSocket.AllowedOrigins)

	srv := &http.Server{
		Addr:              addr,
		Handler:           securityMiddleware(mux),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	if err := srv.ListenAndServe(); err != nil {
		log.Fatal(err)
	}
}
