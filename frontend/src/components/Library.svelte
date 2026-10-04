<script>
  import { onMount } from "svelte";
  import {
    SUPPORTED_EXTENSIONS,
    FILE_ACCEPT,
    FOLIATE_FORMATS,
    AUDIO_FORMATS,
    VIDEO_FORMATS,
  } from "../lib/constants.js";
  import BookCard from "./BookCard.svelte";
  import BookEditModal from "./BookEditModal.svelte";
  import PodcastModal from "./PodcastModal.svelte";
  import {
    downloadedIds,
    downloadForOffline,
    removeDownload,
    effectiveProgress,
    flushLocalProgress,
  } from "../lib/offline.js";

  let { onOpenBook } = $props();

  let books = $state([]);
  let loaded = $state(false);
  let uploading = $state(false);
  let rescanning = $state(false);
  let darkMode = $state(false);
  let searchQuery = $state("");
  let sortBy = $state("added");
  let dragDepth = $state(0);
  let editingBook = $state(null);
  let showPodcasts = $state(false);
  let activeKind = $state("Unfinished");
  let showControls = $state(false);
  let downloaded = $state(new Set());
  let downloadingIds = $state(new Set());
  let downloadProgress = $state(new Map());
  let online = $state(typeof navigator !== "undefined" ? navigator.onLine : true);

  // Close the sort/filter menu when clicking outside it.
  $effect(() => {
    if (!showControls) return;
    const onDocClick = (e) => {
      if (!e.target.closest(".controls-wrap")) showControls = false;
    };
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  });

  const isDragging = $derived(dragDepth > 0);

  const KIND_ORDER = ["Ebooks", "Audiobooks", "Podcasts", "Videos", "PDFs", "Comics"];

  const kindOf = (book) => {
    const t = book.fileType;
    if (AUDIO_FORMATS.includes(t))
      return book.source === "podcast" ? "Podcasts" : "Audiobooks";
    if (VIDEO_FORMATS.includes(t)) return "Videos";
    if (t === "pdf") return "PDFs";
    if (t === "cbz") return "Comics";
    return "Ebooks";
  };

  const presentKinds = $derived.by(() => {
    const set = new Set(books.map(kindOf));
    return KIND_ORDER.filter((k) => set.has(k));
  });

  // Reset the filter if the active option disappears (e.g. last of a kind deleted,
  // or nothing finished anymore).
  $effect(() => {
    if (!loaded) return; // don't reset the default before the library has loaded
    const valid =
      activeKind === "All" ||
      (activeKind === "Finished" || activeKind === "Unfinished"
        ? finishedBooks.length > 0
        : presentKinds.includes(activeKind));
    if (!valid) activeKind = "All";
  });

  const filteredBooks = $derived.by(() => {
    const q = searchQuery.trim().toLowerCase();
    let list = books;
    if (activeKind === "Finished") {
      list = list.filter((b) => (progressByBookId.get(b.id) ?? 0) >= 100);
    } else if (activeKind === "Unfinished") {
      list = list.filter((b) => (progressByBookId.get(b.id) ?? 0) < 100);
    } else if (activeKind !== "All") {
      list = list.filter((b) => kindOf(b) === activeKind);
    }
    if (q) {
      list = list.filter(
        (b) =>
          b.title?.toLowerCase().includes(q) ||
          b.author?.toLowerCase().includes(q),
      );
    }
    if (sortBy === "title") {
      return [...list].sort((a, b) =>
        (a.title || "").localeCompare(b.title || ""),
      );
    }
    if (sortBy === "author") {
      return [...list].sort((a, b) =>
        (a.author || "").localeCompare(b.author || ""),
      );
    }
    return list;
  });

  const updateOnline = () => (online = navigator.onLine);

  onMount(() => {
    darkMode = localStorage.getItem("darkMode") === "true";
    applyDarkMode(darkMode);
    fetchBooks();
    downloadedIds().then((ids) => (downloaded = ids));

    document.addEventListener("dragenter", onDocDragEnter);
    document.addEventListener("dragleave", onDocDragLeave);
    document.addEventListener("dragover", onDocDragOver);
    document.addEventListener("drop", onDocDrop);
    window.addEventListener("online", updateOnline);
    window.addEventListener("offline", updateOnline);

    return () => {
      document.removeEventListener("dragenter", onDocDragEnter);
      document.removeEventListener("dragleave", onDocDragLeave);
      document.removeEventListener("dragover", onDocDragOver);
      document.removeEventListener("drop", onDocDrop);
      window.removeEventListener("online", updateOnline);
      window.removeEventListener("offline", updateOnline);
    };
  });

  const toggleDarkMode = () => {
    darkMode = !darkMode;
    localStorage.setItem("darkMode", darkMode);
    applyDarkMode(darkMode);
  };

  const applyDarkMode = (enabled) => {
    document.documentElement.classList.toggle("dark", enabled);
  };

  const fetchBooks = async () => {
    try {
      const response = await fetch("/api/books");
      const data = await response.json();
      books = Array.isArray(data) ? data : [];
      flushLocalProgress(books);
    } catch (error) {
      console.error("Failed to fetch books:", error);
      books = [];
    } finally {
      loaded = true;
    }
  };

  const toggleDownload = async (book) => {
    if (downloadingIds.has(book.id)) return;
    if (downloaded.has(book.id)) {
      await removeDownload(book.id);
      const next = new Set(downloaded);
      next.delete(book.id);
      downloaded = next;
      return;
    }
    downloadingIds = new Set(downloadingIds).add(book.id);
    downloadProgress = new Map(downloadProgress).set(book.id, 0);
    try {
      await downloadForOffline(book, (frac) => {
        downloadProgress = new Map(downloadProgress).set(book.id, frac);
      });
      downloaded = new Set(downloaded).add(book.id);
    } catch (error) {
      console.error("Offline download failed:", error);
      alert(error?.message || "Couldn't download this for offline use.");
    } finally {
      const nextIds = new Set(downloadingIds);
      nextIds.delete(book.id);
      downloadingIds = nextIds;
      const nextProg = new Map(downloadProgress);
      nextProg.delete(book.id);
      downloadProgress = nextProg;
    }
  };

  const isFileDrag = (e) => e.dataTransfer?.types?.includes?.("Files");

  const onDocDragEnter = (e) => {
    if (isFileDrag(e)) {
      e.preventDefault();
      dragDepth++;
    }
  };

  const onDocDragLeave = () => {
    if (dragDepth > 0) dragDepth--;
  };

  const onDocDragOver = (e) => {
    if (isFileDrag(e)) e.preventDefault();
  };

  const onDocDrop = (e) => {
    e.preventDefault();
    dragDepth = 0;
    const file = e.dataTransfer?.files?.[0];
    if (file) tryUploadFile(file);
  };

  const handleFilePicker = async (event) => {
    const file = event.target.files?.[0];
    if (file) {
      await tryUploadFile(file);
      event.target.value = "";
    }
  };

  const tryUploadFile = async (file) => {
    const filename = file.name.toLowerCase();
    const isSupported = SUPPORTED_EXTENSIONS.some((ext) =>
      filename.endsWith(ext),
    );
    if (!isSupported) {
      alert("Supported formats: EPUB, PDF, FB2, CBZ, audiobooks (MP3, M4B, M4A), and video (MP4, WebM, M4V)");
      return;
    }
    await uploadBook(file);
  };

  const uploadBook = async (file) => {
    uploading = true;
    const formData = new FormData();
    formData.append("book", file);

    try {
      const response = await fetch("/api/books", {
        method: "POST",
        body: formData,
      });

      if (response.ok) {
        await fetchBooks();
      } else {
        alert("Failed to upload book");
      }
    } catch (error) {
      console.error("Upload error:", error);
      alert("Failed to upload book");
    } finally {
      uploading = false;
    }
  };

  const computeProgress = (book) => {
    const raw = effectiveProgress(book);
    if (!raw) return 0;
    try {
      const progress = JSON.parse(raw);
      if (
        FOLIATE_FORMATS.includes(progress.type) &&
        progress.fraction !== undefined
      ) {
        return Math.round(progress.fraction * 100);
      } else if (progress.type === "pdf" && progress.page && progress.totalPages) {
        return Math.round((progress.page / progress.totalPages) * 100);
      } else if (
        (progress.type === "audio" || progress.type === "video") &&
        progress.position &&
        progress.duration
      ) {
        return Math.round((progress.position / progress.duration) * 100);
      }
    } catch (e) {
      return 0;
    }
    return 0;
  };

  const progressByBookId = $derived.by(() => {
    const map = new Map();
    for (const book of books) {
      map.set(book.id, computeProgress(book));
    }
    return map;
  });

  // In-progress books (started but not finished), most recently opened first.
  const continueBooks = $derived.by(() => {
    const items = books
      .map((book) => ({ book, progress: progressByBookId.get(book.id) ?? 0 }))
      .filter((x) => x.progress > 0 && x.progress < 100);
    items.sort((a, b) => {
      const ta = a.book.progressUpdatedAt ? Date.parse(a.book.progressUpdatedAt) : 0;
      const tb = b.book.progressUpdatedAt ? Date.parse(b.book.progressUpdatedAt) : 0;
      return tb - ta;
    });
    return items.slice(0, 12).map((x) => x.book);
  });

  // Finished books (reached the end), most recently finished first.
  const finishedBooks = $derived.by(() => {
    const items = books
      .map((book) => ({ book, progress: progressByBookId.get(book.id) ?? 0 }))
      .filter((x) => x.progress >= 100);
    items.sort((a, b) => {
      const ta = a.book.progressUpdatedAt ? Date.parse(a.book.progressUpdatedAt) : 0;
      const tb = b.book.progressUpdatedAt ? Date.parse(b.book.progressUpdatedAt) : 0;
      return tb - ta;
    });
    return items.map((x) => x.book);
  });

  const deleteBook = async (bookId, bookTitle) => {
    if (!confirm(`Delete "${bookTitle}"?`)) return;

    try {
      const response = await fetch(`/api/books/${bookId}`, {
        method: "DELETE",
      });

      if (response.ok) {
        books = books.filter((b) => b.id !== bookId);
      } else {
        alert("Failed to delete book");
      }
    } catch (error) {
      console.error("Delete error:", error);
      alert("Failed to delete book");
    }
  };

  const triggerUpload = () => {
    document.getElementById("file-input")?.click();
  };

  const rescan = async () => {
    if (rescanning) return;
    rescanning = true;
    try {
      const res = await fetch("/api/rescan", { method: "POST" });
      if (res.ok) await fetchBooks();
    } catch (error) {
      console.error("Rescan failed:", error);
    } finally {
      rescanning = false;
    }
  };

  const handleBookSaved = (patch) => {
    if (!editingBook) return;
    const id = editingBook.id;
    books = books.map((b) =>
      b.id === id
        ? {
            ...b,
            title: patch.title,
            author: patch.author,
            ...(patch.coverPath !== undefined
              ? { coverPath: patch.coverPath, _cacheBust: Date.now() }
              : {}),
          }
        : b,
    );
    editingBook = null;
  };
