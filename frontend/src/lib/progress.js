// Progress logic shared by the library view and the media players, kept pure so
// "how far in are we" and "is this position worth storing" have one definition
// and can be tested without a DOM.

// A started item must never round down to "not started": the library hides
// anything that computes to 0, so a 16-hour audiobook four minutes in used to
// disappear from the Continue shelf entirely.
const asPercent = (fraction) => {
  if (!Number.isFinite(fraction) || fraction <= 0) return 0;
  return Math.min(100, Math.max(1, Math.ceil(fraction * 100)));
};

export function computeProgressPercent(raw) {
  if (!raw) return 0;
  let progress;
  try {
    progress = JSON.parse(raw);
  } catch {
    return 0;
  }
  if (!progress || typeof progress !== "object") return 0;

  if (progress.type === "pdf") {
    if (!(progress.page > 0) || !(progress.totalPages > 0)) return 0;
    return asPercent(progress.page / progress.totalPages);
  }
  if (progress.type === "audio" || progress.type === "video") {
    if (!(progress.duration > 0)) return 0;
    return asPercent(progress.position / progress.duration);
  }
  // Every paginated-text format reports a fraction. Records written by older
  // builds carry types the current format list no longer names, and a fraction
  // is still a fraction, so the display doesn't gate on the type.
  if (typeof progress.fraction === "number") return asPercent(progress.fraction);
  return 0;
}

// A media position is only worth storing once we know what it would overwrite.
// Two cases cost real positions before this guard existed: a player closed
// between "metadata loaded" and the first timeupdate reported position 0
// alongside a valid duration, and a finished item - which deliberately does not
// resume - reported the handful of seconds it was briefly reopened for.
const MIN_SAVE_POSITION = 2;
const RESTART_SAVE_POSITION = 30;
// How close to the end counts as finished, in seconds.
const END_EPSILON = 2;

export function createMediaProgressTracker({ type, resumePosition = 0 }) {
  let duration = 0;
  let ready = false;
  let userSeeked = false;
  let restartedFromEnd = false;

  return {
    // Call once the media's duration is known. Returns the position to seek to,
    // or null to start from wherever the element already is.
    begin(mediaDuration) {
      duration =
        Number.isFinite(mediaDuration) && mediaDuration > 0 ? mediaDuration : 0;
      ready = duration > 0;
      if (!ready || resumePosition <= 0) return null;
      if (resumePosition >= duration - END_EPSILON) {
        // Finished last time, so start over - but hold the completed record
        // until the user has actually got somewhere.
        restartedFromEnd = true;
        return null;
      }
      return resumePosition;
    },

    // The user scrubbed, skipped or jumped to a chapter. Wherever they land is
    // deliberate, including the very start.
    markUserSeek() {
      if (ready) userSeeked = true;
    },

    // The record to store for `position`, or null if storing it would overwrite
    // a real position with a meaningless one.
    snapshot(position) {
      if (!ready) return null;
      const pos = Math.min(
        Math.max(Math.floor(position) || 0, 0),
        Math.floor(duration),
      );
      if (!userSeeked) {
        const floor = restartedFromEnd
          ? Math.min(RESTART_SAVE_POSITION, duration / 2)
          : MIN_SAVE_POSITION;
        if (pos < floor) return null;
      }
      return { type, position: pos, duration: Math.floor(duration) };
    },
  };
}

// Throttle with a trailing call: the first save goes out at once and at most one
// more is queued per interval. A plain debounce was used here before, and since
// `timeupdate` fires about four times a second it reset the timer faster than it
// could ever expire - nothing was stored at all until the media paused.
export function createThrottle(interval, send, clock = {}) {
  const now = clock.now || (() => Date.now());
  const setTimer = clock.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = clock.clearTimer || ((id) => clearTimeout(id));

  // null until the first send, so "never sent" is never mistaken for "just
  // sent" - which it would be on any clock whose origin is near zero.
  let lastSentAt = null;
  let timer = null;
  let pending = null;

  const fire = (value) => {
    lastSentAt = now();
    send(value);
  };

  return {
    call(value) {
      pending = value;
      if (timer !== null) return;
      const wait = lastSentAt === null ? 0 : interval - (now() - lastSentAt);
      if (wait <= 0) {
        pending = null;
        fire(value);
        return;
      }
      timer = setTimer(() => {
        timer = null;
        const queued = pending;
        pending = null;
        if (queued !== null) fire(queued);
      }, wait);
    },

    // Send `value` now, dropping anything queued - for pause, teardown and
    // pagehide, where there is no later chance to flush.
    flush(value) {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      pending = null;
      fire(value);
    },

    dispose() {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      pending = null;
    },
  };
}
