package handlers

import (
	"io/fs"
	"log"
	"path/filepath"
	"quiret/db"
	"quiret/models"
	"strings"
	"time"

	"github.com/google/uuid"
)

var supportedBookTypes = map[string]string{
	".epub": "epub",
	".pdf":  "pdf",
	".fb2":  "fb2",
	".cbz":  "cbz",
	".mp3":  "mp3",
	".m4b":  "m4b",
	".m4a":  "m4a",
	".aac":  "aac",
	".ogg":  "ogg",
	".opus": "opus",
	".mp4":  "mp4",
	".m4v":  "m4v",
	".webm": "webm",
	".mov":  "mov",
	".mkv":  "mkv",
}

// ScanDirectory walks a directory tree for book files and adds new ones to the
// database. Returns the list of added books and any error encountered.
func ScanDirectory(booksDir string) ([]models.Book, error) {
	var addedBooks []models.Book

	walkErr := filepath.WalkDir(booksDir, func(filePath string, d fs.DirEntry, err error) error {
		if err != nil {
			// Unreadable entry (permissions, vanished file): log and keep going.
			log.Printf("Scan: skipping %s: %v", filePath, err)
			if d != nil && d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}

		if d.IsDir() {
			// Skip hidden directories (e.g. .git, .Trash) but not the root itself.
			if filePath != booksDir && strings.HasPrefix(d.Name(), ".") {
				return fs.SkipDir
			}
			return nil
		}

		filename := d.Name()
		ext := strings.ToLower(filepath.Ext(filename))
		fileType, ok := supportedBookTypes[ext]
		if !ok {
			return nil
		}

		// Already in the database (by absolute file path)?
		var existingID string
		if err := db.DB.QueryRow("SELECT id FROM books WHERE file_path = ?", filePath).Scan(&existingID); err == nil {
			return nil
		}

		info, err := d.Info()
		if err != nil {
			log.Printf("Failed to stat file %s: %v", filePath, err)
			return nil
		}

		bookID := uuid.New().String()
		originalName := strings.TrimSuffix(filename, filepath.Ext(filename))
		storageDir := filepath.Join(DataPath, "books", bookID)

		var title, author, coverPath string
		switch fileType {
		case "epub":
			title, author, coverPath = ExtractEPUBMetadata(filePath, storageDir, originalName)
		case "pdf":
			title, author = ExtractPDFMetadata(filePath, originalName)
			coverPath = ExtractPDFCover(filePath, storageDir, bookID)
		case "cbz":
			title = originalName
			coverPath = ExtractCBZCover(filePath, storageDir)
		case "fb2":
			title, author, coverPath = ExtractFB2Metadata(filePath, storageDir, originalName)
		case "mp3", "m4b", "m4a", "aac", "ogg", "opus":
			title, author, coverPath = ExtractAudioMetadata(filePath, storageDir, originalName)
		default:
			title = originalName
		}

		book := models.Book{
			ID:        bookID,
			Title:     title,
			Author:    author,
			CoverPath: coverPath,
			FilePath:  filePath,
			FileSize:  info.Size(),
			FileType:  fileType,
			AddedAt:   time.Now(),
		}

		if _, err := db.DB.Exec(
			"INSERT INTO books (id, title, author, cover_path, file_path, file_size, file_type, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			book.ID, book.Title, book.Author, book.CoverPath, book.FilePath, book.FileSize, book.FileType, book.AddedAt,
		); err != nil {
			log.Printf("Failed to insert book %s: %v", title, err)
			return nil
		}

		addedBooks = append(addedBooks, book)
		log.Printf("Added book: %s by %s", title, author)
		return nil
	})

	if walkErr != nil {
		return addedBooks, walkErr
	}
	return addedBooks, nil
}