</script>

<input
  type="file"
  accept={FILE_ACCEPT}
  onchange={handleFilePicker}
  id="file-input"
  hidden
/>

<div class="container">
  <header class="library-header">
    <div class="brand">
      <h1>Quiret</h1>
      {#if books.length > 0}
        <span class="count">{books.length} {books.length === 1 ? "book" : "books"}</span>
      {/if}
      {#if !online}
        <span class="offline-pill" title="You're offline — only downloaded books are available">Offline</span>
      {/if}
    </div>
    <div class="header-actions">
      {#if books.length > 0}
        <div class="actions-primary">
        <div class="search">
          <svg class="search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="7" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="search"
            placeholder="Search"
            bind:value={searchQuery}
            class="search-input"
          />
        </div>
        <div class="controls-wrap">
          <button
            class="icon-btn"
            class:active={(activeKind !== "All" && activeKind !== "Unfinished") || sortBy !== "added"}
            onclick={() => (showControls = !showControls)}
            aria-label="Sort and filter"
            aria-expanded={showControls}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="4" y1="21" x2="4" y2="14" />
              <line x1="4" y1="10" x2="4" y2="3" />
              <line x1="12" y1="21" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12" y2="3" />
              <line x1="20" y1="21" x2="20" y2="16" />
              <line x1="20" y1="12" x2="20" y2="3" />
              <line x1="1" y1="14" x2="7" y2="14" />
              <line x1="9" y1="8" x2="15" y2="8" />
              <line x1="17" y1="16" x2="23" y2="16" />
            </svg>
          </button>
          {#if showControls}
            <div class="controls-menu" role="menu">
              {#if presentKinds.length > 1 || finishedBooks.length > 0}
                <span class="menu-heading">Show</span>
                {#each ["All", ...presentKinds] as kind (kind)}
                  <button
                    class="menu-option"
                    class:selected={activeKind === kind}
                    onclick={() => (activeKind = kind)}
                  >
                    <span>{kind === "All" ? "All types" : kind}</span>
                    {#if activeKind === kind}
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                    {/if}
                  </button>
                {/each}
                {#if finishedBooks.length > 0}
                  <button
                    class="menu-option"
                    class:selected={activeKind === "Unfinished"}
                    onclick={() => (activeKind = "Unfinished")}
                  >
                    <span>Unfinished</span>
                    {#if activeKind === "Unfinished"}
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                    {/if}
                  </button>
                  <button
                    class="menu-option"
                    class:selected={activeKind === "Finished"}
                    onclick={() => (activeKind = "Finished")}
                  >
                    <span>Finished</span>
                    {#if activeKind === "Finished"}
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                    {/if}
                  </button>
                {/if}
                <div class="menu-divider"></div>
              {/if}
              <span class="menu-heading">Sort by</span>
              {#each [["added", "Recently added"], ["title", "Title"], ["author", "Author"]] as [value, label] (value)}
                <button
                  class="menu-option"
                  class:selected={sortBy === value}
                  onclick={() => (sortBy = value)}
                >
                  <span>{label}</span>
                  {#if sortBy === value}
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                  {/if}
                </button>
              {/each}
            </div>
          {/if}
        </div>
        </div>
      {/if}
      <div class="actions-secondary">
      {#if online}
      <button
        class="upload-btn"
        onclick={triggerUpload}
        disabled={uploading}
      >
        {#if uploading}
          <span class="spinner-sm"></span>
          <span class="upload-label">Uploading</span>
        {:else}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
          <span class="upload-label">Upload</span>
        {/if}
      </button>
      <button
        class="icon-btn"
        onclick={rescan}
        disabled={rescanning}
        aria-label="Rescan folders for new books"
        title="Rescan folders for new books"
      >
        <svg
          class:spinning={rescanning}
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M21 12a9 9 0 1 1-2.64-6.36" />
          <polyline points="21 3 21 9 15 9" />
        </svg>
      </button>
      <button
        class="icon-btn"
        onclick={() => (showPodcasts = true)}
        aria-label="Add from podcast"
        title="Add an episode from a podcast RSS feed"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 11a9 9 0 0 1 9 9" />
          <path d="M4 4a16 16 0 0 1 16 16" />
          <circle cx="5" cy="19" r="1" />
        </svg>
      </button>
      {/if}
      <button
        class="icon-btn"
        onclick={toggleDarkMode}
        aria-label="Toggle dark mode"
      >
        {#if darkMode}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="5" />
            <line x1="12" y1="1" x2="12" y2="3" />
            <line x1="12" y1="21" x2="12" y2="23" />
            <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
            <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
            <line x1="1" y1="12" x2="3" y2="12" />
            <line x1="21" y1="12" x2="23" y2="12" />
            <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
            <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
          </svg>
        {:else}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
          </svg>
        {/if}
      </button>
      </div>
    </div>
  </header>

  {#if !searchQuery.trim() && (activeKind === "All" || activeKind === "Unfinished") && continueBooks.length > 0}
    <section class="continue">
      <h2 class="section-title">Continue</h2>
      <div class="continue-row">
        {#each continueBooks as book (book.id)}
          <div class="continue-item">
            <BookCard
              {book}
              progress={progressByBookId.get(book.id) ?? 0}
              onOpen={onOpenBook}
              onDelete={deleteBook}
              onEdit={(b) => (editingBook = b)}
              downloaded={downloaded.has(book.id)}
              downloading={downloadingIds.has(book.id)}
              progressPct={downloadProgress.get(book.id)}
              offline={!online}
              onToggleDownload={toggleDownload}
            />
          </div>
        {/each}
      </div>
    </section>
  {/if}

  {#if !loaded}
    <!-- Initial load: render nothing so the empty-library state never flashes. -->
  {:else if filteredBooks.length > 0}
    <div class="books-grid">
      {#each filteredBooks as book (book.id)}
        <BookCard
          {book}
          progress={progressByBookId.get(book.id) ?? 0}
          onOpen={onOpenBook}
          onDelete={deleteBook}
          onEdit={(b) => (editingBook = b)}
          downloaded={downloaded.has(book.id)}
          downloading={downloadingIds.has(book.id)}
          progressPct={downloadProgress.get(book.id)}
          offline={!online}
          onToggleDownload={toggleDownload}
        />
      {/each}
    </div>
  {:else if books.length > 0}
    <div class="empty-state">
      <p>
        {#if searchQuery.trim()}
          No books match "{searchQuery}"
        {:else if activeKind === "Unfinished"}
          You're all caught up — nothing unfinished.
        {:else if activeKind === "Finished"}
          Nothing finished yet.
        {:else}
          Nothing here.
        {/if}
      </p>
    </div>
  {:else}
    <div class="empty-state empty-state-onboard">
      <h2>Your library is empty</h2>
      <p>Drop an EPUB, PDF, FB2, CBZ, or audiobook anywhere on this page — or pick one to upload.</p>
      <button class="upload-btn primary" onclick={triggerUpload}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
        Upload your first book
      </button>
    </div>
  {/if}
</div>

{#if editingBook}
  <BookEditModal
    book={editingBook}
    onClose={() => (editingBook = null)}
    onSaved={handleBookSaved}
  />
{/if}

{#if showPodcasts}
  <PodcastModal onClose={() => (showPodcasts = false)} onAdded={fetchBooks} />
{/if}

{#if isDragging}
  <div class="drop-overlay" aria-hidden="true">
    <div class="drop-overlay-inner">
      <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="17 8 12 3 7 8" />
        <line x1="12" y1="3" x2="12" y2="15" />
      </svg>
      <p>Drop to add to your library</p>
    </div>
  </div>
{/if}

<style>
  .container {
    max-width: 1200px;
    margin: 0 auto;
    padding: 2.5rem 2rem 4rem;
  }

  .library-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1.5rem;
    margin-bottom: 2.5rem;
    flex-wrap: wrap;
  }

  .brand {
    display: flex;
    align-items: baseline;
    gap: 0.85rem;
  }

  h1 {
    font-family: var(--font-serif);
    font-size: 2.25rem;
    font-weight: 500;
    letter-spacing: -0.01em;
    color: var(--text);
    line-height: 1;
  }

  .count {
    font-size: 0.85rem;
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
  }

  .offline-pill {
    font-size: 0.72rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
    background: var(--tint);
    border: 1px solid var(--border);
    padding: 0.15rem 0.5rem;
    border-radius: 999px;
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  /* On desktop the groups are transparent: their children lay out directly in
     .header-actions. On mobile they become two stacked rows (see media query). */
  .actions-primary,
  .actions-secondary {
    display: contents;
  }

  .search {
    position: relative;
    display: flex;
    align-items: center;
  }

  .search-icon {
    position: absolute;
    left: 0.7rem;
    color: var(--text);
    pointer-events: none;
  }

  .search-input {
    background: var(--surface);
    border: 1px solid var(--border);
    color: var(--text);
    padding: 0.5rem 0.85rem 0.5rem 2.1rem;
    border-radius: var(--radius);
    font-size: 0.9rem;
    line-height: 1.25;
    width: 180px;
    font-family: inherit;
    transition: border-color 0.15s, box-shadow 0.15s;
  }

  .search-input::placeholder {
    color: var(--text);
  }

  .search-input:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }

  .controls-wrap {
    position: relative;
    display: inline-flex;
  }

  .icon-btn.active {
    border-color: var(--accent);
    color: var(--accent);
  }

  .controls-menu {
    position: absolute;
    top: calc(100% + 0.4rem);
    right: 0;
    z-index: 20;
    min-width: 190px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    padding: 0.4rem;
    display: flex;
    flex-direction: column;
  }

  .menu-heading {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-faint);
    padding: 0.4rem 0.6rem 0.25rem;
  }

  .menu-option {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    background: none;
    border: none;
    cursor: pointer;
    text-align: left;
    padding: 0.5rem 0.6rem;
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    font-family: inherit;
    font-size: 0.9rem;
    transition: background 0.15s, color 0.15s;
  }

  .menu-option:hover {
    background: var(--tint);
    color: var(--text);
  }

  .menu-option.selected {
    color: var(--accent);
    font-weight: 500;
  }

  .menu-divider {
    height: 1px;
    background: var(--border);
    margin: 0.4rem 0.3rem;
  }

  .upload-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    background: var(--accent);
    color: white;
    border: none;
    padding: 0.5rem 0.95rem;
    border-radius: var(--radius);
    font-size: 0.9rem;
    line-height: 1.25;
    font-family: inherit;
    cursor: pointer;
    transition: background 0.15s;
  }

  .upload-btn:hover:not(:disabled) {
    background: var(--accent-hover);
  }

  .upload-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .upload-btn.primary {
    padding: 0.7rem 1.2rem;
    font-size: 1rem;
    margin-top: 1.5rem;
  }

  .icon-btn {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-muted);
    cursor: pointer;
    padding: 0.5rem;
    border-radius: var(--radius);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: background 0.15s, color 0.15s;
  }

  .icon-btn:hover {
    background: var(--surface);
    color: var(--text);
  }

  .icon-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .spinning {
    animation: spin 0.8s linear infinite;
  }

  .spinner-sm {
    width: 14px;
    height: 14px;
    border: 2px solid rgba(255, 255, 255, 0.3);
    border-top-color: white;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    display: inline-block;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .continue {
    margin-bottom: 2.75rem;
  }

  .section-title {
    font-family: var(--font-serif);
    font-size: 1.15rem;
    font-weight: 500;
    color: var(--text);
    margin-bottom: 1.1rem;
  }

  .continue-row {
    display: flex;
    gap: 1.25rem;
    overflow-x: auto;
    padding-bottom: 0.5rem;
    scroll-snap-type: x proximity;
    overscroll-behavior-x: contain;
  }

  .continue-item {
    flex: 0 0 auto;
    width: 150px;
    scroll-snap-align: start;
  }

  .books-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
    gap: 2.25rem 1.25rem;
  }

  .empty-state {
    text-align: center;
    padding: 3rem 1rem;
    color: var(--text-muted);
  }

  .empty-state-onboard {
    padding: 6rem 1rem;
  }

  .empty-state-onboard h2 {
    font-family: var(--font-serif);
    font-size: 1.6rem;
    font-weight: 500;
    color: var(--text);
    margin-bottom: 0.5rem;
  }

  .empty-state-onboard p {
    color: var(--text-muted);
  }

  .drop-overlay {
    position: fixed;
    inset: 0;
    background: var(--drop-overlay-bg);
    backdrop-filter: blur(2px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 2000;
    pointer-events: none;
    animation: fadeIn 0.15s ease-out;
  }

  .drop-overlay-inner {
    background: var(--surface);
    color: var(--accent);
    padding: 2rem 3rem;
    border-radius: var(--radius-lg);
    border: 2px dashed var(--accent);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
    box-shadow: var(--shadow);
  }

  .drop-overlay-inner p {
    font-family: var(--font-serif);
    font-size: 1.1rem;
    color: var(--text);
  }

  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  @media (max-width: 600px) {
    .container {
      padding: 1.5rem 1rem 3rem;
    }
    .library-header {
      margin-bottom: 1.75rem;
    }
    /* Title row holds the icon actions (upload + dark toggle); search + filter
       drop to a full-width row beneath. */
    .library-header {
      display: grid;
      grid-template-columns: 1fr auto;
      grid-template-areas:
        "brand actions"
        "search search";
      align-items: center;
      gap: 0.85rem 0.5rem;
    }
    .brand {
      grid-area: brand;
    }
    .header-actions {
      display: contents;
    }
    .actions-secondary {
      grid-area: actions;
      display: flex;
      align-items: center;
      gap: 0.5rem;
      justify-self: end;
    }
    .actions-primary {
      grid-area: search;
      display: flex;
      gap: 0.5rem;
      width: 100%;
    }
    .search {
      flex: 1 1 auto;
    }
    .search-input {
      width: 100%;
    }
    .select-wrapper {
      flex: 0 0 auto;
    }
    /* Upload becomes an icon-only button on the title row. */
    .upload-label {
      display: none;
    }
    .upload-btn {
      padding: 0.5rem;
    }
    h1 { font-size: 1.85rem; }
    .continue-item { width: 120px; }
    .books-grid {
      grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
      gap: 1.75rem 1rem;
    }
  }
</style>
