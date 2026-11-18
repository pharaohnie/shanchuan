// One-shot staging area for curl downloads.
//
// The relay never sees the passcode: the browser sends a random 16-byte
// shareKey unrelated to the room, and this server keeps only
// HMAC(pepper, shareKey). Staged files are plaintext on disk and are deleted
// after one successful download.
package main

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	shareUploading shareState = iota
	shareReady
	shareClaimed
)

const (
	shareClaimTimeout    = 35 * time.Minute
	shareWriteDeadline   = 30 * time.Minute
	shareFailLockTimeout = 5 * time.Minute
	shareOrphanGrace     = 2 * time.Minute
	shareCopyChunk       = 1 << 20
)

var (
	errShareNotFound  = errors.New("share not found")
	errShareUploading = errors.New("share still uploading")
	errShareClaimed   = errors.New("share claimed")
	errShareLocked    = errors.New("share locked")
	errShareExpired   = errors.New("share expired")
	errShareBusy      = errors.New("share busy")
	errShareQuota     = errors.New("share quota exceeded")
	errShareTooLarge  = errors.New("share too large")
	errShareLength    = errors.New("share length required")
)

type shareState int

type ShareItem struct {
	ID           string
	Filename     string
	Path         string
	Size         int64
	KeyHash      [32]byte
	State        shareState
	CreatedAt    time.Time
	ReadyAt      time.Time
	ClaimedAt    time.Time
	FailCount    int
	LockedUntil  time.Time
	LastProgress time.Time
	Reserved     int64
	uploading    bool
}

// ShareStore owns the staging directory and the state machine
// uploading -> ready -> claimed -> deleted. Files are never touched while the
// mutex is held, so a slow disk cannot block other requests.
type ShareStore struct {
	mu       sync.Mutex
	items    map[string]*ShareItem
	total    int64 // bytes held by ready/claimed items
	reserved int64 // bytes held by uploading items
	dir      string
	pepper   []byte
	cfg      ShareConfig
}

func newShareStore(cfg ShareConfig) (*ShareStore, error) {
	dir := cfg.Dir
	if dir == "" {
		dir = filepath.Join(os.TempDir(), "croc-share")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	// MkdirAll 会跟随符号链接；这里显式拒绝，避免暂存目录被指向 public/ 等位置。
	info, err := os.Lstat(dir)
	if err != nil {
		return nil, err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("share dir %q must not be a symlink", dir)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("share dir %q is not a directory", dir)
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return nil, err
	}
	pepper := make([]byte, 32)
	if _, err := rand.Read(pepper); err != nil {
		return nil, err
	}
	s := &ShareStore{
		items:  make(map[string]*ShareItem),
		dir:    dir,
		pepper: pepper,
		cfg:    cfg,
	}
	// Single-instance assumption: anything left in the directory is stale.
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		// 只删除本服务生成的暂存文件，目录里的其它内容一律不动。
		if !isShareStagingName(e.Name()) {
			continue
		}
		if err := os.Remove(filepath.Join(dir, e.Name())); err != nil {
			log.Printf("[share] cleanup %s failed: %v", e.Name(), err)
		}
	}
	return s, nil
}

func (s *ShareStore) keyHashFromHeader(header string) ([32]byte, bool) {
	var out [32]byte
	h := strings.ToLower(strings.TrimSpace(header))
	if len(h) != 32 {
		return out, false
	}
	raw, err := hex.DecodeString(h)
	if err != nil {
		return out, false
	}
	mac := hmac.New(sha256.New, s.pepper)
	mac.Write(raw)
	copy(out[:], mac.Sum(nil))
	return out, true
}

