// The rule that turns the whole sync status into one of four words.
//
// Tested directly rather than through a rendered component, because the question "should this
// say Needs Attention?" is a judgement about business state, not about markup.

import { describe, expect, it } from "vitest";
import { deriveSyncHealth, describeAge } from "./syncHealth";
import type { CloudSyncStatus, SyncRunSummary } from "../../types/desktopApi";

const QUEUE = (over: Partial<CloudSyncStatus["queue"]> = {}): CloudSyncStatus["queue"] => ({
  counts: { PENDING: 0, IN_FLIGHT: 0, FAILED: 0, DEAD_LETTER: 0, SYNCED: 0 },
  pushableNow: 0,
  pushableWaiting: 0,
  notPushable: 0,
  lastSyncedAt: null,
  lastFailureAt: null,
  ...over,
});

const RUN = (over: Partial<SyncRunSummary> = {}): SyncRunSummary => ({
  id: "run-1",
  startedAt: "2026-10-22T09:00:00.000Z",
  finishedAt: "2026-10-22T09:00:02.000Z",
  trigger: "TIMER",
  outcome: "OK",
  pushed: 0,
  fetched: 0,
  applied: 0,
  duplicates: 0,
  refused: 0,
  reason: null,
  ...over,
});

const STATUS = (over: Partial<CloudSyncStatus> = {}): CloudSyncStatus => ({
  configured: true,
  running: false,
  queue: QUEUE(),
  pullCursor: 0,
  lastAttempt: RUN(),
  lastSuccess: RUN(),
  ...over,
});

describe("nothing known yet", () => {
  it("reads as OFF before the first poll, not as a warning", () => {
    // A rail that flashes amber while it is still loading teaches people to ignore it.
    expect(deriveSyncHealth(null).level).toBe("OFF");
    expect(deriveSyncHealth(undefined).level).toBe("OFF");
  });

  it("reads as OFF on a computer that is not set up, which is not a fault", () => {
    expect(deriveSyncHealth(STATUS({ configured: false })).level).toBe("OFF");
  });
});

describe("working", () => {
  it("is WORKING when a pass has succeeded and nothing is queued", () => {
    const health = deriveSyncHealth(STATUS());
    expect(health.level).toBe("WORKING");
    expect(health.waiting).toBe(0);
    expect(health.lastSuccessAt).toBe("2026-10-22T09:00:00.000Z");
  });

  it("is WORKING while a pass is in flight, whatever is queued behind it", () => {
    const health = deriveSyncHealth(STATUS({ running: true, queue: QUEUE({ pushableNow: 40 }) }));
    // Sending is good news. Showing "waiting" while it is actively sending would be wrong.
    expect(health.level).toBe("WORKING");
    expect(health.busy).toBe(true);
  });

  it("ignores events no transport can carry yet — they are not late", () => {
    // notPushable is work whose domain has no cloud contract. Nothing is wrong and nobody can
    // do anything about it, so counting it as "waiting" would be a permanent false alarm.
    const health = deriveSyncHealth(STATUS({ queue: QUEUE({ notPushable: 500 }) }));
    expect(health.level).toBe("WORKING");
    expect(health.waiting).toBe(0);
  });
});

describe("waiting", () => {
  it("is WAITING when work is queued", () => {
    const health = deriveSyncHealth(STATUS({ queue: QUEUE({ pushableNow: 3, pushableWaiting: 2 }) }));
    expect(health.level).toBe("WAITING");
    expect(health.waiting).toBe(5);
  });

  it("is WAITING when the last attempt could not reach anybody", () => {
    expect(deriveSyncHealth(STATUS({ lastAttempt: RUN({ outcome: "TRANSPORT_ERROR" }) })).level).toBe("WAITING");
    expect(deriveSyncHealth(STATUS({ lastAttempt: RUN({ outcome: "FAILED" }) })).level).toBe("WAITING");
  });

  it("is WAITING on a computer set up but never yet successful", () => {
    // A machine provisioned ten minutes ago. Not an error, but not "up to date" either —
    // nothing has been shared yet, and saying otherwise would be a lie on a fresh install.
    const health = deriveSyncHealth(STATUS({ lastSuccess: null, lastAttempt: null }));
    expect(health.level).toBe("WAITING");
    expect(health.lastSuccessAt).toBeNull();
  });
});

describe("needs attention — the states that do not fix themselves", () => {
  it("is ATTENTION when events have stopped being retried", () => {
    const health = deriveSyncHealth(STATUS({ queue: QUEUE({ counts: { ...QUEUE().counts, DEAD_LETTER: 2 } }) }));
    expect(health.level).toBe("ATTENTION");
    expect(health.stuck).toBe(2);
  });

  it("is ATTENTION when the cloud refused this computer", () => {
    const health = deriveSyncHealth(STATUS({ lastAttempt: RUN({ outcome: "REFUSED", reason: "NOT_ENROLLED" }) }));
    expect(health.level).toBe("ATTENTION");
    expect(health.refused).toBe(true);
  });

  it("outranks WAITING — worst news wins, because they need different people", () => {
    const health = deriveSyncHealth(
      STATUS({
        queue: QUEUE({ pushableNow: 10, counts: { ...QUEUE().counts, DEAD_LETTER: 1 } }),
        lastAttempt: RUN({ outcome: "TRANSPORT_ERROR" }),
      })
    );
    expect(health.level).toBe("ATTENTION");
    // The queue figure is still reported, so the panel can show both facts.
    expect(health.waiting).toBe(10);
  });

  it("outranks a pass in flight — being stuck is not cured by sending something else", () => {
    const health = deriveSyncHealth(
      STATUS({ running: true, queue: QUEUE({ counts: { ...QUEUE().counts, DEAD_LETTER: 1 } }) })
    );
    expect(health.level).toBe("ATTENTION");
    expect(health.busy).toBe(true);
  });
});

describe("a malformed status never produces a wrong answer", () => {
  it("survives a missing queue", () => {
    const health = deriveSyncHealth({ configured: true, running: false } as unknown as CloudSyncStatus);
    expect(health.waiting).toBe(0);
    expect(health.stuck).toBe(0);
  });

  it("never reports a negative count", () => {
    const health = deriveSyncHealth(STATUS({ queue: QUEUE({ pushableNow: -5 }) }));
    expect(health.waiting).toBe(0);
  });
});

describe("how long ago, in words", () => {
  const NOW = Date.parse("2026-10-22T12:00:00.000Z");

  it.each([
    ["2026-10-22T11:59:30.000Z", "just now"],
    ["2026-10-22T11:58:00.000Z", "2 minutes ago"],
    ["2026-10-22T11:00:00.000Z", "1 hour ago"],
    ["2026-10-22T09:00:00.000Z", "3 hours ago"],
    ["2026-10-20T12:00:00.000Z", "2 days ago"],
  ])("%s -> %s", (iso, expected) => {
    expect(describeAge(iso, NOW)).toBe(expected);
  });

  it("says nothing rather than something wrong", () => {
    expect(describeAge(null, NOW)).toBeNull();
    expect(describeAge("", NOW)).toBeNull();
    expect(describeAge("not a date", NOW)).toBeNull();
  });

  it("does not report a negative age when a clock is ahead", () => {
    expect(describeAge("2026-10-22T12:05:00.000Z", NOW)).toBe("just now");
  });
});
