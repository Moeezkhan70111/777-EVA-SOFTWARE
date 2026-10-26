// The scheduler's promises, driven by a fake clock.
//
// Nothing here waits. Timers are captured and fired by hand, so a four-hour interval and a
// twenty-minute backoff are both tested in microseconds, and the assertions are about WHICH
// delay was chosen rather than about elapsed time.

import test from "node:test";
import assert from "node:assert/strict";
import { SyncScheduler, type SyncPassResult, type SyncSchedulerOptions, type SyncTrigger } from "./scheduler.js";

/** A clock whose timers only fire when a test says so. */
class FakeTimers {
  private next = 1;
  private pending = new Map<number, { handler: () => void; delay: number }>();

  readonly set = (handler: () => void, delay: number): NodeJS.Timeout => {
    const id = this.next++;
    this.pending.set(id, { handler, delay });
    return id as unknown as NodeJS.Timeout;
  };

  readonly clear = (timer: NodeJS.Timeout): void => {
    this.pending.delete(timer as unknown as number);
  };

  /** The delay of the one pending timer, or null. */
  delay(): number | null {
    const entries = [...this.pending.values()];
    assert.ok(entries.length <= 1, `expected at most one pending timer, found ${String(entries.length)}`);
    return entries[0]?.delay ?? null;
  }

  /** Every pending delay, smallest first -- for a nudge pending beside the ordinary timer. */
  delays(): number[] {
    return [...this.pending.values()].map((entry) => entry.delay).sort((a, b) => a - b);
  }

  /** Fires the one pending timer with exactly this delay, and waits for whatever it started. */
  async fireDelay(delay: number): Promise<void> {
    const found = [...this.pending.entries()].filter(([, entry]) => entry.delay === delay);
    assert.equal(found.length, 1, `expected one pending timer of ${String(delay)} ms`);
    const [id, entry] = found[0];
    this.pending.delete(id);
    entry.handler();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  }

  /** Fires the pending timer and waits for whatever it started. */
  async fire(): Promise<void> {
    const entries = [...this.pending.entries()];
    assert.equal(entries.length, 1, "no timer is pending");
    const [id, entry] = entries[0];
    this.pending.delete(id);
    entry.handler();
    // The handler kicks off an async tick; let the microtask queue drain.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  }
}

interface Harness {
  readonly scheduler: SyncScheduler;
  readonly timers: FakeTimers;
  readonly passes: SyncTrigger[];
  setResult(result: SyncPassResult): void;
  setOnline(online: boolean): void;
  setConfigured(configured: boolean): void;
}

function harness(overrides: Partial<SyncSchedulerOptions> = {}): Harness {
  const timers = new FakeTimers();
  const passes: SyncTrigger[] = [];
  let result: SyncPassResult = { outcome: "OK" };
  let online = true;
  let configured = true;

  const scheduler = new SyncScheduler({
    runPass: async (trigger) => {
      passes.push(trigger);
      return result;
    },
    isConfigured: () => configured,
    isOnline: () => online,
    startupDelayMs: 90_000,
    intervalMs: 300_000,
    minBackoffMs: 30_000,
    maxBackoffMs: 600_000,
    setTimer: timers.set,
    clearTimer: timers.clear,
    ...overrides,
  });

  return {
    scheduler,
    timers,
    passes,
    setResult: (next) => {
      result = next;
    },
    setOnline: (next) => {
      online = next;
    },
    setConfigured: (next) => {
      configured = next;
    },
  };
}

// ─── Starting up ─────────────────────────────────────────────────────────────

test("the first pass waits, so a sync never competes with the first scan of the day", () => {
  const h = harness();
  h.scheduler.start();
  assert.equal(h.timers.delay(), 90_000);
  assert.deepEqual(h.passes, [], "nothing runs during startup itself");
});

test("start is idempotent — twice does not double the schedule", () => {
  const h = harness();
  h.scheduler.start();
  h.scheduler.start();
  assert.equal(h.timers.delay(), 90_000);
});

test("the startup pass runs, then the ordinary interval takes over", async () => {
  const h = harness();
  h.scheduler.start();
  await h.timers.fire();
  assert.deepEqual(h.passes, ["STARTUP"]);
  assert.equal(h.timers.delay(), 300_000);

  await h.timers.fire();
  assert.deepEqual(h.passes, ["STARTUP", "TIMER"]);
});

test("stop cancels what is pending and schedules nothing more", () => {
  const h = harness();
  h.scheduler.start();
  h.scheduler.stop();
  assert.equal(h.timers.delay(), null);
  assert.equal(h.scheduler.state().nextPassInMs, null);
});

// ─── Not running a pass is not an error ──────────────────────────────────────

test("an unconfigured computer skips the pass but KEEPS the schedule", async () => {
  const h = harness();
  h.setConfigured(false);
  h.scheduler.start();
  await h.timers.fire();
  assert.deepEqual(h.passes, [], "there is nothing to sync to");
  // The point: provisioning at lunchtime must start syncing without a restart.
  assert.equal(h.timers.delay(), 300_000);

  h.setConfigured(true);
  await h.timers.fire();
  assert.deepEqual(h.passes, ["TIMER"]);
});

test("an offline computer skips the pass and keeps the schedule", async () => {
  const h = harness();
  h.setOnline(false);
  h.scheduler.start();
  await h.timers.fire();
  assert.deepEqual(h.passes, []);
  assert.equal(h.timers.delay(), 300_000);
});

test("runNow declines rather than queueing while a pass is in flight", async () => {
  const gate: { release?: () => void } = {};
  const h = harness({
    runPass: async () => {
      await new Promise<void>((resolve) => {
        gate.release = resolve;
      });
      return { outcome: "OK" };
    },
  });

  const first = h.scheduler.runNow("MANUAL");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.scheduler.state().running, true);

  // The manual button must be able to say "already running" rather than appear to do nothing.
  assert.equal(await h.scheduler.runNow("MANUAL"), null);

  gate.release?.();
  await first;
  assert.equal(h.scheduler.state().running, false);
});