func validShareID(id string) bool {
	if len(id) != 32 {
		return false
	}
	for _, c := range id {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

func newShareID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func (s *ShareStore) create(name string, size int64, keyHash [32]byte) (*ShareItem, error) {
	if size > s.cfg.MaxBytes {
		return nil, errShareTooLarge
	}
	id, err := newShareID()
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	// 不按声明大小预留：配额在实际上传写入时逐块占用，
	// 避免空 POST 用声明大小冻结配额。
	if s.total+s.reserved >= s.cfg.MaxTotalBytes || s.reserved >= s.cfg.MaxReservedBytes {
		return nil, errShareQuota
	}
	now := time.Now()
	item := &ShareItem{
		ID:           id,
		Filename:     name,
		Path:         filepath.Join(s.dir, id+".bin"),
		Size:         size,
		KeyHash:      keyHash,
		State:        shareUploading,
		CreatedAt:    now,
		LastProgress: now,
	}
	s.items[id] = item
	return item, nil
}

// reserveBytes accounts for bytes actually written. It is called before each
// write so a stalled or lying client cannot occupy more than the configured
// reservation budget.
func (s *ShareStore) reserveBytes(id string, n int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	item, ok := s.items[id]
	if !ok || item.State != shareUploading {
		return errShareNotFound
	}
	if s.reserved+n > s.cfg.MaxReservedBytes || s.total+s.reserved+n > s.cfg.MaxTotalBytes {
		return errShareQuota
	}
	s.reserved += n
	item.Reserved += n
	item.LastProgress = time.Now()
	return nil
}

// copyUpload streams the request body into dst in bounded chunks, reserving
// quota as bytes arrive.
func (s *ShareStore) copyUpload(dst io.Writer, src io.Reader, id string) (int64, error) {
	buf := make([]byte, shareCopyChunk)
	var written int64
	for {
		nr, rerr := src.Read(buf)
		if nr > 0 {
			if err := s.reserveBytes(id, int64(nr)); err != nil {
				return written, err
			}
			nw, werr := dst.Write(buf[:nr])
			written += int64(nw)
			if werr != nil {
				return written, werr
			}
			if nw != nr {
				return written, io.ErrShortWrite
			}
		}
		if rerr == io.EOF {
			return written, nil
		}
		if rerr != nil {
			return written, rerr
		}
	}
}

// beginUpload validates a PUT and reserves the single writer for this item.
func (s *ShareStore) beginUpload(id string, keyHash [32]byte, contentLength int64) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	item, ok := s.items[id]
	if !ok || !hmac.Equal(item.KeyHash[:], keyHash[:]) {
		return 0, errShareNotFound
	}
	if item.State != shareUploading {
		return 0, errShareClaimed
	}
	if time.Since(item.CreatedAt) > time.Duration(s.cfg.UploadWindowSeconds)*time.Second {
		return 0, errShareExpired
	}
	if contentLength <= 0 {
		return 0, errShareLength
	}
	if contentLength > item.Size {
		return 0, errShareTooLarge
	}
	if contentLength != item.Size {
		return 0, errShareLength
	}
	if item.uploading {
		return 0, errShareBusy
	}
	item.uploading = true
	item.LastProgress = time.Now()
	return item.Size, nil
}

func (s *ShareStore) uploadFailed(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if item, ok := s.items[id]; ok {
		item.uploading = false
		s.reserved -= item.Reserved
		item.Reserved = 0
		if s.reserved < 0 {
			s.reserved = 0
		}
	}
}

func (s *ShareStore) markReady(id string, keyHash [32]byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	item, ok := s.items[id]
	if !ok || !hmac.Equal(item.KeyHash[:], keyHash[:]) {
		return errShareNotFound
	}
	if item.State != shareUploading {
		return errShareClaimed
	}
	item.uploading = false
	item.State = shareReady
	item.ReadyAt = time.Now()
	s.reserved -= item.Reserved
	item.Reserved = 0
	if s.reserved < 0 {
		s.reserved = 0
	}
	s.total += item.Size
	return nil
}

func (s *ShareStore) peek(id string, keyHash [32]byte) (*ShareItem, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	item, ok := s.items[id]
	if !ok || !hmac.Equal(item.KeyHash[:], keyHash[:]) {
		return nil, errShareNotFound
	}
	switch item.State {
	case shareUploading:
		return nil, errShareUploading
	case shareClaimed:
		return nil, errShareClaimed
	}
	if time.Since(item.ReadyAt) > time.Duration(s.cfg.TTLMinutes)*time.Minute {
		return nil, errShareNotFound
	}
	if time.Now().Before(item.LockedUntil) {
		return nil, errShareLocked
	}
	return item, nil
}

func (s *ShareStore) claim(id string, keyHash [32]byte) (*ShareItem, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	item, ok := s.items[id]
	if !ok || !hmac.Equal(item.KeyHash[:], keyHash[:]) {
		return nil, errShareNotFound
	}
	switch item.State {
	case shareUploading:
		return nil, errShareUploading
	case shareClaimed:
		return nil, errShareClaimed
	}
	if time.Since(item.ReadyAt) > time.Duration(s.cfg.TTLMinutes)*time.Minute {
		return nil, errShareNotFound
	}
	if time.Now().Before(item.LockedUntil) {
		return nil, errShareLocked
	}
	item.State = shareClaimed
	item.ClaimedAt = time.Now()
	return item, nil
}

// release returns a claimed item to ready (or locks it after repeated failures).
func (s *ShareStore) release(id string, failed bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	item, ok := s.items[id]
	if !ok || item.State != shareClaimed {
		return
	}
	item.State = shareReady
	item.ClaimedAt = time.Time{}
	if failed {
		item.FailCount++
		if item.FailCount >= s.cfg.MaxFailPerShare {
			item.FailCount = 0
			item.LockedUntil = time.Now().Add(shareFailLockTimeout)
		}
	}
}

// take removes a downloaded item from the store and returns it so the caller
// can delete the file after the bytes are flushed.
func (s *ShareStore) take(id string) *ShareItem {
	s.mu.Lock()
	defer s.mu.Unlock()
	item, ok := s.items[id]
	if !ok {
		return nil
	}
	s.removeLocked(item)
	return item
}

// discard deletes the item's file handle and accounting (used by DELETE).
func (s *ShareStore) discard(id string, keyHash [32]byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	item, ok := s.items[id]
	if !ok || !hmac.Equal(item.KeyHash[:], keyHash[:]) {
		return errShareNotFound
	}
	if item.State == shareClaimed {
		return errShareClaimed
	}
	s.removeLocked(item)
	return nil
}

func (s *ShareStore) removeLocked(item *ShareItem) {
	delete(s.items, item.ID)
	switch item.State {
	case shareUploading:
		s.reserved -= item.Reserved
	case shareReady:
		s.total -= item.Size
	case shareClaimed:
		s.total -= item.Size
	}
	if s.reserved < 0 {
		s.reserved = 0
	}
	if s.total < 0 {
		s.total = 0
	}
}

func (s *ShareStore) janitor(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.sweep(time.Now())
		}
	}
}

