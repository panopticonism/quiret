<script>
  import { AUDIO_FORMATS } from "../lib/constants.js";

  let { book, progress = 0, onOpen, onDelete, onEdit } = $props();

  const isAudio = $derived(AUDIO_FORMATS.includes(book.fileType));
  const coverSrc = $derived(
    `/api/books/${book.id}/cover${book._cacheBust ? `?v=${book._cacheBust}` : ""}`,
  );
</script>

<article class="book-card">
  <button
    type="button"
    class="book-card-main"
    onclick={() => onOpen(book.id)}
  >
    <div class="cover-container">
      {#if book.coverPath}
        {#if isAudio}
          <div class="cover-blur" style="background-image: url('{coverSrc}')"></div>
          <img class="cover-fg" src={coverSrc} alt={book.title} loading="lazy" />
        {:else}
          <img src={coverSrc} alt={book.title} loading="lazy" />
        {/if}
      {:else}
        <div class="no-cover">
          <span class="no-cover-title">{book.title}</span>
        </div>
      {/if}
      <span class="file-type-tag">
        {book.fileType?.toUpperCase() || "EPUB"}
      </span>
      {#if isAudio}
        <span class="audio-badge" aria-label="Audiobook">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M5 14v-2a7 7 0 0 1 14 0v2" />
            <path d="M7 14v4a1 1 0 0 1-1 1 3 3 0 0 1-3-3 3 3 0 0 1 3-3 1 1 0 0 1 1 1z" fill="currentColor" stroke="none" />
            <path d="M17 14v4a1 1 0 0 0 1 1 3 3 0 0 0 3-3 3 3 0 0 0-3-3 1 1 0 0 0-1 1z" fill="currentColor" stroke="none" />
          </svg>
        </span>
      {/if}
      {#if progress > 0}
        <div class="progress-indicator" aria-label="Reading progress">
          <div class="progress-fill" style="width: {progress}%"></div>
        </div>
      {/if}
    </div>
    <div class="book-info">
      <h3>{book.title}</h3>
      <p>{book.author || "Unknown"}</p>
    </div>
  </button>
  {#if onEdit}
    <button
      type="button"
      class="edit-btn"
      onclick={() => onEdit(book)}
      aria-label="Edit details"
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
      </svg>
    </button>
  {/if}
  <button
    type="button"
    class="delete-btn"
    onclick={() => onDelete(book.id, book.title)}
    aria-label="Delete book"
  >
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2.5"
    >
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  </button>
</article>

<style>
  .book-card {
    position: relative;
    transition: transform 0.15s;
  }

  .book-card:hover {
    transform: translateY(-2px);
  }

  .book-card-main {
    display: block;
    width: 100%;
    cursor: pointer;
    border: none;
    padding: 0;
    background: none;
    text-align: left;
    font-family: inherit;
    color: inherit;
  }

  .cover-container {
    position: relative;
    aspect-ratio: 2 / 3;
    border-radius: var(--radius);
    overflow: hidden;
    background: var(--surface-muted);
    box-shadow: var(--shadow);
    border: 1px solid var(--border);
  }

  .book-card img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  /* Audio covers (podcast/album art) are often square; show the whole cover
     on a blurred fill of itself instead of cropping it into the 2:3 card. */
  .cover-blur {
    position: absolute;
    inset: 0;
    background-size: cover;
    background-position: center;
    filter: blur(22px) brightness(0.8) saturate(1.1);
    transform: scale(1.2);
  }

  .cover-fg {
    position: absolute;
    inset: 0;
  }

  .book-card img.cover-fg {
    object-fit: contain;
    padding: 0.55rem;
  }

  .no-cover {
    width: 100%;
    height: 100%;
    background: var(--surface-muted);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
    color: var(--text);
  }

  .no-cover-title {
    font-family: var(--font-serif);
    font-size: 1rem;
    line-height: 1.3;
    text-align: center;
    display: -webkit-box;
    -webkit-line-clamp: 6;
    line-clamp: 6;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .file-type-tag {
    position: absolute;
    bottom: 0.5rem;
    left: 0.5rem;
    background: var(--tag-bg);
    color: var(--tag-text);
    font-size: 0.6rem;
    font-weight: 600;
    padding: 2px 6px;
    border-radius: 3px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .audio-badge {
    position: absolute;
    top: 0.5rem;
    left: 0.5rem;
    background: var(--accent);
    color: white;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: var(--shadow-sm);
  }

  .progress-indicator {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    height: 5px;
    background: var(--progress-track);
    box-shadow: inset 0 1px 0 rgba(0, 0, 0, 0.3);
  }

  .progress-fill {
    height: 100%;
    background: var(--progress-fill);
    transition: width 0.3s ease;
  }

  .delete-btn {
    position: absolute;
    top: 0.4rem;
    right: 0.4rem;
    background: var(--overlay-button-bg);
    color: white;
    border: none;
    border-radius: 50%;
    width: 24px;
    height: 24px;
    padding: 0;
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.15s, background 0.15s;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .book-card:hover .delete-btn,
  .delete-btn:focus-visible {
    opacity: 1;
  }

  .delete-btn:hover {
    background: var(--danger);
  }

  .edit-btn {
    position: absolute;
    top: 0.4rem;
    right: 2.4rem;
    background: var(--overlay-button-bg);
    color: white;
    border: none;
    border-radius: 50%;
    width: 24px;
    height: 24px;
    padding: 0;
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.15s, background 0.15s;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .book-card:hover .edit-btn,
  .edit-btn:focus-visible {
    opacity: 1;
  }

  .edit-btn:hover {
    background: var(--accent);
  }

  .book-info {
    padding: 0.85rem 0.25rem 0;
  }

  .book-info h3 {
    font-size: 0.9rem;
    font-weight: 500;
    color: var(--text);
    line-height: 1.3;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    margin-bottom: 0.2rem;
  }

  .book-info p {
    font-size: 0.8rem;
    color: var(--text-muted);
    font-style: italic;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