test("runNow declines on an unconfigured computer", async () => {
  const h = harness();
  h.setConfigured(false);
  assert.equal(await h.scheduler.runNow("MANUAL"), null);
  assert.deepEqual(h.passes, []);
});

// ─── Backoff ─────────────────────────────────────────────────────────────────

test("only a transport failure backs off, and it doubles up to the cap", async () => {
  const h = harness();
  h.setResult({ outcome: "TRANSPORT_ERROR", reason: "offline" });
  h.scheduler.start();

  await h.timers.fire();
  assert.equal(h.timers.delay(), 30_000, "first backoff");
  await h.timers.fire();
  assert.equal(h.timers.delay(), 60_000);
  await h.timers.fire();
  assert.equal(h.timers.delay(), 120_000);
  await h.timers.fire();
  assert.equal(h.timers.delay(), 240_000);
  await h.timers.fire();
  assert.equal(h.timers.delay(), 480_000);
  await h.timers.fire();
  assert.equal(h.timers.delay(), 600_000, "capped");
  await h.timers.fire();
  assert.equal(h.timers.delay(), 600_000, "stays capped");
  assert.equal(h.scheduler.state().consecutiveFailures, 7);
});

test("a completed pass clears the backoff", async () => {
  const h = harness();
  h.setResult({ outcome: "TRANSPORT_ERROR" });
  h.scheduler.start();
  await h.timers.fire();
  assert.equal(h.timers.delay(), 30_000);

  h.setResult({ outcome: "OK" });
  await h.timers.fire();
  assert.equal(h.timers.delay(), 300_000, "back to the ordinary interval");
  assert.equal(h.scheduler.state().consecutiveFailures, 0);
});

test("a REFUSED claim does NOT back off — retrying sooner will not fix an enrolment", async () => {
  const h = harness();
  h.setResult({ outcome: "REFUSED", reason: "NOT_ENROLLED" });
  h.scheduler.start();
  await h.timers.fire();
  // It is not a network problem, so the ordinary rhythm continues and somebody fixes the
  // enrolment. Backing off would only make the eventual fix slower to take effect.
  assert.equal(h.timers.delay(), 300_000);
  assert.equal(h.scheduler.state().consecutiveFailures, 0);
  assert.equal(h.scheduler.state().lastOutcome, "REFUSED");
  assert.equal(h.scheduler.state().lastReason, "NOT_ENROLLED");
});

// ─── Reconnection ────────────────────────────────────────────────────────────

test("coming back online drains at once instead of waiting out the backoff", async () => {
  const h = harness();
  h.setResult({ outcome: "TRANSPORT_ERROR" });
  h.scheduler.start();
  await h.timers.fire();
  await h.timers.fire();
  assert.equal(h.timers.delay(), 60_000, "backed off twice");

  h.setOnline(false);
  h.scheduler.connectivityChanged();
  h.setOnline(true);
  h.setResult({ outcome: "OK" });
  h.scheduler.connectivityChanged();

  // The thing the backoff was waiting for has happened, so it is abandoned.
  assert.equal(h.timers.delay(), 0);
  await h.timers.fire();
  assert.deepEqual(h.passes, ["STARTUP", "TIMER", "RECONNECT"]);
});

