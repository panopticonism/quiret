<script>
  import { onMount } from "svelte";
  import { saveLocalProgress, effectiveProgress } from "../lib/offline.js";

  let { bookId, metadata, onClose } = $props();

  const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
  const SKIP_SECONDS = 30;
  const SLEEP_OPTIONS = [5, 10, 15, 30, 45, 60]; // minutes

  let audioEl = $state(null);
  let playing = $state(false);
  let currentTime = $state(0);
  let duration = $state(0);
  // Initialise from the saved speed synchronously so it's applied even if the
  // audio's loadedmetadata event fires before onMount runs.
  let playbackRate = $state(
    (() => {
      try {
        const r = parseFloat(localStorage.getItem("audioPlaybackRate"));
        if (SPEEDS.includes(r)) return r;
      } catch {}
      return 1;
    })(),
  );
  let chapters = $state([]);
  let showChapters = $state(false);
  let error = $state(null);

  let seeking = false; // true while the user drags the scrubber
  // Parse the resume position at init (not in onMount) so it's ready before the
  // audio element's loadedmetadata event can fire on a fast/cached load.
  let resumePosition = (() => {
    try {
      const raw = effectiveProgress(metadata);
      if (raw) {
        const p = JSON.parse(raw);
        if (p.type === "audio" && p.position) return p.position;
      }
    } catch {}
    return 0;
  })();
  let resumeApplied = false;
  let saveTimeout = null;

  // Sleep timer
  let sleepRemaining = $state(0); // seconds left; 0 = inactive
  let sleepEndOfChapter = $state(false);
  let sleepChapterTarget = null; // playback time (s) at which to pause
  let showSleepMenu = $state(false);
  let sleepInterval = null;
  let sleepDeadline = null; // wall-clock ms deadline while playing; null while paused
  let lastPosUpdate = 0;

  const sleepActive = $derived(sleepRemaining > 0 || sleepEndOfChapter);

  const fileUrl = $derived(`/api/books/${bookId}/file`);

  const currentChapterIndex = $derived.by(() => {
    if (chapters.length === 0) return -1;
    let idx = 0;
    for (let i = 0; i < chapters.length; i++) {
      if (currentTime + 0.5 >= chapters[i].start) idx = i;
      else break;
    }
    return idx;
  });

  const currentChapterTitle = $derived(
    currentChapterIndex >= 0 ? chapters[currentChapterIndex]?.title : null,
  );

  const formatTime = (seconds) => {
    if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
    const total = Math.floor(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  };

  const saveProgress = (immediate = false) => {
    if (!duration) return;
    const progressStr = JSON.stringify({
      type: "audio",
      position: Math.floor(currentTime),
      duration: Math.floor(duration),
    });
    saveLocalProgress(bookId, progressStr);
    const body = JSON.stringify({ progress: progressStr });
    const send = () => {
      fetch(`/api/books/${bookId}/progress`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
      }).catch(() => {});
    };
    if (immediate) {
      if (saveTimeout) clearTimeout(saveTimeout);
      send();
      return;
    }
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(send, 3000);
  };

  const togglePlay = () => {
    if (!audioEl) return;
    if (audioEl.paused) audioEl.play().catch(() => {});
    else audioEl.pause();
  };

  const skip = (delta) => {
    if (!audioEl || !duration) return;
    audioEl.currentTime = Math.min(
      Math.max(audioEl.currentTime + delta, 0),
      duration,
    );
  };

  const seekToChapter = (index) => {
    if (!audioEl || !chapters[index]) return;
    audioEl.currentTime = chapters[index].start;
    showChapters = false;
  };

  const changeChapter = (delta) => {
    const target = currentChapterIndex + delta;
    if (target >= 0 && target < chapters.length) seekToChapter(target);
  };

  const cycleSpeed = () => {
    const idx = SPEEDS.indexOf(playbackRate);
    playbackRate = SPEEDS[(idx + 1) % SPEEDS.length];
    if (audioEl) audioEl.playbackRate = playbackRate;
    localStorage.setItem("audioPlaybackRate", String(playbackRate));
    updateMediaPosition();
  };

  const clearSleepTimer = () => {
    sleepRemaining = 0;
    sleepEndOfChapter = false;
    sleepChapterTarget = null;
    sleepDeadline = null;
    if (sleepInterval) {
      clearInterval(sleepInterval);
      sleepInterval = null;
    }
  };

  // Remaining seconds. While playing we derive it from a wall-clock deadline so it
  // stays accurate even when the tab is backgrounded and JS timers are throttled;
  // while paused the frozen `sleepRemaining` is authoritative.
  const sleepTimeRemaining = () =>
    sleepDeadline != null
      ? Math.max(0, Math.round((sleepDeadline - Date.now()) / 1000))
      : sleepRemaining;

  const expireSleepTimer = () => {
    clearSleepTimer();
    audioEl?.pause();
  };

  const startSleepTimer = (minutes) => {
    clearSleepTimer();
    sleepRemaining = minutes * 60;
    showSleepMenu = false;
    if (playing) sleepDeadline = Date.now() + sleepRemaining * 1000;
    sleepInterval = setInterval(() => {
      if (sleepDeadline == null) return; // paused: hold the frozen value
      sleepRemaining = sleepTimeRemaining();
      if (sleepRemaining <= 0) expireSleepTimer();
    }, 1000);
  };

  const setSleepEndOfChapter = () => {
    clearSleepTimer();
    sleepEndOfChapter = true;
    showSleepMenu = false;
    const next = chapters[currentChapterIndex + 1];
    sleepChapterTarget = next ? next.start : duration || null;
  };

  const onScrubInput = (event) => {
    seeking = true;
    currentTime = Number(event.target.value);
  };

  const onScrubChange = (event) => {
    if (audioEl) audioEl.currentTime = Number(event.target.value);
    seeking = false;
  };

  const onLoadedMetadata = () => {
    duration = audioEl.duration || 0;
    audioEl.playbackRate = playbackRate;
    if (!resumeApplied && resumePosition > 0 && resumePosition < duration - 2) {
      audioEl.currentTime = resumePosition;
    }
    resumeApplied = true;
    updateMediaPosition();
  };

  const onTimeUpdate = () => {
    if (seeking) return;
    currentTime = audioEl.currentTime;

    // Media elements keep firing timeupdate while playing in the background, so
    // this is the reliable place to fire the sleep timer once the screen is locked.
    if (sleepDeadline != null && Date.now() >= sleepDeadline) {
      expireSleepTimer();
      return;
    }
    if (
      sleepEndOfChapter &&
      sleepChapterTarget != null &&
      currentTime >= sleepChapterTarget - 0.25
    ) {
      expireSleepTimer();
    }

    const now = Date.now();
    if (now - lastPosUpdate > 1000) {
      lastPosUpdate = now;
      updateMediaPosition();
    }
    saveProgress();
  };

  const handleKeyPress = (event) => {
    const tag = event.target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    switch (event.key) {
      case "Escape":
        if (showSleepMenu) showSleepMenu = false;
        else if (showChapters) showChapters = false;
        else onClose();
        break;
      case " ":
      case "k":
        event.preventDefault();
        togglePlay();
        break;
      case "ArrowRight":
        skip(SKIP_SECONDS);
        break;
      case "ArrowLeft":
        skip(-SKIP_SECONDS);
        break;
    }
  };

  // Feed the OS/lock-screen media controls a live position so the scrubber and
  // elapsed time stay in sync while the app is backgrounded.
  const updateMediaPosition = () => {
    if (!("mediaSession" in navigator)) return;
    if (typeof navigator.mediaSession.setPositionState !== "function") return;
    if (!Number.isFinite(duration) || duration <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration,
        playbackRate: audioEl?.playbackRate || playbackRate,
        position: Math.min(Math.max(currentTime, 0), duration),
      });
    } catch {}
  };

  const handlePlay = () => {
    playing = true;
    // Anchor the sleep timer to a fresh wall-clock deadline on each resume.
    if (sleepRemaining > 0 && !sleepEndOfChapter) {
      sleepDeadline = Date.now() + sleepRemaining * 1000;
    }
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
    updateMediaPosition();
  };

  const handlePause = () => {
    playing = false;
    // Freeze the countdown while paused so time doesn't elapse in the background.
    if (sleepDeadline != null) {
      sleepRemaining = sleepTimeRemaining();
      sleepDeadline = null;
    }
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
    saveProgress(true);
  };

  const setupMediaSession = () => {
    if (!("mediaSession" in navigator)) return;

    // Lock-screen artwork. Declare the cover as "any" size (its real dimensions
    // vary, and a wrong size claim makes iOS pad the slot with white). Always
    // append the square, full-bleed app icon as a reliable fallback so a
    // cover-less book never shows a blank/white placeholder.
    const artwork = [];
    if (metadata?.coverPath) {
      artwork.push({
        src: `/api/books/${bookId}/cover`,
        sizes: "any",
        type: "image/jpeg",
      });
    }
    artwork.push(
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    );

    navigator.mediaSession.metadata = new MediaMetadata({
      title: metadata?.title || "Audiobook",
      artist: metadata?.author || "",
      album: metadata?.title || "",
      artwork,
    });
    const set = (action, handler) => {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch {}
    };
    set("play", () => audioEl?.play());
    set("pause", () => audioEl?.pause());
    set("seekbackward", (d) => skip(-(d?.seekOffset || SKIP_SECONDS)));
    set("seekforward", (d) => skip(d?.seekOffset || SKIP_SECONDS));
    set("previoustrack", chapters.length ? () => changeChapter(-1) : null);
    set("nexttrack", chapters.length ? () => changeChapter(1) : null);
    set("seekto", (details) => {
      if (audioEl && details.seekTime != null) {
        audioEl.currentTime = details.seekTime;
        currentTime = details.seekTime;
        updateMediaPosition();
      }
    });
    navigator.mediaSession.playbackState = playing ? "playing" : "paused";
    updateMediaPosition();
  };

  onMount(() => {
    fetch(`/api/books/${bookId}/chapters`)
      .then((res) => (res.ok ? res.json() : []))
      .then((data) => {
        chapters = Array.isArray(data) ? data : [];
        setupMediaSession();
      })
      .catch(() => {});

    const flushSave = () => saveProgress(true);
    window.addEventListener("pagehide", flushSave);

    return () => {
      window.removeEventListener("pagehide", flushSave);
      if (saveTimeout) clearTimeout(saveTimeout);
      if (sleepInterval) clearInterval(sleepInterval);
      saveProgress(true);
    };
  });
