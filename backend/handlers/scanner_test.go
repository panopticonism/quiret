package handlers

import (
	"os"
	"path/filepath"
	"quiret/db"
	"testing"
)

func TestScanDirectoryRecursive(t *testing.T) {
	if err := db.InitDB(t.TempDir()); err != nil {
		t.Fatalf("init db: %v", err)
	}
	origData := DataPath
	DataPath = t.TempDir()
	t.Cleanup(func() { DataPath = origData })

	root := t.TempDir()

	// A book nested a couple of directories deep.
	nested := filepath.Join(root, "Some Show", "Season 1")
	if err := os.MkdirAll(nested, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(nested, "Episode One.mp3"), []byte("not real audio"), 0644); err != nil {
		t.Fatal(err)
	}

	// A hidden directory whose contents must be skipped.
	hidden := filepath.Join(root, ".hidden")
	os.MkdirAll(hidden, 0755)
	os.WriteFile(filepath.Join(hidden, "ignore.mp3"), []byte("x"), 0644)

	// An archived folder (any case, any depth) whose contents must be skipped.
	archive := filepath.Join(root, "Some Show", "Archived")
	os.MkdirAll(archive, 0755)
	os.WriteFile(filepath.Join(archive, "old.mp3"), []byte("x"), 0644)

	// An unsupported file that must be ignored.
	os.WriteFile(filepath.Join(root, "notes.txt"), []byte("hi"), 0644)

	added, err := ScanDirectory(root)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if len(added) != 1 {
		t.Fatalf("expected 1 book, got %d: %+v", len(added), added)
	}
	if added[0].Title != "Episode One" {
		t.Errorf("title = %q, want %q", added[0].Title, "Episode One")
	}
	if added[0].FileType != "mp3" {
		t.Errorf("fileType = %q, want mp3", added[0].FileType)
	}
}