func (s *ShareStore) sweep(now time.Time) {
	type victim struct {
		id     string
		path   string
		reason string
	}
	var dead []victim
	live := make(map[string]bool)
	s.mu.Lock()
	for id, item := range s.items {
		reason := ""
		switch item.State {
		case shareUploading:
			if now.Sub(item.CreatedAt) > time.Duration(s.cfg.UploadWindowSeconds)*time.Second {
				reason = "upload window expired"
			} else if now.Sub(item.LastProgress) > time.Duration(s.cfg.UploadStallSeconds)*time.Second {
				reason = "upload stalled"
			}
		case shareReady:
			if now.Sub(item.ReadyAt) > time.Duration(s.cfg.TTLMinutes)*time.Minute {
				reason = "expired"
			}
		case shareClaimed:
			if now.Sub(item.ClaimedAt) > shareClaimTimeout {
				reason = "claim stuck"
			}
		}
		if reason == "" {
			live[item.ID+".bin"] = true
			live[item.ID+".part"] = true
			continue
		}
		s.removeLocked(item)
		dead = append(dead, victim{id: id, path: item.Path, reason: reason})
	}
	s.mu.Unlock()

	for _, v := range dead {
		os.Remove(v.path)
		os.Remove(s.partPathFor(v.id))
		logShareSwept(v.id, v.reason)
	}

	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if live[e.Name()] || !isShareStagingName(e.Name()) {
			continue
		}
		path := filepath.Join(s.dir, e.Name())
		if info, err := e.Info(); err == nil && now.Sub(info.ModTime()) < shareOrphanGrace {
			continue
		}
		os.Remove(path)
	}
}

