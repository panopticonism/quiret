import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  computeProgressPercent,
  createMediaProgressTracker,
  createDocumentProgressTracker,
  createThrottle,
} from "./progress.js";

describe("computeProgressPercent", () => {
  test("no record reads as zero", () => {
    assert.equal(computeProgressPercent(""), 0);
    assert.equal(computeProgressPercent(null), 0);
    assert.equal(computeProgressPercent("not json"), 0);
  });

  // A started item must never read as "not started": the library hides anything
  // that computes to 0, so rounding a real position down to 0 makes a book you
  // are part-way through vanish from the Continue shelf.
  test("a position under half a percent still reads as started", () => {
    // A 55-minute video six seconds in.
    assert.equal(
      computeProgressPercent('{"type":"video","position":6,"duration":3288}'),
      1,
    );
    // A 16-hour audiobook four minutes in; 1% of it is ten minutes.
    assert.equal(
      computeProgressPercent('{"type":"audio","position":240,"duration":58244}'),
      1,
    );
  });

  test("an ebook opened at the cover still reads as started", () => {
    assert.equal(
      computeProgressPercent('{"type":"epub","fraction":0.00038582402902866505}'),
      1,
    );
  });

  test("a PDF on page 1 of 535 still reads as started", () => {
    assert.equal(
      computeProgressPercent('{"type":"pdf","page":1,"totalPages":535}'),
      1,
    );
  });

  test("an untouched item reads as zero", () => {
    assert.equal(
      computeProgressPercent('{"type":"audio","position":0,"duration":58244}'),
      0,
    );
    assert.equal(computeProgressPercent('{"type":"epub","fraction":0}'), 0);
  });

  test("a finished item reads as exactly 100", () => {
    assert.equal(
      computeProgressPercent('{"type":"video","position":2466,"duration":2466}'),
      100,
    );
    assert.equal(computeProgressPercent('{"type":"epub","fraction":1}'), 100);
  });

  test("a position past the end clamps to 100", () => {
    assert.equal(
      computeProgressPercent('{"type":"audio","position":2500,"duration":2466}'),
      100,
    );
    assert.equal(computeProgressPercent('{"type":"epub","fraction":1.4}'), 100);
  });

  // Records written by an older build carry types the current format list no
  // longer names; a fraction is still a fraction and should display.
  test("an unknown text type with a fraction still reads as started", () => {
    assert.equal(
      computeProgressPercent('{"type":"mobi","fraction":0.5}'),
      50,
    );
  });

  test("a mid-way position rounds up, not down", () => {
    assert.equal(
      computeProgressPercent('{"type":"audio","position":1342,"duration":2532}'),
      54,
    );
  });
});

describe("createMediaProgressTracker", () => {
  const SIXTEEN_HOURS = 58244;

  test("resumes where the saved position left off", () => {
    const t = createMediaProgressTracker({ type: "audio", resumePosition: 12000 });
    assert.equal(t.begin(SIXTEEN_HOURS), 12000);
  });

  // The player knows the duration as soon as metadata loads, but the position
  // only arrives on the first timeupdate. A save in that window used to write
  // {position: 0, duration: <real>} over a perfectly good saved place.
  test("opening and closing before playback starts stores nothing", () => {
    const t = createMediaProgressTracker({ type: "audio", resumePosition: 12000 });
    t.begin(SIXTEEN_HOURS);
    assert.equal(t.snapshot(0), null);
  });

  test("a save before metadata loads stores nothing", () => {
    const t = createMediaProgressTracker({ type: "audio", resumePosition: 12000 });
    assert.equal(t.snapshot(0), null);
  });

  test("real playback stores the position", () => {
    const t = createMediaProgressTracker({ type: "audio", resumePosition: 12000 });
    t.begin(SIXTEEN_HOURS);
    assert.deepEqual(t.snapshot(12480.7), {
      type: "audio",
      position: 12480,
      duration: SIXTEEN_HOURS,
    });
  });

  // A finished video deliberately does not resume, so it restarts at 0. Closing
  // it a few seconds later must not overwrite the completed record with 0%.
  test("restarting a finished item does not overwrite it", () => {
    const t = createMediaProgressTracker({ type: "video", resumePosition: 2466 });
    assert.equal(t.begin(2466), null, "a finished item starts over");
    assert.equal(t.snapshot(6), null);
  });

  test("genuinely re-watching a finished item does store a new position", () => {
    const t = createMediaProgressTracker({ type: "video", resumePosition: 2466 });
    t.begin(2466);
    assert.deepEqual(t.snapshot(400), {
      type: "video",
      position: 400,
      duration: 2466,
    });
  });

  test("a deliberate seek back to the start is stored", () => {
    const t = createMediaProgressTracker({ type: "audio", resumePosition: 12000 });
    t.begin(SIXTEEN_HOURS);
    t.markUserSeek();
    assert.deepEqual(t.snapshot(0), {
      type: "audio",
      position: 0,
      duration: SIXTEEN_HOURS,
    });
  });

  test("a first-time open stores nothing until playback is under way", () => {
    const t = createMediaProgressTracker({ type: "audio", resumePosition: 0 });
    t.begin(2532);
    assert.equal(t.snapshot(0), null);
    assert.equal(t.snapshot(0.4), null);
    assert.deepEqual(t.snapshot(30), {
      type: "audio",
      position: 30,
      duration: 2532,
    });
  });

  test("reaching the end stores a finished record", () => {
    const t = createMediaProgressTracker({ type: "video", resumePosition: 0 });
    t.begin(2466);
    assert.deepEqual(t.snapshot(2466), {
      type: "video",
      position: 2466,
      duration: 2466,
    });
  });

  test("a position past the end is clamped to the duration", () => {
    const t = createMediaProgressTracker({ type: "audio", resumePosition: 0 });
    t.begin(2532);
    assert.deepEqual(t.snapshot(2600), {
      type: "audio",
      position: 2532,
      duration: 2532,
    });
  });

  test("an unknown duration stores nothing", () => {
    const t = createMediaProgressTracker({ type: "audio", resumePosition: 500 });
    assert.equal(t.begin(NaN), null);
    assert.equal(t.snapshot(600), null);
  });
});

