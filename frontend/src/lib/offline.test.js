import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// offline.js reads browser globals lazily inside each function, so stubbing them
// on globalThis before the calls is enough; no DOM is needed.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const setOnline = (onLine) => {
  Object.defineProperty(globalThis, "navigator", {
    value: { onLine },
    configurable: true,
    writable: true,
  });
};

const {
  saveLocalProgress,
  getLocalProgress,
  markLocalProgressSynced,
  effectiveProgress,
  pendingLocalProgress,
} = await import("./offline.js");

const POS_200 = '{"type":"audio","position":200,"duration":2532}';
const POS_900 = '{"type":"audio","position":900,"duration":2532}';

beforeEach(() => {
  store.clear();
  setOnline(true);
});

afterEach(() => {
  store.clear();
});

describe("local progress mirror", () => {
  test("a book with no local mirror uses the server's progress", () => {
    const book = { id: "b1", readingProgress: POS_900 };
    assert.equal(effectiveProgress(book), POS_900);
  });

  test("a book with neither reads as empty", () => {
    assert.equal(effectiveProgress({ id: "b1" }), "");
    assert.equal(effectiveProgress(null), "");
  });

  test("an unsynced local save wins over the server", () => {
    saveLocalProgress("b1", POS_900);
    const book = {
      id: "b1",
      readingProgress: POS_200,
      progressUpdatedAt: "2026-10-04T20:29:13Z",
    };
    assert.equal(effectiveProgress(book), POS_900);
  });

  test("an unsynced local save wins while offline", () => {
    setOnline(false);
    saveLocalProgress("b1", POS_900);
    const book = { id: "b1", readingProgress: POS_200 };
    assert.equal(effectiveProgress(book), POS_900);
  });

  // The clock-skew failure: effectiveProgress used to weigh the browser's
  // Date.now() against the server's timestamp. On a device whose clock runs
  // ahead, an already-synced mirror entry shadowed newer progress from another
  // device for as long as the skew lasted - and flushLocalProgress then pushed
  // that stale value back up, destroying the newer position. Stated against the
  // plain save/read API so it holds whatever the sync bookkeeping looks like.
  test("a device clock running ahead does not pin a stale local position", () => {
    const realNow = Date.now;
    // This device's clock is four days fast when it saves and syncs.
    Date.now = () => Date.parse("2026-11-01T00:00:00Z");
    try {
      saveLocalProgress("b1", POS_200);
      markLocalProgressSynced("b1", POS_200);
    } finally {
      Date.now = realNow;
    }

    // Another device then genuinely moved further along, later in real time.
    const book = {
      id: "b1",
      readingProgress: POS_900,
      progressUpdatedAt: "2026-10-29T00:00:00Z",
    };
    assert.equal(effectiveProgress(book), POS_900);
  });

  test("a synced local mirror never shadows the server, whatever the clock says", () => {
    saveLocalProgress("b1", POS_200);
    markLocalProgressSynced("b1", POS_200);

    // Another device has since moved further along.
    const book = {
      id: "b1",
      readingProgress: POS_900,
      progressUpdatedAt: "2026-10-05T09:00:00Z",
    };
    assert.equal(effectiveProgress(book), POS_900);
  });

  test("a synced mirror is not queued for flushing", () => {
    saveLocalProgress("b1", POS_200);
    markLocalProgressSynced("b1", POS_200);
    const book = {
      id: "b1",
      readingProgress: POS_900,
      progressUpdatedAt: "2026-10-05T09:00:00Z",
    };
    assert.deepEqual(pendingLocalProgress([book]), []);
  });

  test("an unsynced mirror is queued for flushing", () => {
    saveLocalProgress("b1", POS_900);
    const book = { id: "b1", readingProgress: POS_200 };
    assert.deepEqual(pendingLocalProgress([book]), [
      { id: "b1", progress: POS_900 },
    ]);
  });

  test("a mirror the server already agrees with is not queued", () => {
    saveLocalProgress("b1", POS_900);
    const book = { id: "b1", readingProgress: POS_900 };
    assert.deepEqual(pendingLocalProgress([book]), []);
  });

  test("marking a stale value synced does not clear a newer local save", () => {
    saveLocalProgress("b1", POS_200);
    saveLocalProgress("b1", POS_900);
    // A slow PUT for the earlier position lands after the later local save.
    markLocalProgressSynced("b1", POS_200);
    const book = { id: "b1", readingProgress: POS_200 };
    assert.equal(effectiveProgress(book), POS_900);
    assert.deepEqual(pendingLocalProgress([book]), [
      { id: "b1", progress: POS_900 },
    ]);
  });

  test("a corrupt mirror entry is ignored rather than thrown", () => {
    store.set("quiret:progress:b1", "{not json");
    assert.equal(getLocalProgress("b1"), null);
    assert.equal(effectiveProgress({ id: "b1", readingProgress: POS_900 }), POS_900);
  });
});

describe("mirror entries written by an older build", () => {
  // The pre-sync-flag format: {progress, at}. Those were pushed to the server on
  // every save, so replaying them would stamp stale positions over newer work.
  const legacy = (progress) =>
    store.set(
      "quiret:progress:b1",
      JSON.stringify({ progress, at: Date.parse("2026-11-01T00:00:00Z") }),
    );

  test("do not shadow the server", () => {
    legacy(POS_200);
    const book = {
      id: "b1",
      readingProgress: POS_900,
      progressUpdatedAt: "2026-10-29T00:00:00Z",
    };
    assert.equal(effectiveProgress(book), POS_900);
  });

  test("are not queued for flushing", () => {
    legacy(POS_200);
    const book = { id: "b1", readingProgress: POS_900 };
    assert.deepEqual(pendingLocalProgress([book]), []);
  });

  test("are not replayed over a progress record that was cleared", () => {
    legacy(POS_200);
    assert.deepEqual(pendingLocalProgress([{ id: "b1" }]), []);
  });
});

describe("progress cleared on the server", () => {
  // Clearing a progress record server-side has to stick. `server || local` made
  // "the server deliberately has none" indistinguishable from "we have no
  // server data", so a cleared record was resurrected from the mirror on the
  // next library load - and the item reappeared on the Continue shelf.
  test("is not resurrected from a synced mirror entry", () => {
    saveLocalProgress("b1", POS_200);
    markLocalProgressSynced("b1", POS_200);

    // The record has since been cleared: no progress, no timestamp.
    assert.equal(effectiveProgress({ id: "b1" }), "");
  });

  test("is not resurrected from an older build's mirror entry", () => {
    store.set(
      "quiret:progress:b1",
      JSON.stringify({ progress: POS_200, at: Date.now() }),
    );
    assert.equal(effectiveProgress({ id: "b1" }), "");
  });

  test("still yields to this device's unsent progress", () => {
    saveLocalProgress("b1", POS_900);
    assert.equal(effectiveProgress({ id: "b1" }), POS_900);
  });
});
