package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"strings"
	"time"
)

func isTurnURL(urls string) bool {
	return strings.HasPrefix(urls, "turn:") || strings.HasPrefix(urls, "turns:")
}

// generateTurnCredential returns coturn TURN REST API credentials.
// username format: <unix_expiry>:<user_id>:<8 hex random>
// credential: base64(HMAC-SHA1(secret, username))
//
// The random suffix keeps two requests in the same second from sharing a
// credential, so a leaked username/credential pair cannot be replayed for the
// whole TTL window by other clients.
func generateTurnCredential(secret, userID string, ttl time.Duration) (username, credential string) {
	if userID == "" {
		userID = "user"
	}
	suffix := make([]byte, 4)
	if _, err := rand.Read(suffix); err != nil {
		// crypto/rand 失败极罕见；退回纳秒值，仍保证同秒内不重复。
		return generateTurnCredentialWithSuffix(secret, userID, ttl, fmt.Sprintf("%08x", uint32(time.Now().UnixNano())))
	}
	return generateTurnCredentialWithSuffix(secret, userID, ttl, hex.EncodeToString(suffix))
}

func generateTurnCredentialWithSuffix(secret, userID string, ttl time.Duration, suffix string) (username, credential string) {
	expiry := time.Now().Add(ttl).Unix()
	username = fmt.Sprintf("%d:%s:%s", expiry, userID, suffix)
	mac := hmac.New(sha1.New, []byte(secret))
	mac.Write([]byte(username))
	credential = base64.StdEncoding.EncodeToString(mac.Sum(nil))
	return username, credential
}

func turnCredentialTTL(cfg Config) time.Duration {
	secs := cfg.Turn.CredentialTTLSeconds
	if secs <= 0 {
		return 10 * time.Minute
	}
	return time.Duration(secs) * time.Second
}

func turnUserID(cfg Config) string {
	if cfg.Turn.UserID != "" {
		return cfg.Turn.UserID
	}
	return "user"
}

// buildClientIceServers returns ice_servers for GET /api/config.
// TURN entries get ephemeral credentials when turn.auth_secret is set.
func buildClientIceServers(cfg Config) []IceServerConfig {
	out := make([]IceServerConfig, 0, len(cfg.Client.IceServers))
	secret := cfg.Turn.AuthSecret
	ttl := turnCredentialTTL(cfg)
	userID := turnUserID(cfg)

	for _, s := range cfg.Client.IceServers {
		entry := IceServerConfig{URLs: s.URLs}
		if isTurnURL(s.URLs) && secret != "" {
			entry.Username, entry.Credential = generateTurnCredential(secret, userID, ttl)
		} else {
			entry.Username = s.Username
			entry.Credential = s.Credential
		}
		out = append(out, entry)
	}
	return out
}
