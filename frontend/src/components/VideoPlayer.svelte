<script>
  import { onMount } from "svelte";
  import { saveLocalProgress, effectiveProgress, pushProgress } from "../lib/offline.js";
  import { createMediaProgressTracker, createThrottle } from "../lib/progress.js";

  let { bookId, metadata, onClose } = $props();

  let videoEl = $state(null);
  let error = $state(null);
  // True only while the resume seek we issued ourselves is in flight, so it
  // isn't mistaken for the user scrubbing.
  let resumeSeeking = false;

  const SAVE_INTERVAL = 5000;

  const fileUrl = $derived(`/api/books/${bookId}/file`);

  const tracker = createMediaProgressTracker({
    type: "video",
    resumePosition: (() => {
      try {
        const raw = effectiveProgress(metadata);
        if (raw) {
          const p = JSON.parse(raw);
          if (p.type === "video" && p.position) return p.position;
        }
      } catch {}
      return 0;
    })(),
  });
  const saver = createThrottle(SAVE_INTERVAL, (progressStr) =>
    pushProgress(bookId, progressStr),
  );

  const save = (immediate = false) => {
    if (!videoEl) return;
    const record = tracker.snapshot(videoEl.currentTime);
    if (!record) return;
    const progressStr = JSON.stringify(record);
    // Mirror locally on every save; only the network push is throttled.
    saveLocalProgress(bookId, progressStr);
    if (immediate) saver.flush(progressStr);
    else saver.call(progressStr);
  };

  const onLoaded = () => {
    const seekTo = tracker.begin(videoEl.duration);
    if (seekTo !== null) {
      resumeSeeking = true;
      videoEl.currentTime = seekTo;
    }
  };

  // Native controls are the only scrubber here, so a seek event is how a
  // deliberate jump makes itself known.
  const onSeeked = () => {
    if (resumeSeeking) {
      resumeSeeking = false;
      return;
    }
    tracker.markUserSeek();
    save(true);
  };

  const handleKey = (e) => {
    if (e.key === "Escape") onClose();
  };

  onMount(() => {
    const flush = () => save(true);
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      save(true);
      saver.dispose();
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
      onseeked={onSeeked}
      onended={() => save(true)}
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
