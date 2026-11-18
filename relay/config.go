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
	Turn      TurnConfig      `yaml:"turn"`
	RateLimit RateLimitConfig `yaml:"rate_limit"`
	Security  SecurityConfig  `yaml:"security"`
	Share     ShareConfig     `yaml:"share"`
}

type ServerConfig struct {
	Addr               string `yaml:"addr"`
	MaxRooms           int    `yaml:"max_rooms"`
	RoomInactivityMins int    `yaml:"room_inactivity_minutes"`
}

type CORSConfig struct {
	AllowedOrigins []string `yaml:"allowed_origins"`
}

type WebSocketConfig struct {
	AllowedOrigins     []string `yaml:"allowed_origins"`
	JoinTimeoutSeconds int      `yaml:"join_timeout_seconds"`
}

type IceServerConfig struct {
	URLs       string `yaml:"urls" json:"urls"`
	Username   string `yaml:"username,omitempty" json:"username,omitempty"`
	Credential string `yaml:"credential,omitempty" json:"credential,omitempty"`
}

type ClientConfig struct {
	RelayURL   string            `yaml:"relay_url"`
	PublicURL  string            `yaml:"public_url"`
	IceServers []IceServerConfig `yaml:"ice_servers"`
}

type TurnConfig struct {
	AuthSecret           string `yaml:"auth_secret"`
	CredentialTTLSeconds int    `yaml:"credential_ttl_seconds"`
	UserID               string `yaml:"user_id"`
}

type RateLimitConfig struct {
	JoinPerMinute      int      `yaml:"join_per_minute"`
	StunCheckPerMinute int      `yaml:"stun_check_per_minute"`
	ConfigPerMinute    int      `yaml:"config_per_minute"`
	MaxWSConnsPerIP    int      `yaml:"max_ws_conns_per_ip"`
	TrustForwardedIP   bool     `yaml:"trust_forwarded_ip"`
	TrustedProxyCIDRs  []string `yaml:"trusted_proxy_cidrs"`
}

type SecurityConfig struct {
	ContentSecurityPolicy string `yaml:"content_security_policy"`
}

// ShareConfig controls the optional one-shot staging area used by curl downloads.
// Files are stored in plaintext and deleted after a single successful download.
type ShareConfig struct {
	Enabled             bool   `yaml:"enabled"`
	Dir                 string `yaml:"dir"`
	MaxBytes            int64  `yaml:"max_bytes"`
	MaxTotalBytes       int64  `yaml:"max_total_bytes"`
	MaxReservedBytes    int64  `yaml:"max_reserved_bytes"`
	TTLMinutes          int    `yaml:"ttl_minutes"`
	UploadWindowSeconds int    `yaml:"upload_window_seconds"`
	UploadStallSeconds  int    `yaml:"upload_stall_seconds"`
	UploadPerMinute     int    `yaml:"upload_per_minute"`
	DownloadPerMinute   int    `yaml:"download_per_minute"`
	MaxFailPerShare     int    `yaml:"max_fail_per_share"`
}

// ClientAPIResponse is returned by GET /api/config (public fields only).
type ClientAPIResponse struct {
	RelayURL      string            `json:"relay_url"`
	PublicURL     string            `json:"public_url"`
	IceServers    []IceServerConfig `json:"ice_servers,omitempty"`
	ShareEnabled  bool              `json:"share_enabled"`
	ShareMaxBytes int64             `json:"share_max_bytes"`
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
			AllowedOrigins:     []string{"http://localhost:8154"},
			JoinTimeoutSeconds: 10,
		},
		Client: ClientConfig{RelayURL: "", PublicURL: ""},
		RateLimit: RateLimitConfig{
			JoinPerMinute:      30,
			StunCheckPerMinute: 10,
			ConfigPerMinute:    60,
			MaxWSConnsPerIP:    8,
		},
		Share: ShareConfig{
			Enabled:             false,
			MaxBytes:            512 << 20,
			MaxTotalBytes:       10 << 30,
			MaxReservedBytes:    2 << 30,
			TTLMinutes:          1440,
			UploadWindowSeconds: 3600,
			UploadStallSeconds:  60,
			UploadPerMinute:     10,
			DownloadPerMinute:   60,
			MaxFailPerShare:     5,
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
	if cfg.RateLimit.ConfigPerMinute <= 0 {
		cfg.RateLimit.ConfigPerMinute = 60
	}
	if cfg.RateLimit.MaxWSConnsPerIP <= 0 {
		cfg.RateLimit.MaxWSConnsPerIP = 8
	}
	if cfg.WebSocket.JoinTimeoutSeconds <= 0 {
		cfg.WebSocket.JoinTimeoutSeconds = 10
	}
	if cfg.Turn.CredentialTTLSeconds <= 0 {
		cfg.Turn.CredentialTTLSeconds = 600
	}
	if cfg.Share.MaxBytes <= 0 {
		cfg.Share.MaxBytes = 512 << 20
	}
	const shareMaxFileBytes = 2 << 30 // matches MAX_FILE_BYTES in public/security.js
	if cfg.Share.MaxBytes > shareMaxFileBytes {
		cfg.Share.MaxBytes = shareMaxFileBytes
	}
	if cfg.Share.MaxTotalBytes <= 0 {
		cfg.Share.MaxTotalBytes = 10 << 30
	}
	if cfg.Share.MaxReservedBytes <= 0 {
		cfg.Share.MaxReservedBytes = 2 << 30
	}
	if cfg.Share.MaxReservedBytes > cfg.Share.MaxTotalBytes {
		cfg.Share.MaxReservedBytes = cfg.Share.MaxTotalBytes
	}
	if cfg.Share.TTLMinutes <= 0 {
		cfg.Share.TTLMinutes = 1440
	}
	if cfg.Share.UploadWindowSeconds <= 0 {
		cfg.Share.UploadWindowSeconds = 3600
	}
	if cfg.Share.UploadStallSeconds <= 0 {
		cfg.Share.UploadStallSeconds = 60
	}
	if cfg.Share.UploadPerMinute <= 0 {
		cfg.Share.UploadPerMinute = 10
	}
	if cfg.Share.DownloadPerMinute <= 0 {
		cfg.Share.DownloadPerMinute = 60
	}
	if cfg.Share.MaxFailPerShare <= 0 {
		cfg.Share.MaxFailPerShare = 5
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
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr
	}
	return isTrustedProxyIP(host)
}

func isTrustedProxyIP(host string) bool {
	if len(trustedProxyNets) == 0 {
		return false
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