func handleShareCreate(w http.ResponseWriter, r *http.Request) {
	if !cfg.Share.Enabled {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	keyHash, ok := shareStore.keyHashFromHeader(r.Header.Get("X-Share-Key"))
	if !ok {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	setRequestReadDeadline(w, 15*time.Second)
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	var req struct {
		Name string `json:"name"`
		Size int64  `json:"size"`
	}
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if req.Size <= 0 {
		http.Error(w, "invalid size", http.StatusBadRequest)
		return
	}
	if req.Size > cfg.Share.MaxBytes {
		http.Error(w, "file too large", http.StatusRequestEntityTooLarge)
		return
	}
	item, err := shareStore.create(sanitizeDownloadFilename(req.Name), req.Size, keyHash)
	switch {
	case errors.Is(err, errShareTooLarge):
		http.Error(w, "file too large", http.StatusRequestEntityTooLarge)
		return
	case errors.Is(err, errShareQuota):
		w.Header().Set("Retry-After", "30")
		http.Error(w, "storage busy", http.StatusServiceUnavailable)
		return
	case err != nil:
		log.Printf("[share] create failed: %v", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	logShareEvent("created", item.ID, item.Size)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(struct {
		ID        string `json:"id"`
		Path      string `json:"path"`
		ExpiresIn int    `json:"expires_in"`
	}{
		ID:        item.ID,
		Path:      "/s/" + item.ID,
		ExpiresIn: cfg.Share.TTLMinutes * 60,
	})
}

func handleShareUpload(w http.ResponseWriter, r *http.Request) {
	if !cfg.Share.Enabled {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	id := r.PathValue("id")
	keyHash, ok := shareStore.keyHashFromHeader(r.Header.Get("X-Share-Key"))
	if !validShareID(id) || !ok {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	want, err := shareStore.beginUpload(id, keyHash, r.ContentLength)
	switch {
	case errors.Is(err, errShareNotFound), errors.Is(err, errShareExpired):
		http.Error(w, "not found", http.StatusNotFound)
		return
	case errors.Is(err, errShareClaimed):
		http.Error(w, "gone", http.StatusConflict)
		return
	case errors.Is(err, errShareBusy):
		http.Error(w, "upload in progress", http.StatusConflict)
		return
	case errors.Is(err, errShareLength):
		http.Error(w, "content-length required", http.StatusLengthRequired)
		return
	case errors.Is(err, errShareTooLarge):
		http.Error(w, "file too large", http.StatusRequestEntityTooLarge)
		return
	case err != nil:
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	setRequestReadDeadline(w, shareWriteDeadline)
	r.Body = http.MaxBytesReader(w, r.Body, want+1)
	tmp := shareStore.partPathFor(id)
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		shareStore.uploadFailed(id)
		log.Printf("[share] open temp failed: %v", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	n, copyErr := shareStore.copyUpload(f, r.Body, id)
	closeErr := f.Close()
	if copyErr == nil && n != want {
		copyErr = io.ErrUnexpectedEOF
	}
	if copyErr != nil || closeErr != nil {
		os.Remove(tmp)
		shareStore.uploadFailed(id)
		logShareEvent("upload failed", id, n)
		if errors.Is(copyErr, errShareQuota) {
			w.Header().Set("Retry-After", "30")
			http.Error(w, "storage busy", http.StatusServiceUnavailable)
			return
		}
		http.Error(w, "upload incomplete", http.StatusBadRequest)
		return
	}
	if err := os.Rename(tmp, shareStore.pathFor(id)); err != nil {
		os.Remove(tmp)
		shareStore.uploadFailed(id)
		log.Printf("[share] rename failed: %v", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	if err := shareStore.markReady(id, keyHash); err != nil {
		os.Remove(shareStore.pathFor(id))
		http.Error(w, "not found", http.StatusGone)
		return
	}
	logShareEvent("ready", id, want)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}

func handleShareDelete(w http.ResponseWriter, r *http.Request) {
	if !cfg.Share.Enabled {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	id := r.PathValue("id")
	keyHash, ok := shareStore.keyHashFromHeader(r.Header.Get("X-Share-Key"))
	if !validShareID(id) || !ok {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	err := shareStore.discard(id, keyHash)
	switch {
	case errors.Is(err, errShareNotFound):
		http.Error(w, "not found", http.StatusNotFound)
		return
	case errors.Is(err, errShareClaimed):
		http.Error(w, "download in progress", http.StatusConflict)
		return
	case err != nil:
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	os.Remove(shareStore.pathFor(id))
	os.Remove(shareStore.partPathFor(id))
	logShareEvent("deleted", id, 0)
	w.WriteHeader(http.StatusNoContent)
}

func handleShareDownload(w http.ResponseWriter, r *http.Request) {
	if !cfg.Share.Enabled {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	id := r.PathValue("id")
	keyHash, ok := shareStore.keyHashFromHeader(r.Header.Get("X-Share-Key"))
	if !validShareID(id) || !ok {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}

	if r.Method == http.MethodHead {
		item, err := shareStore.peek(id, keyHash)
		if err != nil {
			writeShareLookupError(w, err)
			return
		}
		writeShareHeaders(w, item)
		w.WriteHeader(http.StatusOK)
		return
	}

	item, err := shareStore.claim(id, keyHash)
	if err != nil {
		writeShareLookupError(w, err)
		return
	}
	f, err := os.Open(item.Path)
	if err != nil {
		shareStore.release(id, true)
		log.Printf("[share] open %s failed: %v", id[:6], err)
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	defer f.Close()

	writeShareHeaders(w, item)
	setShareWriteDeadline(w)
	w.WriteHeader(http.StatusOK)
	n, copyErr := io.Copy(w, f)
	if copyErr == nil && n != item.Size {
		copyErr = io.ErrUnexpectedEOF
	}
	if copyErr != nil {
		logShareEvent("download interrupted", id, n)
		shareStore.release(id, true)
		return
	}
	shareStore.take(id)
	os.Remove(item.Path)
	logShareEvent("downloaded", id, n)
}

func writeShareLookupError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errShareUploading):
		w.Header().Set("Retry-After", "2")
		http.Error(w, "not ready", http.StatusServiceUnavailable)
	case errors.Is(err, errShareClaimed):
		http.Error(w, "download in progress", http.StatusConflict)
	case errors.Is(err, errShareLocked):
		w.Header().Set("Retry-After", "5")
		http.Error(w, "too many failed attempts", http.StatusTooManyRequests)
	default:
		http.Error(w, "not found", http.StatusNotFound)
	}
}

func writeShareHeaders(w http.ResponseWriter, item *ShareItem) {
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.FormatInt(item.Size, 10))
	if cd := mime.FormatMediaType("attachment", map[string]string{"filename": item.Filename}); cd != "" {
		w.Header().Set("Content-Disposition", cd)
	} else {
		w.Header().Set("Content-Disposition", "attachment")
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Accept-Ranges", "none")
	w.Header().Set("X-Robots-Tag", "noindex")
}

func setShareWriteDeadline(w http.ResponseWriter) {
	rc := http.NewResponseController(w)
	if err := rc.SetWriteDeadline(time.Now().Add(shareWriteDeadline)); err != nil &&
		!errors.Is(err, http.ErrNotSupported) {
		log.Printf("[share] set write deadline failed: %v", err)
	}
}

// isShareStagingName matches only files this service creates:
// <32 lowercase hex>.bin or .part.
func isShareStagingName(name string) bool {
	ext := filepath.Ext(name)
	if ext != ".bin" && ext != ".part" {
		return false
	}
	return validShareID(strings.TrimSuffix(name, ext))
}

func (s *ShareStore) pathFor(id string) string {
	return filepath.Join(s.dir, id+".bin")
}

func (s *ShareStore) partPathFor(id string) string {
	return filepath.Join(s.dir, id+".part")
}

func logShareEvent(event, id string, n int64) {
	short := id
	if len(short) > 6 {
		short = short[:6]
	}
	if n > 0 {
		log.Printf("[share] %s %s (%d bytes)", event, short, n)
		return
	}
	log.Printf("[share] %s %s", event, short)
}

func logShareSwept(id, reason string) {
	if len(id) > 6 {
		id = id[:6]
	}
	log.Printf("[share] swept %s: %s", id, reason)
}

var windowsReservedNames = map[string]bool{
	"CON": true, "PRN": true, "AUX": true, "NUL": true,
	"COM1": true, "COM2": true, "COM3": true, "COM4": true, "COM5": true,
	"COM6": true, "COM7": true, "COM8": true, "COM9": true,
	"LPT1": true, "LPT2": true, "LPT3": true, "LPT4": true, "LPT5": true,
	"LPT6": true, "LPT7": true, "LPT8": true, "LPT9": true,
}

// sanitizeDownloadFilename mirrors sanitizeFilename in public/security.js.
func sanitizeDownloadFilename(name string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		return "download"
	}
	if i := strings.LastIndexAny(name, "/\\"); i >= 0 {
		name = name[i+1:]
	}
	name = strings.Map(func(r rune) rune {
		if r < 32 || unicode.Is(unicode.Cc, r) || r == 0x7f {
			return -1
		}
		return r
	}, name)
	name = strings.TrimSpace(name)
	name = strings.TrimRightFunc(name, func(r rune) bool {
		return r == '.' || unicode.IsSpace(r)
	})
	if name == "" || name == "." || name == ".." {
		return "download"
	}
	if windowsReservedNames[strings.ToUpper(strings.TrimRight(name, "."))] {
		return "download"
	}
	if len(name) > 255 {
		cut := 255
		for cut > 0 && !utf8.RuneStart(name[cut]) {
			cut--
		}
		name = name[:cut]
	}
	if name == "" {
		return "download"
	}
	return name
}
