package handlers

import (
	"database/sql"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"quiret/db"
	"quiret/models"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/mux"
)

var (
	DataPath  string
	BookPaths []string
)

func isPathAllowed(filePath string) bool {
	absFilePath, err := filepath.Abs(filePath)
	if err != nil {
		return false
	}
	roots := append([]string{DataPath}, BookPaths...)
	for _, root := range roots {
		if root == "" {
			continue
		}
		absRoot, err := filepath.Abs(root)
		if err != nil {
			continue
		}
		rel, err := filepath.Rel(absRoot, absFilePath)
		if err != nil {
			continue
		}
		if !strings.HasPrefix(rel, "..") {
			return true
		}
	}
	return false
}

func UploadBook(w http.ResponseWriter, r *http.Request) {
	err := r.ParseMultipartForm(100 << 20) // 100MB max
	if err != nil {
		http.Error(w, "File too large", http.StatusBadRequest)
		return
	}

	file, header, err := r.FormFile("book")
	if err != nil {
		http.Error(w, "Failed to read file", http.StatusBadRequest)
		return
	}
	defer file.Close()

	safeFilename := filepath.Base(header.Filename)

	fileExt := strings.ToLower(filepath.Ext(safeFilename))
	supportedTypes := map[string]string{
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
	fileType, ok := supportedTypes[fileExt]
	if !ok {
		http.Error(w, "Unsupported file format", http.StatusBadRequest)
		return
	}

	bookID := uuid.New().String()
	storageDir := filepath.Join(DataPath, "books", bookID)
	err = os.MkdirAll(storageDir, 0755)
	if err != nil {
		http.Error(w, "Failed to create book directory", http.StatusInternalServerError)
		return
	}

	filePath := filepath.Join(storageDir, safeFilename)
	dst, err := os.Create(filePath)
	if err != nil {
		http.Error(w, "Failed to save file", http.StatusInternalServerError)
		return
	}
	defer dst.Close()

	fileSize, err := io.Copy(dst, file)
	if err != nil {
		os.Remove(filePath)
		http.Error(w, "Failed to save file", http.StatusInternalServerError)
		return
	}

	// Get original filename without extension for title fallback
	originalName := strings.TrimSuffix(safeFilename, filepath.Ext(safeFilename))

	var title, author, coverPath string
	switch fileType {
	case "epub":
		title, author, coverPath = ExtractEPUBMetadata(filePath, storageDir, originalName)
	case "pdf":
		title, author = ExtractPDFMetadata(filePath, originalName)
		coverPath = ExtractPDFCover(filePath, storageDir, bookID)
	case "cbz":
		title = originalName
		author = ""
		coverPath = ExtractCBZCover(filePath, storageDir)
	case "fb2":
		title, author, coverPath = ExtractFB2Metadata(filePath, storageDir, originalName)
	case "mp3", "m4b", "m4a", "aac", "ogg", "opus":
		title, author, coverPath = ExtractAudioMetadata(filePath, storageDir, originalName)
	default:
		title = originalName
		author = ""
	}

	// Ensure coverPath is absolute
	if coverPath != "" && !filepath.IsAbs(coverPath) {
		coverPath = filepath.Join(DataPath, coverPath)
	}

	book := models.Book{
		ID:        bookID,
		Title:     title,
		Author:    author,
		CoverPath: coverPath,
		FilePath:  filePath,
		FileSize:  fileSize,
		FileType:  fileType,
		AddedAt:   time.Now(),
	}

	_, err = db.DB.Exec(
		"INSERT INTO books (id, title, author, cover_path, file_path, file_size, file_type, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		book.ID, book.Title, book.Author, book.CoverPath, book.FilePath, book.FileSize, book.FileType, book.AddedAt,
	)
	if err != nil {
		http.Error(w, "Failed to save book metadata", http.StatusInternalServerError)
		log.Println("DB error:", err)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(book)
}

// RescanBooks scans every configured book directory for newly added files and
// returns how many were added.
func RescanBooks(w http.ResponseWriter, r *http.Request) {
	added := 0
	for _, p := range BookPaths {
		books, err := ScanDirectory(p)
		if err != nil {
			log.Printf("Rescan: failed to scan %s: %v", p, err)
			continue
		}
		added += len(books)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]int{"added": added})
}

func GetBooks(w http.ResponseWriter, r *http.Request) {
	rows, err := db.DB.Query("SELECT id, title, author, cover_path, file_path, file_size, file_type, source, added_at, reading_progress, progress_updated_at FROM books ORDER BY added_at DESC")
	if err != nil {
		http.Error(w, "Failed to fetch books", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	books := make([]models.Book, 0)
	for rows.Next() {
		var book models.Book
		var source, readingProgress sql.NullString
		var progressUpdatedAt sql.NullTime
		err := rows.Scan(&book.ID, &book.Title, &book.Author, &book.CoverPath, &book.FilePath, &book.FileSize, &book.FileType, &source, &book.AddedAt, &readingProgress, &progressUpdatedAt)
		if err != nil {
			log.Println("Scan error:", err)
			continue
		}
		book.Source = source.String
		if readingProgress.Valid {
			book.ReadingProgress = readingProgress.String
		}
		if progressUpdatedAt.Valid {
			book.ProgressUpdatedAt = &progressUpdatedAt.Time
		}
		books = append(books, book)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(books)
}

func GetBook(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	bookID := vars["id"]

	var book models.Book
	var source, readingProgress sql.NullString
	var progressUpdatedAt sql.NullTime
	err := db.DB.QueryRow(
		"SELECT id, title, author, cover_path, file_path, file_size, file_type, source, added_at, reading_progress, progress_updated_at FROM books WHERE id = ?",
		bookID,
	).Scan(&book.ID, &book.Title, &book.Author, &book.CoverPath, &book.FilePath, &book.FileSize, &book.FileType, &source, &book.AddedAt, &readingProgress, &progressUpdatedAt)

	if err != nil {
		http.Error(w, "Book not found", http.StatusNotFound)
		return
	}

	book.Source = source.String
	if readingProgress.Valid {
		book.ReadingProgress = readingProgress.String
	}
	if progressUpdatedAt.Valid {
		book.ProgressUpdatedAt = &progressUpdatedAt.Time
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(book)
}

func SaveProgress(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	bookID := vars["id"]

	var payload struct {
		Progress string `json:"progress"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		log.Printf("SaveProgress decode error: %v", err)
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	_, err := db.DB.Exec("UPDATE books SET reading_progress = ?, progress_updated_at = ? WHERE id = ?", payload.Progress, time.Now(), bookID)
	if err != nil {
		log.Printf("SaveProgress DB error for book %s: %v", bookID, err)
		http.Error(w, "Failed to save progress", http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

func UpdateBook(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	bookID := vars["id"]

	var payload struct {
		Title  string `json:"title"`
		Author string `json:"author"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	title := strings.TrimSpace(payload.Title)
	author := strings.TrimSpace(payload.Author)
	if title == "" {
		http.Error(w, "Title is required", http.StatusBadRequest)
		return
	}

	res, err := db.DB.Exec("UPDATE books SET title = ?, author = ? WHERE id = ?", title, author, bookID)
	if err != nil {
		http.Error(w, "Failed to update book", http.StatusInternalServerError)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		http.Error(w, "Book not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"title": title, "author": author})
}

func ServeBookFile(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	bookID := vars["id"]

	var filePath, fileType string
	err := db.DB.QueryRow("SELECT file_path, file_type FROM books WHERE id = ?", bookID).Scan(&filePath, &fileType)
	if err != nil {
		http.Error(w, "Book not found", http.StatusNotFound)
		return
	}

	if !isPathAllowed(filePath) {
		log.Printf("Refusing to serve book file outside allowed roots: %s", filePath)
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}

	// Set appropriate content type based on file type
	contentTypes := map[string]string{
		"epub": "application/epub+zip",
		"pdf":  "application/pdf",
		"fb2":  "application/x-fictionbook+xml",
		"cbz":  "application/vnd.comicbook+zip",
		"mp3":  "audio/mpeg",
		"m4b":  "audio/mp4",
		"m4a":  "audio/mp4",
		"aac":  "audio/aac",
		"ogg":  "audio/ogg",
		"opus": "audio/ogg",
		"mp4":  "video/mp4",
		"m4v":  "video/mp4",
		"webm": "video/webm",
		"mov":  "video/quicktime",
		"mkv":  "video/x-matroska",
	}
	if ct, ok := contentTypes[fileType]; ok {
		w.Header().Set("Content-Type", ct)
	} else {
		w.Header().Set("Content-Type", "application/octet-stream")
	}

	http.ServeFile(w, r, filePath)
}

func GetChapters(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	bookID := vars["id"]

	var filePath string
	err := db.DB.QueryRow("SELECT file_path FROM books WHERE id = ?", bookID).Scan(&filePath)
	if err != nil {
		http.Error(w, "Book not found", http.StatusNotFound)
		return
	}

	if !isPathAllowed(filePath) {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}

	chapters := ExtractAudioChapters(filePath)
	if chapters == nil {
		chapters = []models.Chapter{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(chapters)
}

func ServeCover(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	bookID := vars["id"]

	var coverPath string
	err := db.DB.QueryRow("SELECT cover_path FROM books WHERE id = ?", bookID).Scan(&coverPath)
	if err != nil || coverPath == "" {
		http.Error(w, "Cover not found", http.StatusNotFound)
		return
	}

	if !isPathAllowed(coverPath) {
		log.Printf("Refusing to serve cover outside allowed roots: %s", coverPath)
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}

	w.Header().Set("Cache-Control", "public, max-age=86400")

	// Set appropriate content type based on file extension
	ext := strings.ToLower(filepath.Ext(coverPath))
	switch ext {
	case ".jpg", ".jpeg":
		w.Header().Set("Content-Type", "image/jpeg")
	case ".png":
		w.Header().Set("Content-Type", "image/png")
	case ".webp":
		w.Header().Set("Content-Type", "image/webp")
	default:
		w.Header().Set("Content-Type", "image/jpeg")
	}

	http.ServeFile(w, r, coverPath)
}

func DeleteBook(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	bookID := vars["id"]

	var coverPath string
	err := db.DB.QueryRow("SELECT cover_path FROM books WHERE id = ?", bookID).Scan(&coverPath)
	if err != nil {
		http.Error(w, "Book not found", http.StatusNotFound)
		return
	}

	_, err = db.DB.Exec("DELETE FROM books WHERE id = ?", bookID)
	if err != nil {
		http.Error(w, "Failed to delete book", http.StatusInternalServerError)
		return
	}

	if coverPath != "" {
		if err := os.Remove(coverPath); err != nil {
			log.Printf("Warning: failed to delete cover file %s: %v", coverPath, err)
		}
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "deleted"})
}

func UploadCover(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	bookID := vars["id"]

	// Verify book exists
	var filePath string
	err := db.DB.QueryRow("SELECT file_path FROM books WHERE id = ?", bookID).Scan(&filePath)
	if err != nil {
		http.Error(w, "Book not found", http.StatusNotFound)
		return
	}

	err = r.ParseMultipartForm(10 << 20) // 10MB max for cover
	if err != nil {
		http.Error(w, "File too large", http.StatusBadRequest)
		return
	}

	file, _, err := r.FormFile("cover")
	if err != nil {
		http.Error(w, "Failed to read file", http.StatusBadRequest)
		return
	}
	defer file.Close()

	data, err := io.ReadAll(file)
	if err != nil {
		http.Error(w, "Failed to read file", http.StatusInternalServerError)
		return
	}

	// Verify it's an image
	if !IsImageFile(data) {
		http.Error(w, "Invalid image file", http.StatusBadRequest)
		return
	}

	// Determine extension based on content
	ext := ".jpg"
	if len(data) > 4 && data[0] == 0x89 && data[1] == 0x50 {
		ext = ".png"
	}

	storageDir := filepath.Join(DataPath, "books", bookID)
	if err := os.MkdirAll(storageDir, 0755); err != nil {
		http.Error(w, "Failed to create storage directory", http.StatusInternalServerError)
		return
	}
	coverPath := filepath.Join(storageDir, "cover"+ext)
	outFile, err := os.Create(coverPath)
	if err != nil {
		http.Error(w, "Failed to save cover", http.StatusInternalServerError)
		return
	}
	defer outFile.Close()
	if _, err := outFile.Write(data); err != nil {
		http.Error(w, "Failed to write cover", http.StatusInternalServerError)
		return
	}

	// Update database
	_, err = db.DB.Exec("UPDATE books SET cover_path = ? WHERE id = ?", coverPath, bookID)
	if err != nil {
		http.Error(w, "Failed to update book", http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"coverPath": coverPath})
}
