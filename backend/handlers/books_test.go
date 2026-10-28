package handlers

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"quiret/db"
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