// THE OUTAGE THE RECONNECT TRIGGER DOES NOT CATCH.
//
// `net.isOnline()` reports whether a network route exists, not whether the internet works —
// Electron's own docs call a `true` inconclusive. In the factory's likeliest outage the LAN is
// fine and the WAN is down, so the machine never looks offline, there is no transition, and
// this trigger never fires.
//
// That is not a bug to hide. It is pinned here so the behaviour is visible in the test suite
// rather than discovered on the floor, and it is why the backoff cap in main.ts is sixty
// seconds: the cap, not the trigger, is what bounds recovery for this case.
test("LAN up / WAN down: no reconnect fires, and recovery rides the backoff instead", async () => {
  const h = harness();
  h.setResult({ outcome: "TRANSPORT_ERROR" });
  h.scheduler.start();

  // The interface never goes down, so isOnline() never changes.
  await h.timers.fire();
  assert.equal(h.timers.delay(), 30_000);
  h.scheduler.connectivityChanged();
  assert.equal(h.timers.delay(), 30_000, "no reconnect: there was no transition to detect");

  await h.timers.fire();
  assert.equal(h.timers.delay(), 60_000);

  // The internet comes back. Still no transition — the next backoff slot is what notices.
  h.setResult({ outcome: "OK" });
  h.scheduler.connectivityChanged();
  assert.equal(h.timers.delay(), 60_000, "recovery waits out the pending backoff");

  await h.timers.fire();
  assert.deepEqual(h.passes, ["STARTUP", "TIMER", "TIMER"]);
  assert.equal(h.scheduler.state().consecutiveFailures, 0, "and then it is working again");
});

test("a connectivity event that is not a reconnection changes nothing", () => {
  const h = harness();
  h.scheduler.start();
  assert.equal(h.timers.delay(), 90_000);
  // Still online: this is noise, not a transition, and must not reset the startup delay.
  h.scheduler.connectivityChanged();
  assert.equal(h.timers.delay(), 90_000);
});

test("connectivity events are ignored once stopped", () => {
  const h = harness();
  h.scheduler.start();
  h.scheduler.stop();
  h.setOnline(false);
  h.scheduler.connectivityChanged();
  h.setOnline(true);
  h.scheduler.connectivityChanged();
  assert.equal(h.timers.delay(), null, "a stopped scheduler must stay stopped");
});

// ─── It must not be killable ─────────────────────────────────────────────────

test("a pass that throws does not kill the scheduler", async () => {
  const h = harness({
    runPass: () => Promise.reject(new Error("something unexpected")),
  });
  h.scheduler.start();
  await h.timers.fire();

  // runPass is documented never to throw. If it does anyway, syncing must not silently end for
  // the life of the process.
  assert.equal(h.scheduler.state().lastOutcome, "FAILED");
  assert.equal(h.scheduler.state().lastReason, "something unexpected");
  assert.equal(h.timers.delay(), 300_000, "still scheduled");
  assert.equal(h.scheduler.state().running, false);
});

test("a throwing state listener does not kill the scheduler", async () => {
  const h = harness({
    onStateChange: () => {
      throw new Error("the logger is broken");
    },
  });
  h.scheduler.start();
  await h.timers.fire();
  assert.deepEqual(h.passes, ["STARTUP"]);
});

test("state reports what is pending, for a panel to show", async () => {
  const h = harness();
  h.scheduler.start();
  const before = h.scheduler.state();
  assert.ok(before.nextPassInMs !== null && before.nextPassInMs <= 90_000);
  await h.timers.fire();
  assert.equal(h.scheduler.state().lastOutcome, "OK");
});

// ─── Push on save: the nudge ─────────────────────────────────────────────────

/** The default bundling delay (DEFAULT_SAVE_NUDGE_DELAY_MS): distinct from every other delay here. */
const NUDGE_MS = 1_500;

test("a save is sent within seconds, and the ordinary rhythm is left exactly as it was", async () => {
  const h = harness();
  h.scheduler.start();
  h.scheduler.nudge();
  assert.deepEqual(h.timers.delays(), [NUDGE_MS, 90_000], "the startup pass is still where it was");

  await h.timers.fireDelay(NUDGE_MS);
  assert.deepEqual(h.passes, ["SAVE"], "recorded as a save, not as the timer");
  assert.deepEqual(h.timers.delays(), [90_000]);
});