describe("createThrottle", () => {
  const makeClock = () => {
    let t = 0;
    let nextId = 1;
    const timers = new Map();
    return {
      now: () => t,
      setTimer: (fn, ms) => {
        const id = nextId++;
        timers.set(id, { fn, at: t + ms });
        return id;
      },
      clearTimer: (id) => timers.delete(id),
      advance(ms) {
        t += ms;
        for (const [id, timer] of [...timers]) {
          if (timer.at <= t) {
            timers.delete(id);
            timer.fn();
          }
        }
      },
      pending: () => timers.size,
    };
  };

  test("the first call goes out immediately", () => {
    const clock = makeClock();
    const sent = [];
    const th = createThrottle(5000, (v) => sent.push(v), clock);
    th.call("a");
    assert.deepEqual(sent, ["a"]);
  });

  // The debounce-for-a-throttle bug: timeupdate fires about every 250ms, so a
  // debounce reset its timer faster than it could expire and nothing was ever
  // stored mid-playback.
  test("rapid calls still checkpoint once per interval", () => {
    const clock = makeClock();
    const sent = [];
    const th = createThrottle(5000, (v) => sent.push(v), clock);
    for (let i = 0; i < 80; i++) {
      th.call(i);
      clock.advance(250);
    }
    assert.equal(sent.length, 5, "20s of playback should checkpoint 4-5 times");
    assert.equal(sent[0], 0);
  });

  test("the trailing call sends the newest value, not the one that queued it", () => {
    const clock = makeClock();
    const sent = [];
    const th = createThrottle(5000, (v) => sent.push(v), clock);
    th.call("first");
    th.call("second");
    th.call("third");
    clock.advance(5000);
    assert.deepEqual(sent, ["first", "third"]);
  });

  test("flush sends at once and drops anything queued", () => {
    const clock = makeClock();
    const sent = [];
    const th = createThrottle(5000, (v) => sent.push(v), clock);
    th.call("first");
    th.call("queued");
    th.flush("final");
    assert.deepEqual(sent, ["first", "final"]);
    clock.advance(10000);
    assert.deepEqual(sent, ["first", "final"], "the queued value is gone");
  });

  test("dispose drops a queued call", () => {
    const clock = makeClock();
    const sent = [];
    const th = createThrottle(5000, (v) => sent.push(v), clock);
    th.call("first");
    th.call("queued");
    th.dispose();
    clock.advance(10000);
    assert.deepEqual(sent, ["first"]);
    assert.equal(clock.pending(), 0);
  });
});

describe("createDocumentProgressTracker", () => {
  test("opening a book at its cover is not progress", () => {
    const t = createDocumentProgressTracker();
    assert.equal(t.shouldStore("epubcfi(/6/2!/4/2[cover],,/2)"), false);
  });

  test("turning a page is progress", () => {
    const t = createDocumentProgressTracker();
    t.shouldStore("epubcfi(/6/2!/4/2[cover],,/2)");
    assert.equal(t.shouldStore("epubcfi(/6/4!/4/2,/2,/4)"), true);
  });

  // Opening a resumed book reports the restored place, which is already stored;
  // re-storing it on open is how a close-without-reading used to touch the
  // record's timestamp.
  test("opening a resumed book does not re-store its position", () => {
    const t = createDocumentProgressTracker();
    assert.equal(t.shouldStore("epubcfi(/6/134!/4,/2,/18/3:61)"), false);
  });

  // A relayout - rotation, a font-size change - re-reports the same spot. That
  // is not a page turn.
  test("re-reporting the opening position is not progress", () => {
    const t = createDocumentProgressTracker();
    t.shouldStore("page-1");
    assert.equal(t.shouldStore("page-1"), false);
    assert.equal(t.shouldStore("page-1"), false);
  });

  test("a PDF sitting on page 1 is not progress", () => {
    const t = createDocumentProgressTracker();
    assert.equal(t.shouldStore(1), false);
  });

  test("moving to another PDF page is progress", () => {
    const t = createDocumentProgressTracker();
    t.shouldStore(1);
    assert.equal(t.shouldStore(2), true);
  });

  // Once the reader has genuinely moved, coming back is a real position too -
  // otherwise paging back to the start would silently stop being recorded.
  test("returning to the opening position after moving is progress", () => {
    const t = createDocumentProgressTracker();
    t.shouldStore(1);
    assert.equal(t.shouldStore(5), true);
    assert.equal(t.shouldStore(1), true);
  });
});
