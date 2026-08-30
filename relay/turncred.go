package main

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"fmt"
	"strings"
	"time"
)

func isTurnURL(urls string) bool {
	return strings.HasPrefix(urls, "turn:") || strings.HasPrefix(urls, "turns:")
}

// generateTurnCredential returns coturn TURN REST API credentials.
// username format: <unix_expiry>:<user_id>
// credential: base64(HMAC-SHA1(secret, username))
func generateTurnCredential(secret, userID string, ttl time.Duration) (username, credential string) {
	if userID == "" {
		userID = "user"
	}
	expiry := time.Now().Add(ttl).Unix()
	username = fmt.Sprintf("%d:%s", expiry, userID)
	mac := hmac.New(sha1.New, []byte(secret))
	mac.Write([]byte(username))
	credential = base64.StdEncoding.EncodeToString(mac.Sum(nil))
	return username, credential
}

func turnCredentialTTL(cfg Config) time.Duration {
	secs := cfg.Turn.CredentialTTLSeconds
	if secs <= 0 {
		return 24 * time.Hour
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