test("a burst of saves shares one pass", async () => {
  const h = harness();
  h.scheduler.start();
  for (let scan = 0; scan < 5; scan += 1) h.scheduler.nudge();
  assert.deepEqual(h.timers.delays(), [NUDGE_MS, 90_000], "one nudge pending, however many saves");

  await h.timers.fireDelay(NUDGE_MS);
  assert.deepEqual(h.passes, ["SAVE"]);
});

test("a save made while a pass runs gets exactly one more pass, after it", async () => {
  let release: () => void = () => undefined;
  const passes: SyncTrigger[] = [];
  const h = harness({
    runPass: async (trigger) => {
      passes.push(trigger);
      // The first pass is held open, as a slow network would.
      if (passes.length === 1) await new Promise<void>((resolve) => (release = resolve));
      return { outcome: "OK" };
    },
  });
  h.scheduler.start();

  const manual = h.scheduler.runNow("MANUAL");
  for (let scan = 0; scan < 3; scan += 1) h.scheduler.nudge();
  assert.deepEqual(h.timers.delays(), [90_000], "nothing is started beside a running pass");

  release();
  await manual;
  assert.deepEqual(h.timers.delays(), [NUDGE_MS, 90_000], "one pass follows, for all three saves");
  await h.timers.fireDelay(NUDGE_MS);
  assert.deepEqual(passes, ["MANUAL", "SAVE"]);
});

test("a nudge does nothing while offline, unconfigured, backing off, or stopped", async () => {
  const h = harness();
  h.scheduler.start();

  h.setOnline(false);
  h.scheduler.nudge();
  h.setOnline(true);
  h.setConfigured(false);
  h.scheduler.nudge();
  h.setConfigured(true);
  assert.deepEqual(h.timers.delays(), [90_000], "no network, or nothing to sync to: no pass");

  // A transport failure: the backoff's own pass carries the row, so a nudge must not hammer it.
  h.setResult({ outcome: "TRANSPORT_ERROR", reason: "offline" });
  await h.scheduler.runNow("MANUAL");
  h.scheduler.nudge();
  assert.deepEqual(h.timers.delays(), [90_000]);

  h.scheduler.stop();
  h.scheduler.nudge();
  assert.deepEqual(h.timers.delays(), [], "a stopped scheduler starts nothing");
});

test("stopping cancels a nudge that was about to run", () => {
  const h = harness();
  h.scheduler.start();
  h.scheduler.nudge();
  h.scheduler.stop();
  assert.deepEqual(h.timers.delays(), []);
  assert.deepEqual(h.passes, []);
});

// ─── Realtime: the doorbell's wake ───────────────────────────────────────────

/** The default doorbell delay (DEFAULT_WAKE_DELAY_MS). */
const WAKE_MS = 250;

test("a ring starts a pass within a quarter of a second, recorded as realtime, and a burst shares it", async () => {
  const h = harness();
  h.scheduler.start();
  for (let ring = 0; ring < 4; ring += 1) h.scheduler.wake();
  assert.deepEqual(h.timers.delays(), [WAKE_MS, 90_000], "one pass coming, however many rings");

  await h.timers.fireDelay(WAKE_MS);
  assert.deepEqual(h.passes, ["REALTIME"]);
  assert.deepEqual(h.timers.delays(), [90_000], "the ordinary rhythm is untouched: it is the safety net");
});

test("a ring during a pass gets exactly one more pass after it, for the ring", async () => {
  let release: () => void = () => undefined;
  const passes: SyncTrigger[] = [];
  const h = harness({
    runPass: async (trigger) => {
      passes.push(trigger);
      if (passes.length === 1) await new Promise<void>((resolve) => (release = resolve));
      return { outcome: "OK" };
    },
  });
  h.scheduler.start();
  const manual = h.scheduler.runNow("MANUAL");
  h.scheduler.wake();
  h.scheduler.wake();
  release();
  await manual;
  assert.deepEqual(h.timers.delays(), [WAKE_MS, 90_000]);
  await h.timers.fireDelay(WAKE_MS);
  assert.deepEqual(passes, ["MANUAL", "REALTIME"]);
});

test("a ring never forces a pass while the scheduler backs off a failed network", async () => {
  const h = harness({ runPass: async () => ({ outcome: "TRANSPORT_ERROR", reason: "offline" }) });
  h.scheduler.start();
  await h.scheduler.runNow("MANUAL");
  const before = h.timers.delays();
  h.scheduler.wake();
  assert.deepEqual(h.timers.delays(), before, "the backoff's own pass carries it");
});
