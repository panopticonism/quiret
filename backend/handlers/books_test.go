package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"quiret/db"
	"strconv"
	"strings"
	"testing"

	"github.com/gorilla/mux"
)

func TestIsPathAllowed(t *testing.T) {
	dataDir := t.TempDir()
	booksDir := t.TempDir()
	audiobooksDir := t.TempDir()
	outsideDir := t.TempDir()

	// Save and restore package globals so the test doesn't leak state.
	origData, origPaths := DataPath, BookPaths
	t.Cleanup(func() { DataPath, BookPaths = origData, origPaths })

	DataPath = dataDir
	BookPaths = []string{booksDir, audiobooksDir}

	cases := []struct {
		name string
		path string
		want bool
	}{
		{"inside data", filepath.Join(dataDir, "books", "x", "cover.jpg"), true},
		{"inside first book path", filepath.Join(booksDir, "novel.epub"), true},
		{"inside audiobooks path", filepath.Join(audiobooksDir, "book.m4b"), true},
		{"outside all roots", filepath.Join(outsideDir, "secret.epub"), false},
		{"absolute traversal", "/etc/passwd", false},
		{"traversal escape from data", filepath.Join(dataDir, "..", "escape.epub"), false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isPathAllowed(tc.path); got != tc.want {
				t.Errorf("isPathAllowed(%q) = %v, want %v", tc.path, got, tc.want)
			}
		})
	}
}

func deleteBook(t *testing.T, id string) {
	t.Helper()
	req := mux.SetURLVars(httptest.NewRequest(http.MethodDelete, "/api/books/"+id, nil), map[string]string{"id": id})
	rec := httptest.NewRecorder()
	DeleteBook(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("delete %s: status %d: %s", id, rec.Code, rec.Body.String())
	}
}

func TestDeleteBookRemovesPodcastFiles(t *testing.T) {
	if err := db.InitDB(t.TempDir()); err != nil {
		t.Fatalf("init db: %v", err)
	}
	origData := DataPath
	DataPath = t.TempDir()
	t.Cleanup(func() { DataPath = origData })

	storageDir := filepath.Join(DataPath, "books", "ep1")
	os.MkdirAll(storageDir, 0755)
	filePath := filepath.Join(storageDir, "Episode.mp3")
	os.WriteFile(filePath, []byte("audio"), 0644)
	coverPath := filepath.Join(storageDir, "cover.jpg")
	os.WriteFile(coverPath, []byte("img"), 0644)
	if _, err := db.DB.Exec(
		"INSERT INTO books (id, title, cover_path, file_path, file_type, source) VALUES (?, ?, ?, ?, ?, ?)",
		"ep1", "Episode", coverPath, filePath, "mp3", "podcast",
	); err != nil {
		t.Fatal(err)
	}

	deleteBook(t, "ep1")

	if _, err := os.Stat(storageDir); !os.IsNotExist(err) {
		t.Errorf("podcast storage still exists after delete (err %v)", err)
	}
}

func TestDeleteBookLeavesScannedFile(t *testing.T) {
	if err := db.InitDB(t.TempDir()); err != nil {
		t.Fatalf("init db: %v", err)
	}
	origData := DataPath
	DataPath = t.TempDir()
	t.Cleanup(func() { DataPath = origData })

	root := t.TempDir()
	filePath := filepath.Join(root, "Novel.mp3")
	os.WriteFile(filePath, []byte("audio"), 0644)
	added, err := ScanDirectory(root)
	if err != nil || len(added) != 1 {
		t.Fatalf("scan: added %d, err %v", len(added), err)
	}

	deleteBook(t, added[0].ID)

	if _, err := os.Stat(filePath); err != nil {
		t.Errorf("scanned book file was touched by delete: %v", err)
	}
}

func saveProgress(t *testing.T, id, progress string) *httptest.ResponseRecorder {
	t.Helper()
	body := strings.NewReader(`{"progress":` + strconv.Quote(progress) + `}`)
	req := mux.SetURLVars(
		httptest.NewRequest(http.MethodPut, "/api/books/"+id+"/progress", body),
		map[string]string{"id": id},
	)
	rec := httptest.NewRecorder()
	SaveProgress(rec, req)
	return rec
}

// The client decides whether the server already holds its local position by
// comparing the timestamp a save returns against the one the listing reports.
// They have to be the same string, or every load looks like a conflict.
func TestSaveProgressReturnsTheStoredTimestamp(t *testing.T) {
	if err := db.InitDB(t.TempDir()); err != nil {
		t.Fatalf("init db: %v", err)
	}
	if _, err := db.DB.Exec(
		"INSERT INTO books (id, title, author, cover_path, file_path, file_size, file_type) VALUES (?, ?, ?, ?, ?, ?, ?)",
		"b1", "Book", "Author", "", "/books/b1.mp3", 1024, "mp3",
	); err != nil {
		t.Fatal(err)
	}

	const progress = `{"type":"audio","position":900,"duration":2532}`
	rec := saveProgress(t, "b1", progress)
	if rec.Code != http.StatusOK {
		t.Fatalf("save: status %d: %s", rec.Code, rec.Body.String())
	}

	var saved struct {
		Status            string `json:"status"`
		ProgressUpdatedAt string `json:"progressUpdatedAt"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &saved); err != nil {
		t.Fatalf("decode save response: %v", err)
	}
	if saved.Status != "ok" {
		t.Errorf("status = %q, want ok", saved.Status)
	}
	if saved.ProgressUpdatedAt == "" {
		t.Fatal("save response carried no progressUpdatedAt")
	}

	getReq := mux.SetURLVars(httptest.NewRequest(http.MethodGet, "/api/books/b1", nil), map[string]string{"id": "b1"})
	getRec := httptest.NewRecorder()
	GetBook(getRec, getReq)
	if getRec.Code != http.StatusOK {
		t.Fatalf("get: status %d", getRec.Code)
	}

	var got struct {
		ReadingProgress   string `json:"readingProgress"`
		ProgressUpdatedAt string `json:"progressUpdatedAt"`
	}
	if err := json.Unmarshal(getRec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode get response: %v", err)
	}
	if got.ReadingProgress != progress {
		t.Errorf("readingProgress = %q, want %q", got.ReadingProgress, progress)
	}
	if got.ProgressUpdatedAt != saved.ProgressUpdatedAt {
		t.Errorf(
			"timestamp mismatch:\n save returned %q\n listing reports %q",
			saved.ProgressUpdatedAt, got.ProgressUpdatedAt,
		)
	}
}

func TestSaveProgressRejectsBadRequests(t *testing.T) {
	if err := db.InitDB(t.TempDir()); err != nil {
		t.Fatalf("init db: %v", err)
	}
	if _, err := db.DB.Exec(
		"INSERT INTO books (id, title, author, cover_path, file_path, file_size, file_type) VALUES (?, ?, ?, ?, ?, ?, ?)",
		"b1", "Book", "Author", "", "/books/b1.mp3", 1024, "mp3",
	); err != nil {
		t.Fatal(err)
	}

	// An empty payload would blank a real reading position.
	if rec := saveProgress(t, "b1", ""); rec.Code != http.StatusBadRequest {
		t.Errorf("empty progress: status %d, want 400", rec.Code)
	}
	if rec := saveProgress(t, "nope", `{"type":"audio","position":1,"duration":2}`); rec.Code != http.StatusNotFound {
		t.Errorf("unknown book: status %d, want 404", rec.Code)
	}
}
