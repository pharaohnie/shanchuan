package main

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// ipRateLimiter tracks per-IP request counts in a sliding minute window.
type ipRateLimiter struct {
	mu               sync.Mutex
	limit            int
	window           time.Duration
	trustForwardedIP bool
	counters         map[string]*rateCounter
}

type rateCounter struct {
	count   int
	resetAt time.Time
}

// ipConnLimiter caps concurrent connections per IP. acquire must be paired
// with release on every return path that follows a successful acquire.
type ipConnLimiter struct {
	mu     sync.Mutex
	limit  int
	counts map[string]int
}

func newIPConnLimiter(limit int) *ipConnLimiter {
	return &ipConnLimiter{limit: limit, counts: make(map[string]int)}
}

func (l *ipConnLimiter) acquire(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.limit > 0 && l.counts[key] >= l.limit {
		return false
	}
	l.counts[key]++
	return true
}

func (l *ipConnLimiter) release(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.counts[key] <= 1 {
		delete(l.counts, key)
		return
	}
	l.counts[key]--
}

func newIPRateLimiter(limit int, window time.Duration, trustForwardedIP bool) *ipRateLimiter {
	return &ipRateLimiter{
		limit:            limit,
		window:           window,
		trustForwardedIP: trustForwardedIP,
		counters:         make(map[string]*rateCounter),
	}
}

func clientIP(r *http.Request) string {
	return clientIPWithTrust(r, cfg.RateLimit.TrustForwardedIP)
}

func clientIPWithTrust(r *http.Request, trustForwardedIP bool) string {
	if trustForwardedIP && isTrustedProxy(r.RemoteAddr) {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			// 从右往左扫：反代通常把真实客户端追加在末尾，左边是客户端
			// 可伪造的前缀。跳过可信代理，返回第一个不可信地址。
			parts := strings.Split(xff, ",")
			for i := len(parts) - 1; i >= 0; i-- {
				ip := strings.TrimSpace(parts[i])
				if ip == "" || isTrustedProxyIP(ip) {
					continue
				}
				return ip
			}
		}
		if xri := strings.TrimSpace(r.Header.Get("X-Real-IP")); xri != "" {
			return xri
		}
	}

	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func (rl *ipRateLimiter) allow(key string) bool {
	now := time.Now()
	rl.mu.Lock()
	defer rl.mu.Unlock()

	c, ok := rl.counters[key]
	if !ok || now.After(c.resetAt) {
		rl.counters[key] = &rateCounter{count: 1, resetAt: now.Add(rl.window)}
		return true
	}
	if c.count >= rl.limit {
		return false
	}
	c.count++
	return true
}

func (rl *ipRateLimiter) middleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ip := clientIP(r)
		if !rl.allow(ip) {
			http.Error(w, "rate limit exceeded", http.StatusTooManyRequests)
			return
		}
		next(w, r)
	}
}

func (rl *ipRateLimiter) cleanupLoop(interval time.Duration) {
	ticker := time.NewTicker(interval)
	for range ticker.C {
		now := time.Now()
		rl.mu.Lock()
		for key, c := range rl.counters {
			if now.After(c.resetAt) {
				delete(rl.counters, key)
			}
		}
		rl.mu.Unlock()
	}
}