</script>

<svelte:window onkeydown={handleKeyPress} />

<audio
  bind:this={audioEl}
  src={fileUrl}
  preload="metadata"
  onloadedmetadata={onLoadedMetadata}
  ontimeupdate={onTimeUpdate}
  onplay={handlePlay}
  onpause={handlePause}
  onended={() => {
    playing = false;
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "none";
  }}
  onerror={() => (error = "Failed to load audio")}
></audio>

<div class="player">
  <button class="close-btn" onclick={onClose} aria-label="Back to library">
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M19 12H5M12 19l-7-7 7-7" />
    </svg>
    Back to Library
  </button>

  {#if chapters.length > 0}
    <button
      class="chapters-toggle"
      onclick={() => (showChapters = !showChapters)}
      aria-label="Chapters"
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="8" y1="6" x2="21" y2="6" />
        <line x1="8" y1="12" x2="21" y2="12" />
        <line x1="8" y1="18" x2="21" y2="18" />
        <line x1="3" y1="6" x2="3.01" y2="6" />
        <line x1="3" y1="12" x2="3.01" y2="12" />
        <line x1="3" y1="18" x2="3.01" y2="18" />
      </svg>
    </button>
  {/if}

  <div class="stage">
    <div class="cover">
      {#if metadata?.coverPath}
        <img src="/api/books/{bookId}/cover" alt={metadata?.title} />
      {:else}
        <div class="no-cover">
          <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M5 14v-2a7 7 0 0 1 14 0v2" />
            <path d="M7 14v4a1 1 0 0 1-1 1 3 3 0 0 1-3-3 3 3 0 0 1 3-3 1 1 0 0 1 1 1z" fill="currentColor" stroke="none" />
            <path d="M17 14v4a1 1 0 0 0 1 1 3 3 0 0 0 3-3 3 3 0 0 0-3-3 1 1 0 0 0-1 1z" fill="currentColor" stroke="none" />
          </svg>
        </div>
      {/if}
    </div>

    <div class="meta">
      <h1>{metadata?.title || "Audiobook"}</h1>
      {#if metadata?.author}
        <p class="author">{metadata.author}</p>
      {/if}
      {#if currentChapterTitle}
        <p class="chapter-now">{currentChapterTitle}</p>
      {/if}
    </div>

    {#if error}
      <p class="error">{error}</p>
    {/if}

    <div class="scrubber">
      <span class="time">{formatTime(currentTime)}</span>
      <input
        type="range"
        min="0"
        max={duration || 0}
        step="1"
        value={currentTime}
        oninput={onScrubInput}
        onchange={onScrubChange}
        aria-label="Seek"
        style="--fill: {duration ? (currentTime / duration) * 100 : 0}%"
      />
      <span class="time">-{formatTime(Math.max(duration - currentTime, 0))}</span>
    </div>

    <div class="controls">
      {#if chapters.length > 0}
        <button
          class="ctrl secondary"
          onclick={() => changeChapter(-1)}
          disabled={currentChapterIndex <= 0}
          aria-label="Previous chapter"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
            <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" />
          </svg>
        </button>
      {/if}

      <button class="ctrl skip" onclick={() => skip(-SKIP_SECONDS)} aria-label="Back {SKIP_SECONDS} seconds">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
          <path d="M3 3v5h5" />
          <text x="12.2" y="15" text-anchor="middle" font-size="8" font-weight="600" fill="currentColor" stroke="none">{SKIP_SECONDS}</text>
        </svg>
      </button>

      <button class="ctrl play" onclick={togglePlay} aria-label={playing ? "Pause" : "Play"}>
        {#if playing}
          <svg width="34" height="34" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="5" width="4" height="14" rx="1" />
            <rect x="14" y="5" width="4" height="14" rx="1" />
          </svg>
        {:else}
          <svg width="34" height="34" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5v14l11-7z" />
          </svg>
        {/if}
      </button>

      <button class="ctrl skip" onclick={() => skip(SKIP_SECONDS)} aria-label="Forward {SKIP_SECONDS} seconds">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12a9 9 0 1 1-9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
          <path d="M21 3v5h-5" />
          <text x="11.8" y="15" text-anchor="middle" font-size="8" font-weight="600" fill="currentColor" stroke="none">{SKIP_SECONDS}</text>
        </svg>
      </button>

      {#if chapters.length > 0}
        <button
          class="ctrl secondary"
          onclick={() => changeChapter(1)}
          disabled={currentChapterIndex >= chapters.length - 1}
          aria-label="Next chapter"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
            <path d="M16 6h2v12h-2zM6 6v12l8.5-6z" />
          </svg>
        </button>
      {/if}
    </div>

    <div class="bottom-row">
      <button class="pill-btn" onclick={cycleSpeed} aria-label="Playback speed">
        {playbackRate}&times;
      </button>

      <div class="sleep-wrap">
        <button
          class="pill-btn"
          class:active={sleepActive}
          onclick={() => (showSleepMenu = !showSleepMenu)}
          aria-label="Sleep timer"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2a10 10 0 1 0 10 10c0-.5-.03-1-.1-1.48A6 6 0 0 1 13.5 2.1c-.48-.07-.98-.1-1.5-.1z" />
          </svg>
          {#if sleepRemaining > 0}
            {formatTime(sleepRemaining)}
          {:else if sleepEndOfChapter}
            End of ch.
          {:else}
            Sleep
          {/if}
        </button>

        {#if showSleepMenu}
          <div class="sleep-menu" role="menu">
            {#each SLEEP_OPTIONS as m}
              <button role="menuitem" onclick={() => startSleepTimer(m)}>
                {m} minutes
              </button>
            {/each}
            {#if chapters.length > 0}
              <button role="menuitem" onclick={setSleepEndOfChapter}>
                End of chapter
              </button>
            {/if}
            {#if sleepActive}
              <button
                class="off"
                role="menuitem"
                onclick={() => {
                  clearSleepTimer();
                  showSleepMenu = false;
                }}
              >
                Turn off
              </button>
            {/if}
          </div>
        {/if}
      </div>
    </div>
  </div>

  {#if showChapters}
    <div class="chapters-panel">
      <div class="chapters-head">
        <h2>Chapters</h2>
        <button class="panel-close" onclick={() => (showChapters = false)} aria-label="Close chapters">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
      <ul>
        {#each chapters as chapter, i (i)}
          <li>
            <button
              class="chapter-item"
              class:active={i === currentChapterIndex}
              onclick={() => seekToChapter(i)}
            >
              <span class="chapter-title">{chapter.title || `Chapter ${i + 1}`}</span>
              <span class="chapter-time">{formatTime(chapter.start)}</span>
            </button>
          </li>
        {/each}
      </ul>
    </div>
  {/if}
</div>

<style>
  .player {
    position: fixed;
    inset: 0;
    background: var(--bg);
    z-index: 1000;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 1.5rem;
  }

  .close-btn {
    position: fixed;
    top: 1rem;
    left: 1rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    background: none;
    border: none;
    cursor: pointer;
    font-size: 0.95rem;
    color: var(--text-muted);
    padding: 0.45rem 0.85rem;
    border-radius: var(--radius);
    font-family: inherit;
    transition: background 0.15s, color 0.15s;
  }

  .close-btn:hover {
    background: var(--tint);
    color: var(--text);
  }

  .chapters-toggle {
    position: fixed;
    top: 1rem;
    right: 1rem;
    background: none;
    border: none;
    cursor: pointer;
    padding: 0.5rem;
    border-radius: var(--radius);
    color: var(--text-muted);
    transition: background 0.15s, color 0.15s;
  }

  .chapters-toggle:hover {
    background: var(--tint);
    color: var(--text);
  }

  .stage {
    width: 100%;
    max-width: 420px;
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  .cover {
    width: min(60vw, 280px);
    aspect-ratio: 1 / 1;
    border-radius: var(--radius-lg);
    overflow: hidden;
    box-shadow: var(--shadow);
    background: var(--surface-muted);
    border: 1px solid var(--border);
  }

  .cover img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .no-cover {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-faint);
  }

  .meta {
    text-align: center;
    margin: 1.75rem 0 0.5rem;
    max-width: 100%;
  }

  .meta h1 {
    font-family: var(--font-serif);
    font-size: 1.4rem;
    font-weight: 500;
    color: var(--text);
    line-height: 1.3;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .author {
    color: var(--text-muted);
    font-style: italic;
    margin-top: 0.35rem;
    font-size: 0.95rem;
  }

  .chapter-now {
    color: var(--accent);
    margin-top: 0.6rem;
    font-size: 0.85rem;
    font-weight: 500;
  }

  .error {
    color: var(--danger);
    margin-top: 1rem;
  }

  .scrubber {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    margin-top: 2rem;
  }

  .time {
    font-size: 0.8rem;
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
    min-width: 44px;
    text-align: center;
  }

  input[type="range"] {
    flex: 1;
    -webkit-appearance: none;
    appearance: none;
    height: 6px;
    border-radius: 3px;
    background: linear-gradient(
      to right,
      var(--accent) var(--fill),
      var(--progress-track) var(--fill)
    );
    cursor: pointer;
    outline: none;
  }

  input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: var(--shadow-sm);
    cursor: pointer;
  }

  input[type="range"]::-moz-range-thumb {
    width: 16px;
    height: 16px;
    border: none;
    border-radius: 50%;
    background: var(--accent);
    cursor: pointer;
  }

  .controls {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    margin-top: 2rem;
  }

  .ctrl {
    position: relative;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0.5rem;
    border-radius: 50%;
    transition: background 0.15s, color 0.15s, opacity 0.15s;
  }

  .ctrl:hover:not(:disabled) {
    background: var(--tint);
  }

  .ctrl:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }

  .ctrl.secondary {
    color: var(--text-muted);
  }

  .ctrl.skip text {
    font-family: var(--font-sans);
    font-variant-numeric: tabular-nums;
  }

  .ctrl.play {
    background: var(--accent);
    color: white;
    width: 68px;
    height: 68px;
  }

  .ctrl.play:hover:not(:disabled) {
    background: var(--accent-hover);
  }

  .bottom-row {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.6rem;
    margin-top: 1.75rem;
  }

  .pill-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    background: var(--tint);
    border: 1px solid var(--border);
    color: var(--text-muted);
    cursor: pointer;
    padding: 0.4rem 0.9rem;
    border-radius: var(--radius);
    font-size: 0.85rem;
    font-family: inherit;
    font-variant-numeric: tabular-nums;
    transition: background 0.15s, color 0.15s, border-color 0.15s;
  }

  .pill-btn:hover {
    background: var(--tint-strong);
    color: var(--text);
  }

  .pill-btn.active {
    color: var(--accent);
    border-color: var(--accent);
    background: var(--accent-soft);
  }

  .sleep-wrap {
    position: relative;
  }

  .sleep-menu {
    position: absolute;
    bottom: calc(100% + 0.5rem);
    left: 50%;
    transform: translateX(-50%);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    padding: 0.35rem;
    display: flex;
    flex-direction: column;
    min-width: 150px;
    z-index: 1003;
  }

  .sleep-menu button {
    background: none;
    border: none;
    cursor: pointer;
    text-align: left;
    padding: 0.55rem 0.7rem;
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    font-family: inherit;
    font-size: 0.88rem;
    transition: background 0.15s, color 0.15s;
  }

  .sleep-menu button:hover {
    background: var(--tint);
    color: var(--text);
  }

  .sleep-menu button.off {
    color: var(--danger);
    border-top: 1px solid var(--border);
    margin-top: 0.2rem;
  }

  .chapters-panel {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(360px, 88vw);
    background: var(--surface);
    border-left: 1px solid var(--border);
    box-shadow: var(--shadow);
    z-index: 1002;
    display: flex;
    flex-direction: column;
    animation: slideIn 0.2s ease-out;
  }

  @keyframes slideIn {
    from { transform: translateX(100%); }
    to { transform: translateX(0); }
  }

  .chapters-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1.1rem 1.25rem;
    border-bottom: 1px solid var(--border);
  }

  .chapters-head h2 {
    font-family: var(--font-serif);
    font-size: 1.1rem;
    font-weight: 500;
    color: var(--text);
  }

  .panel-close {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-muted);
    padding: 0.35rem;
    border-radius: var(--radius);
    display: flex;
  }

  .panel-close:hover {
    background: var(--tint);
    color: var(--text);
  }

  .chapters-panel ul {
    list-style: none;
    margin: 0;
    padding: 0.5rem;
    overflow-y: auto;
    flex: 1;
  }

  .chapter-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    cursor: pointer;
    padding: 0.7rem 0.75rem;
    border-radius: var(--radius);
    color: var(--text-muted);
    font-family: inherit;
    font-size: 0.9rem;
    transition: background 0.15s, color 0.15s;
  }

  .chapter-item:hover {
    background: var(--tint);
    color: var(--text);
  }

  .chapter-item.active {
    color: var(--accent);
    background: var(--accent-soft);
    font-weight: 500;
  }

  .chapter-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chapter-time {
    font-size: 0.78rem;
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }
</style>
