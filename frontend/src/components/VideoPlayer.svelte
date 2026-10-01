<script>
  import { onMount } from "svelte";
  import { saveLocalProgress, effectiveProgress } from "../lib/offline.js";

  let { bookId, metadata, onClose } = $props();

  let videoEl = $state(null);
  let error = $state(null);
  let resumeApplied = false;
  let saveTimeout = null;

  const fileUrl = $derived(`/api/books/${bookId}/file`);

  const resumePosition = (() => {
    try {
      const raw = effectiveProgress(metadata);
      if (raw) {
        const p = JSON.parse(raw);
        if (p.type === "video" && p.position) return p.position;
      }
    } catch {}
    return 0;
  })();

  const save = (immediate = false) => {
    if (!videoEl || !videoEl.duration) return;
    const progressStr = JSON.stringify({
      type: "video",
      position: Math.floor(videoEl.currentTime),
      duration: Math.floor(videoEl.duration),
    });
    saveLocalProgress(bookId, progressStr);
    const send = () =>
      fetch(`/api/books/${bookId}/progress`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ progress: progressStr }),
        keepalive: true,
      }).catch(() => {});
    if (saveTimeout) clearTimeout(saveTimeout);
    if (immediate) {
      send();
      return;
    }
    saveTimeout = setTimeout(send, 3000);
  };

  const onLoaded = () => {
    const d = videoEl.duration || 0;
    if (!resumeApplied && resumePosition > 0 && resumePosition < d - 2) {
      videoEl.currentTime = resumePosition;
    }
    resumeApplied = true;
  };

  const handleKey = (e) => {
    if (e.key === "Escape") onClose();
  };

  onMount(() => {
    const flush = () => save(true);
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      if (saveTimeout) clearTimeout(saveTimeout);
      save(true);
    };
  });
</script>

<svelte:window onkeydown={handleKey} />

<div class="video-wrap">
  <button class="close-btn" onclick={onClose} aria-label="Back to library">
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M19 12H5M12 19l-7-7 7-7" />
    </svg>
    Back to Library
  </button>

  <div class="stage">
    {#if error}
      <p class="error">{error}</p>
    {/if}
    <!-- svelte-ignore a11y_media_has_caption -->
    <video
      bind:this={videoEl}
      src={fileUrl}
      controls
      playsinline
      preload="metadata"
      onloadedmetadata={onLoaded}
      ontimeupdate={() => save()}
      onpause={() => save(true)}
      onerror={() =>
        (error =
          "This video couldn't be played — the format or codec may be unsupported by your browser.")}
    ></video>
    {#if metadata?.title}
      <h1 class="video-title">{metadata.title}</h1>
    {/if}
  </div>
</div>

<style>
  .video-wrap {
    position: fixed;
    inset: 0;
    background: #000;
    z-index: 1000;
    display: flex;
    flex-direction: column;
  }

  .close-btn {
    position: fixed;
    top: 1rem;
    left: 1rem;
    z-index: 2;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    background: rgba(0, 0, 0, 0.5);
    border: none;
    cursor: pointer;
    font-size: 0.95rem;
    color: #fff;
    padding: 0.45rem 0.85rem;
    border-radius: var(--radius);
    font-family: inherit;
    transition: background 0.15s;
  }

  .close-btn:hover {
    background: rgba(0, 0, 0, 0.75);
  }

  .stage {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1rem;
    padding: 1rem;
    min-height: 0;
  }

  video {
    max-width: 100%;
    max-height: 85vh;
    background: #000;
    border-radius: var(--radius);
  }

  .video-title {
    color: #e8edf5;
    font-family: var(--font-serif);
    font-size: 1.1rem;
    font-weight: 500;
    text-align: center;
    max-width: 90%;
  }

  .error {
    color: #ff8a8a;
    text-align: center;
    max-width: 80%;
  }
</style>
