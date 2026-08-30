package main

import (
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"

	"gopkg.in/yaml.v3"
)

// Config holds relay server settings loaded from config.yaml.
type Config struct {
	Server    ServerConfig    `yaml:"server"`
	CORS      CORSConfig      `yaml:"cors"`
	WebSocket WebSocketConfig `yaml:"websocket"`
	Client    ClientConfig    `yaml:"client"`
	RateLimit RateLimitConfig `yaml:"rate_limit"`
	Security  SecurityConfig  `yaml:"security"`
}

type ServerConfig struct {
	Addr                 string `yaml:"addr"`
	MaxRooms             int    `yaml:"max_rooms"`
	RoomInactivityMins   int    `yaml:"room_inactivity_minutes"`
}

type CORSConfig struct {
	AllowedOrigins []string `yaml:"allowed_origins"`
}

type WebSocketConfig struct {
	AllowedOrigins []string `yaml:"allowed_origins"`
}

type ClientConfig struct {
	RelayURL string `yaml:"relay_url"`
}

type RateLimitConfig struct {
	JoinPerMinute      int      `yaml:"join_per_minute"`
	StunCheckPerMinute int      `yaml:"stun_check_per_minute"`
	TrustForwardedIP   bool     `yaml:"trust_forwarded_ip"`
	TrustedProxyCIDRs  []string `yaml:"trusted_proxy_cidrs"`
}

type SecurityConfig struct {
	ContentSecurityPolicy string `yaml:"content_security_policy"`
}

// ClientAPIResponse is returned by GET /api/config (public fields only).
type ClientAPIResponse struct {
	RelayURL string `json:"relay_url"`
}

var trustedProxyNets []*net.IPNet

func defaultConfig() Config {
	return Config{
		Server: ServerConfig{
			Addr:               ":8154",
			MaxRooms:           1000,
			RoomInactivityMins: 30,
		},
		CORS: CORSConfig{
			AllowedOrigins: []string{"http://localhost:8154"},
		},
		WebSocket: WebSocketConfig{
			AllowedOrigins: []string{"http://localhost:8154"},
		},
		Client: ClientConfig{RelayURL: ""},
		RateLimit: RateLimitConfig{
			JoinPerMinute:      30,
			StunCheckPerMinute: 10,
		},
	}
}

func loadConfig(path string) (Config, error) {
	cfg := defaultConfig()
	data, err := os.ReadFile(path)
	if err != nil {
		return cfg, fmt.Errorf("read config %q: %w", path, err)
	}
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return cfg, fmt.Errorf("parse config %q: %w", path, err)
	}
	if cfg.Server.Addr == "" {
		cfg.Server.Addr = ":8154"
	}
	if cfg.Server.MaxRooms <= 0 {
		cfg.Server.MaxRooms = 1000
	}
	if cfg.Server.RoomInactivityMins <= 0 {
		cfg.Server.RoomInactivityMins = 30
	}
	if len(cfg.CORS.AllowedOrigins) == 0 {
		cfg.CORS.AllowedOrigins = []string{"http://localhost:8154"}
	}
	if len(cfg.WebSocket.AllowedOrigins) == 0 {
		cfg.WebSocket.AllowedOrigins = cfg.CORS.AllowedOrigins
	}
	if cfg.RateLimit.JoinPerMinute <= 0 {
		cfg.RateLimit.JoinPerMinute = 30
	}
	if cfg.RateLimit.StunCheckPerMinute <= 0 {
		cfg.RateLimit.StunCheckPerMinute = 10
	}
	trustedProxyNets, err = parseTrustedProxyCIDRs(cfg.RateLimit.TrustedProxyCIDRs)
	if err != nil {
		return cfg, fmt.Errorf("parse trusted_proxy_cidrs: %w", err)
	}
	return cfg, nil
}

func parseTrustedProxyCIDRs(cidrs []string) ([]*net.IPNet, error) {
	if len(cidrs) == 0 {
		return nil, nil
	}
	nets := make([]*net.IPNet, 0, len(cidrs))
	for _, cidr := range cidrs {
		_, n, err := net.ParseCIDR(strings.TrimSpace(cidr))
		if err != nil {
			return nil, fmt.Errorf("invalid CIDR %q: %w", cidr, err)
		}
		nets = append(nets, n)
	}
	return nets, nil
}

func isTrustedProxy(remoteAddr string) bool {
	if len(trustedProxyNets) == 0 {
		return false
	}
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	for _, n := range trustedProxyNets {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

func (cfg Config) originAllowed(allowed []string, origin string) bool {
	if len(allowed) == 0 {
		return false
	}
	for _, o := range allowed {
		if o == "*" {
			return true
		}
		if o == origin {
			return true
		}
	}
	return false
}

func (cfg Config) corsOrigin(r *http.Request) string {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return ""
	}
	if cfg.originAllowed(cfg.CORS.AllowedOrigins, origin) {
		return origin
	}
	return ""
}

func (cfg Config) websocketOriginAllowed(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	// Non-browser clients may omit Origin.
	if origin == "" {
		return true
	}
	return cfg.originAllowed(cfg.WebSocket.AllowedOrigins, origin)
}

func resolveConfigPath(flagPath string) string {
	if flagPath != "" {
		return flagPath
	}
	candidates := []string{"../config.yaml", "config.yaml", "./config.yaml"}
	for _, p := range candidates {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return "../config.yaml"
}

func truncateForLog(s string, max int) string {
	s = strings.TrimSpace(s)
	s = strings.Map(func(r rune) rune {
		if r < 32 || r == 127 {
			return '?'
		}
		return r
	}, s)
	if len(s) <= max {
		return s
	}
	return s[:max] + "..."
}
