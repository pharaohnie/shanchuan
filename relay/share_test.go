package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

const testShareKey = "0123456789abcdef0123456789abcdef"

func initTestShare(t *testing.T, mutate ...func(*ShareConfig)) *ShareStore {
	t.Helper()
	cfg = defaultConfig()
	if len(mutate) > 0 {
		mutate[0](&cfg.Share)
	}
	cfg.Share.Dir = t.TempDir()
	store, err := newShareStore(cfg.Share)
	if err != nil {
		t.Fatalf("newShareStore: %v", err)
	}
	shareStore = store
	shareUploadLimit = newIPRateLimiter(1000, time.Minute, false)
	shareDownloadLimit = newIPRateLimiter(1000, time.Minute, false)
	return store
}

func shareTestMux() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/share", handleShareCreate)
	mux.HandleFunc("PUT /api/share/{id}", handleShareUpload)
	mux.HandleFunc("DELETE /api/share/{id}", handleShareDelete)
	mux.HandleFunc("GET /s/{id}", handleShareDownload)
	return mux
}

func shareCreate(t *testing.T, mux http.Handler, key, name string, size int64) (int, string) {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"name": name, "size": size})
	req := httptest.NewRequest(http.MethodPost, "/api/share", bytes.NewReader(body))
	req.Header.Set("X-Share-Key", key)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	var resp struct {
		ID   string `json:"id"`
		Path string `json:"path"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if rec.Code == http.StatusCreated && resp.Path != "/s/"+resp.ID {
		t.Fatalf("path %q does not match id %q", resp.Path, resp.ID)
	}
	return rec.Code, resp.ID
}

func shareUpload(t *testing.T, mux http.Handler, key, id string, data []byte) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPut, "/api/share/"+id, bytes.NewReader(data))
	req.Header.Set("X-Share-Key", key)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

func shareDownload(t *testing.T, mux http.Handler, method, key, id string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, "/s/"+id, nil)
	req.Header.Set("X-Share-Key", key)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

func mustShareReady(t *testing.T, mux http.Handler, name string, data []byte) string {
	t.Helper()
	code, id := shareCreate(t, mux, testShareKey, name, int64(len(data)))
	if code != http.StatusCreated {
		t.Fatalf("create: got %d", code)
	}
	if rec := shareUpload(t, mux, testShareKey, id, data); rec.Code != http.StatusNoContent {
		t.Fatalf("upload: got %d body=%q", rec.Code, rec.Body.String())
	}
	return id
}

func TestShareUploadAndSingleDownload(t *testing.T) {
	store := initTestShare(t)
	mux := shareTestMux()
	payload := []byte("hello croc over curl")
	id := mustShareReady(t, mux, "report.txt", payload)

	rec := shareDownload(t, mux, http.MethodGet, testShareKey, id)
	if rec.Code != http.StatusOK {
		t.Fatalf("download: got %d", rec.Code)
	}
	if !bytes.Equal(rec.Body.Bytes(), payload) {
		t.Fatalf("body mismatch: %q", rec.Body.Bytes())
	}
	if got := rec.Header().Get("Content-Length"); got != "20" {
		t.Fatalf("content-length: got %q", got)
	}
	if cd := rec.Header().Get("Content-Disposition"); !strings.Contains(cd, "report.txt") {
		t.Fatalf("content-disposition: got %q", cd)
	}
	if rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("download must not be cached")
	}

	if rec := shareDownload(t, mux, http.MethodGet, testShareKey, id); rec.Code != http.StatusNotFound {
		t.Fatalf("second download: got %d, want 404", rec.Code)
	}
	if _, err := os.Stat(filepath.Join(store.dir, id+".bin")); !os.IsNotExist(err) {
		t.Fatalf("staged file should be deleted, stat err=%v", err)
	}
}

func TestShareConcurrentClaimOnlyOneWins(t *testing.T) {
	initTestShare(t)
	mux := shareTestMux()
	data := bytes.Repeat([]byte("x"), 4096)
	id := mustShareReady(t, mux, "big.bin", data)

	results := make(chan int, 2)
	var wg sync.WaitGroup
	wg.Add(2)
	for i := 0; i < 2; i++ {
		go func() {
			defer wg.Done()
			req := httptest.NewRequest(http.MethodGet, "/s/"+id, nil)
			req.Header.Set("X-Share-Key", testShareKey)
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, req)
			results <- rec.Code
		}()
	}
	wg.Wait()
	close(results)

	ok, other := 0, 0
	for c := range results {
		switch c {
		case http.StatusOK:
			ok++
		case http.StatusConflict, http.StatusNotFound:
			// 409 when both claim at once, 404 when the winner finished first.
			other++
		}
	}
	if ok != 1 || other != 1 {
		t.Fatalf("expected exactly one successful download, got ok=%d other=%d", ok, other)
	}
}

func TestShareHeadDoesNotConsume(t *testing.T) {
	initTestShare(t)
	mux := shareTestMux()
	data := []byte("head test")
	id := mustShareReady(t, mux, "h.bin", data)

	for i := 0; i < 3; i++ {
		rec := shareDownload(t, mux, http.MethodHead, testShareKey, id)
		if rec.Code != http.StatusOK {
			t.Fatalf("head %d: got %d", i, rec.Code)
		}
		if rec.Body.Len() != 0 {
			t.Fatalf("head %d returned a body", i)
		}
		if rec.Header().Get("Content-Length") != "9" {
			t.Fatalf("head content-length: %q", rec.Header().Get("Content-Length"))
		}
	}
	if rec := shareDownload(t, mux, http.MethodGet, testShareKey, id); rec.Code != http.StatusOK {
		t.Fatalf("get after head: got %d", rec.Code)
	}
}

// flakyWriter fails mid-body to simulate an interrupted download.
type flakyWriter struct {
	header http.Header
	code   int
	budget int
}

func (f *flakyWriter) Header() http.Header { return f.header }
func (f *flakyWriter) WriteHeader(c int)   { f.code = c }
func (f *flakyWriter) Write(p []byte) (int, error) {
	if len(p) > f.budget {
		return 0, errors.New("client went away")
	}
	f.budget -= len(p)
	return len(p), nil
}

func TestShareDownloadInterruptThenRetry(t *testing.T) {
	initTestShare(t)
	mux := shareTestMux()
	data := bytes.Repeat([]byte("abcdefgh"), 1000)
	id := mustShareReady(t, mux, "retry.bin", data)

	req := httptest.NewRequest(http.MethodGet, "/s/"+id, nil)
	req.Header.Set("X-Share-Key", testShareKey)
	bad := &flakyWriter{header: make(http.Header), budget: 100}
	mux.ServeHTTP(bad, req)
	if bad.code != http.StatusOK {
		t.Fatalf("interrupted download: got %d", bad.code)
	}
	if len(shareStore.items) != 1 || shareStore.items[id].State != shareReady {
		t.Fatal("interrupted download should roll back to ready")
	}

	rec := shareDownload(t, mux, http.MethodGet, testShareKey, id)
	if rec.Code != http.StatusOK || !bytes.Equal(rec.Body.Bytes(), data) {
		t.Fatalf("retry: got %d len=%d", rec.Code, rec.Body.Len())
	}
}

func TestShareUploadingReturns503NoClaim(t *testing.T) {
	initTestShare(t)
	mux := shareTestMux()
	data := []byte("still uploading")
	code, id := shareCreate(t, mux, testShareKey, "pending.bin", int64(len(data)))
	if code != http.StatusCreated {
		t.Fatalf("create: %d", code)
	}

	rec := shareDownload(t, mux, http.MethodGet, testShareKey, id)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 while uploading, got %d", rec.Code)
	}
	if rec.Header().Get("Retry-After") != "2" {
		t.Fatalf("retry-after: %q", rec.Header().Get("Retry-After"))
	}
	if shareStore.items[id].State != shareUploading {
		t.Fatal("503 must not claim the share")
	}

	if rec := shareUpload(t, mux, testShareKey, id, data); rec.Code != http.StatusNoContent {
		t.Fatalf("upload: %d", rec.Code)
	}
	if rec := shareDownload(t, mux, http.MethodGet, testShareKey, id); rec.Code != http.StatusOK {
		t.Fatalf("download after 503: %d", rec.Code)
	}
}

func TestShareTooLarge(t *testing.T) {
	initTestShare(t, func(c *ShareConfig) { c.MaxBytes = 16 })
	mux := shareTestMux()
	if code, _ := shareCreate(t, mux, testShareKey, "big.bin", 32); code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413, got %d", code)
	}
}

func TestShareMissingContentLength(t *testing.T) {
	initTestShare(t)
	mux := shareTestMux()
	code, id := shareCreate(t, mux, testShareKey, "x.bin", 4)
	if code != http.StatusCreated {
		t.Fatalf("create: %d", code)
	}
	req := httptest.NewRequest(http.MethodPut, "/api/share/"+id, bytes.NewReader([]byte("abcd")))
	req.Header.Set("X-Share-Key", testShareKey)
	req.ContentLength = 0
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusLengthRequired {
		t.Fatalf("expected 411, got %d", rec.Code)
	}
}

func TestShareWrongKeyIsUniform404(t *testing.T) {
	initTestShare(t)
	mux := shareTestMux()
	id := mustShareReady(t, mux, "secret.txt", []byte("data"))

	wrongKey := shareDownload(t, mux, http.MethodGet, strings.Repeat("ff", 16), id)
	unknownID := shareDownload(t, mux, http.MethodGet, testShareKey, strings.Repeat("aa", 16))
	badKey := shareDownload(t, mux, http.MethodGet, "not-a-key", id)

	for name, rec := range map[string]*httptest.ResponseRecorder{
		"wrong key":  wrongKey,
		"unknown id": unknownID,
		"bad key":    badKey,
	} {
		if rec.Code != http.StatusNotFound {
			t.Fatalf("%s: got %d, want 404", name, rec.Code)
		}
		if rec.Body.String() != wrongKey.Body.String() {
			t.Fatalf("%s: body %q differs from %q", name, rec.Body.String(), wrongKey.Body.String())
		}
	}
	if rec := shareDownload(t, mux, http.MethodGet, testShareKey, id); rec.Code != http.StatusOK {
		t.Fatalf("failed attempts must not consume the share, got %d", rec.Code)
	}
}

func TestShareQuotaReserved(t *testing.T) {
	initTestShare(t, func(c *ShareConfig) {
		c.MaxReservedBytes = 10
		c.MaxTotalBytes = 10
	})
	mux := shareTestMux()
	if code, _ := shareCreate(t, mux, testShareKey, "a.bin", 10); code != http.StatusCreated {
		t.Fatalf("first create: %d", code)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/share", strings.NewReader(`{"name":"b.bin","size":10}`))
	req.Header.Set("X-Share-Key", testShareKey)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 when reserved budget is full, got %d", rec.Code)
	}
	if rec.Header().Get("Retry-After") == "" {
		t.Fatal("quota rejections should advertise Retry-After")
	}
}

func TestShareTTLExpiry(t *testing.T) {
	store := initTestShare(t)
	mux := shareTestMux()
	id := mustShareReady(t, mux, "old.bin", []byte("old"))

	store.mu.Lock()
	store.items[id].ReadyAt = time.Now().Add(-25 * time.Hour)
	store.mu.Unlock()

	if rec := shareDownload(t, mux, http.MethodGet, testShareKey, id); rec.Code != http.StatusNotFound {
		t.Fatalf("expired share: got %d", rec.Code)
	}
	store.sweep(time.Now())
	if _, err := os.Stat(filepath.Join(store.dir, id+".bin")); !os.IsNotExist(err) {
		t.Fatalf("sweep should delete expired file, err=%v", err)
	}
	if len(store.items) != 0 {
		t.Fatalf("sweep should drop the item, have %d", len(store.items))
	}
	if store.total != 0 || store.reserved != 0 {
		t.Fatalf("accounting leak: total=%d reserved=%d", store.total, store.reserved)
	}
}

func TestShareDelete(t *testing.T) {
	store := initTestShare(t)
	mux := shareTestMux()
	id := mustShareReady(t, mux, "gone.bin", []byte("bye"))

	req := httptest.NewRequest(http.MethodDelete, "/api/share/"+id, nil)
	req.Header.Set("X-Share-Key", testShareKey)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete: %d", rec.Code)
	}
	if rec := shareDownload(t, mux, http.MethodGet, testShareKey, id); rec.Code != http.StatusNotFound {
		t.Fatalf("after delete: %d", rec.Code)
	}
	if _, err := os.Stat(filepath.Join(store.dir, id+".bin")); !os.IsNotExist(err) {
		t.Fatal("delete should remove the staged file")
	}
	if store.total != 0 {
		t.Fatalf("delete leaked quota: %d", store.total)
	}
}

func TestShareDeleteRejectsWrongKey(t *testing.T) {
	initTestShare(t)
	mux := shareTestMux()
	id := mustShareReady(t, mux, "keep.bin", []byte("keep"))

	req := httptest.NewRequest(http.MethodDelete, "/api/share/"+id, nil)
	req.Header.Set("X-Share-Key", strings.Repeat("ff", 16))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("delete with wrong key: %d", rec.Code)
	}
	if rec := shareDownload(t, mux, http.MethodGet, testShareKey, id); rec.Code != http.StatusOK {
		t.Fatal("wrong-key delete must not remove the share")
	}
}

func TestShareFilenameSanitization(t *testing.T) {
	cases := map[string]string{
		"../../etc/passwd":       "passwd",
		"dir\\file.txt":          "file.txt",
		"  spaced.txt  ":         "spaced.txt",
		"trailing...":            "trailing",
		"bad\x00name\x1f.txt":    "badname.txt",
		"":                       "download",
		"..":                     "download",
		"CON":                    "download",
		"con.txt":                "con.txt",
		"report 2024.pdf":        "report 2024.pdf",
		strings.Repeat("a", 300): strings.Repeat("a", 255),
	}
	for in, want := range cases {
		if got := sanitizeDownloadFilename(in); got != want {
			t.Fatalf("sanitize(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestShareLogsDoNotLeakSecrets(t *testing.T) {
	initTestShare(t)
	mux := shareTestMux()

	var buf bytes.Buffer
	log.SetOutput(&buf)
	defer log.SetOutput(os.Stderr)

	id := mustShareReady(t, mux, "private-name.txt", []byte("data"))
	shareDownload(t, mux, http.MethodGet, testShareKey, id)

	out := buf.String()
	if strings.Contains(strings.ToLower(out), testShareKey) {
		t.Fatalf("logs leaked the share key: %s", out)
	}
	if strings.Contains(out, "private-name.txt") {
		t.Fatalf("logs leaked the filename: %s", out)
	}
	if !strings.Contains(out, id[:6]) {
		t.Fatalf("logs should carry a short id prefix: %s", out)
	}
}

func TestShareSlowDownloadKeepsIntegrity(t *testing.T) {
	initTestShare(t)
	mux := shareTestMux()
	data := bytes.Repeat([]byte("0123456789abcdef"), 65536) // 1 MiB
	want := sha256.Sum256(data)
	id := mustShareReady(t, mux, "slow.bin", data)

	server := httptest.NewServer(mux)
	defer server.Close()

	req, err := http.NewRequest(http.MethodGet, server.URL+"/s/"+id, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("X-Share-Key", testShareKey)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK || resp.ContentLength != int64(len(data)) {
		t.Fatalf("status=%d content-length=%d", resp.StatusCode, resp.ContentLength)
	}
	got := sha256.New()
	buf := make([]byte, 8*1024)
	for {
		n, err := resp.Body.Read(buf)
		if n > 0 {
			got.Write(buf[:n])
			time.Sleep(time.Millisecond)
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("read: %v", err)
		}
	}
	if !bytes.Equal(got.Sum(nil), want[:]) {
		t.Fatal("slow download corrupted the payload")
	}
	if rec := shareDownload(t, mux, http.MethodGet, testShareKey, id); rec.Code != http.StatusNotFound {
		t.Fatalf("slow download should consume the share, got %d", rec.Code)
	}
}
