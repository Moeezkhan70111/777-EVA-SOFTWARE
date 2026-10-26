// THE THING THAT MAKES SYNC HAPPEN WITHOUT ANYONE ASKING.
//
// Until now a pass ran only when an administrator pressed Sync Now. That was right for a first
// slice — nobody should write to a shared project on a timer before watching it work twice — and
// it is wrong for a factory. Three computers only converge if they exchange events while people
// are working, and nobody on the floor is going to press a button for that.
//
// WHAT THIS MODULE IS NOT. It does not know what a pass does, what Supabase is, what a carton
// is, or that Electron exists. It is given a function that runs one pass and tells it what
// happened. Everything specific to this application — the device credential, the claim, the
// drain, the pull — stays in the caller (apps/desktop/src/main/cloudSyncPass.ts), which is also
// what the manual button calls. ONE pass implementation, two ways of starting it.
//
// WHEN IT RUNS A PASS
//
//   startup     once, after a delay, so a sync never competes with the first scan of the day
//   timer       on an interval while things are working
//   reconnect   as soon as the machine looks online again after looking offline
//   save        shortly after something is queued (nudge), so new work reaches the cloud in
//               seconds, not at the next timer pass -- the save itself never waits for it
//
// WHEN IT DOES NOT
//
//   while a pass is already running          — single flight, shared with the manual button
//   while the computer is not configured     — nothing to sync to
//   immediately after a transport failure    — it backs off, up to a cap
//
// THE RULE THAT OUTRANKS ALL OF IT: a pass that cannot run is not an error. The ERP is local
// first, the scan path never waits on this, and a week offline is a week of ordinary work.

/**
 * What started a pass. Recorded so "the timer worked" is distinguishable from "somebody retried".
 * SAVE: something was just queued and is being sent without waiting for the timer (push on save).
 */
export type SyncTrigger = "STARTUP" | "TIMER" | "RECONNECT" | "MANUAL" | "SAVE" | "REALTIME";

/** How a pass ended, in the only four shapes the caller has to tell apart. */
export type SyncOutcome =
  /** The pass completed. It may have carried nothing, which is the common case. */
  | "OK"
  /** The cloud would not accept this computer. An enrolment problem; the queue was not touched. */
  | "REFUSED"
  /** It could not be reached. Ordinary, and the only outcome that earns a backoff. */
  | "TRANSPORT_ERROR"
  /** Anything else, with the service's own words in `reason`. */
  | "FAILED";

export interface SyncPassResult {
  readonly outcome: SyncOutcome;
  readonly reason?: string;
}

export interface SyncSchedulerOptions {
  /**
   * Runs exactly one pass. Must never throw — a scheduler that has to catch is a scheduler that
   * stops. The caller turns every failure into an outcome.
   */
  readonly runPass: (trigger: SyncTrigger) => Promise<SyncPassResult>;
  /** False when this computer has no cloud credential. Checked before every pass, not cached. */
  readonly isConfigured: () => boolean;
  /**
   * Whether the machine currently believes it has a network. Advisory only: a true here is not
   * trusted, it just decides whether to bother, and the pass itself is the real test.
   */
  readonly isOnline: () => boolean;
  /** Milliseconds before the first pass after start(). */
  readonly startupDelayMs: number;
  /** Milliseconds between passes while things are working. */
  readonly intervalMs: number;
  /** First backoff after a transport failure. Doubles, capped at maxBackoffMs. */
  readonly minBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly setTimer: (handler: () => void, ms: number) => NodeJS.Timeout;
  readonly clearTimer: (timer: NodeJS.Timeout) => void;
  /** Called on every state change, for logging. Never throws back into the scheduler. */
  readonly onStateChange?: (state: SyncSchedulerState) => void;
  /**
   * How long a nudge waits before its pass, so a burst of saves -- a run of scans -- shares one
   * pass instead of starting one each. Measured from the FIRST nudge of a burst, so a steady stream
   * of saves cannot postpone the pass for ever. Default 1500.
   */
  readonly saveNudgeDelayMs?: number;
  /**
   * How long a doorbell ring waits before its pass (wake), so a burst of rings shares one pass.
   * Short: a ring means another computer's work is already in the cloud. Default 250.
   */
  readonly wakeDelayMs?: number;
}

const DEFAULT_SAVE_NUDGE_DELAY_MS = 1_500;
const DEFAULT_WAKE_DELAY_MS = 250;

export interface SyncSchedulerState {
  readonly running: boolean;
  /** Milliseconds until the next scheduled pass, or null when none is scheduled. */
  readonly nextPassInMs: number | null;
  /** Consecutive transport failures. Drives the backoff; reset by any completed pass. */
  readonly consecutiveFailures: number;
  readonly lastOutcome?: SyncOutcome;
  readonly lastReason?: string;
}

/**
 * Runs cloud sync passes on its own.
 *
 * One instance per process. `start()` schedules the first pass; `stop()` cancels whatever is
 * pending. `runNow()` is what the manual button calls, so the two share the single-flight guard
 * and can never overlap.
 */
export class SyncScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private consecutiveFailures = 0;
  private lastOutcome?: SyncOutcome;
  private lastReason?: string;
  private wasOnline = true;
  private stopped = true;
  /** When the pending timer was set and for how long, so nextPassInMs can be reported. */
  private scheduledAt = 0;
  private scheduledDelay: number | null = null;
  /** A nudge's pending pass. Separate from `timer`, which keeps the ordinary rhythm. */
  private nudgeTimer: NodeJS.Timeout | null = null;
  /** A nudge or wake arrived while a pass was running: run once more when it finishes, for that reason. */
  private afterPass: SyncTrigger | null = null;

  constructor(private readonly options: SyncSchedulerOptions) {}

  state(): SyncSchedulerState {
    return {
      running: this.running,
      nextPassInMs:
        this.scheduledDelay === null ? null : Math.max(0, this.scheduledAt + this.scheduledDelay - Date.now()),
      consecutiveFailures: this.consecutiveFailures,
      lastOutcome: this.lastOutcome,
      lastReason: this.lastReason,
    };
  }

  /** Schedules the first pass. Idempotent: calling it twice does not double the schedule. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.wasOnline = this.options.isOnline();
    // STARTUP, not TIMER: "the first pass after launch worked" and "the rhythm is working" are
    // different facts, and sync_runs records which one each row was.
    this.schedule(this.options.startupDelayMs, "STARTUP");
  }

  /** Cancels anything pending. A pass already in flight is left to finish on its own. */
  stop(): void {
    this.stopped = true;
    this.cancelTimer();
    this.cancelNudge();
    this.announce();
  }

  /**
   * Something was just queued: send it soon, without waiting for the timer (push on save).
   *
   * THE SAVE NEVER WAITS FOR THIS. The queue row was written in the save's own transaction; this
   * only starts a background pass a moment later, and nothing calls it before that save commits.
   *
   * Ignored while there is nothing it could do: stopped, not configured, looking offline, or backing
   * off after a transport failure -- the backoff's own pass, or the reconnect, carries the row then,
   * and nudging would only hammer a network that just failed. During a pass it is remembered, and
   * exactly one more pass follows, because the running one may have leased before the row existed.
   */
  nudge(): void {
    this.soon("SAVE", this.options.saveNudgeDelayMs ?? DEFAULT_SAVE_NUDGE_DELAY_MS);
  }

  /**
   * The cloud's doorbell rang: another computer's work has reached the log (cloud migration 016).
   * Starts a pass a moment later, sharing a pass with any nudge or ring already coming, and under the
   * same guards -- a ring never forces a pass while the scheduler is backing off a failed network.
   */
  wake(): void {
    this.soon("REALTIME", this.options.wakeDelayMs ?? DEFAULT_WAKE_DELAY_MS);
  }

  /** A pass shortly, for `trigger`: shared with one already coming, or remembered during a pass. */
  private soon(trigger: SyncTrigger, delayMs: number): void {
    if (this.stopped || !this.options.isConfigured()) return;
    if (this.consecutiveFailures > 0 || !this.options.isOnline()) return;
    if (this.running) {
      this.afterPass ??= trigger;
      return;
    }
    // Already coming: this one rides on it.
    if (this.nudgeTimer !== null) return;
    this.nudgeTimer = this.options.setTimer(() => {
      this.nudgeTimer = null;
      if (this.running) {
        this.afterPass ??= trigger;
        return;
      }
      void this.runNow(trigger);
    }, delayMs);
  }

  /**
   * Tells the scheduler the machine may have come back online.
   *
   * Called from whatever the host watches — Electron's net events, a health probe, anything. It
   * only matters on the transition from offline to online: that is the moment a queue that has
   * been waiting can drain, and waiting out the remaining interval would be pointless.
   *
   * Nothing here trusts the signal. It brings the next pass forward; the pass decides the truth.
   */
  connectivityChanged(): void {
    if (this.stopped) return;
    const online = this.options.isOnline();
    const cameBack = online && !this.wasOnline;
    this.wasOnline = online;
    if (!cameBack) return;
    // Straight back to the floor: a reconnection cancels an accumulated backoff, because the
    // thing the backoff was waiting for has just happened.
    this.consecutiveFailures = 0;
    this.schedule(0, "RECONNECT");
  }

  /**
   * Runs one pass now, if one is not already running.
   *
   * Returns null when it was declined, so a manual press can say "a sync is already running"
   * rather than appearing to do nothing.
   */
  async runNow(trigger: SyncTrigger = "MANUAL"): Promise<SyncPassResult | null> {
    if (this.running) return null;
    if (!this.options.isConfigured()) return null;

    this.running = true;
    this.announce();
    let result: SyncPassResult;
    try {
      result = await this.options.runPass(trigger);
    } catch (error) {
      // runPass is documented never to throw. If it does anyway, the scheduler must not die
      // with it — that would silently end all syncing for the life of the process.
      result = { outcome: "FAILED", reason: error instanceof Error ? error.message : String(error) };
    } finally {
      this.running = false;
    }

    this.lastOutcome = result.outcome;
    this.lastReason = result.reason;
    // ONLY a transport failure backs off. A REFUSED claim is an enrolment problem that retrying
    // sooner or later will not change, and a completed pass means things work.
    this.consecutiveFailures = result.outcome === "TRANSPORT_ERROR" ? this.consecutiveFailures + 1 : 0;
    this.announce();
    // A save or ring that came in while this pass ran gets its own pass now -- unless this one just
    // failed to reach the cloud, in which case soon() declines and the backoff carries it.
    const again = this.afterPass;
    this.afterPass = null;
    if (again === "REALTIME") this.wake();
    else if (again !== null) this.nudge();
    return result;
  }

  /** Schedules the next pass at the ordinary interval, or the current backoff after a failure. */
  private scheduleNext(): void {
    if (this.stopped) return;
    this.schedule(this.consecutiveFailures === 0 ? this.options.intervalMs : this.backoffMs());
  }

  /** Exponential, doubling per consecutive failure, capped. No jitter: one computer, one timer. */
  private backoffMs(): number {
    const { minBackoffMs, maxBackoffMs } = this.options;
    const doubled = minBackoffMs * 2 ** (this.consecutiveFailures - 1);
    return Math.min(maxBackoffMs, doubled);
  }

  private schedule(delayMs: number, trigger: SyncTrigger = "TIMER"): void {
    if (this.stopped) return;
    this.cancelTimer();
    this.scheduledAt = Date.now();
    this.scheduledDelay = delayMs;
    this.timer = this.options.setTimer(() => {
      this.scheduledDelay = null;
      void this.tick(trigger);
    }, delayMs);
    this.announce();
  }

  /** One scheduled firing: run if it is worth running, then schedule the next either way. */
  private async tick(trigger: SyncTrigger): Promise<void> {
    if (this.stopped) return;
    // Not configured, or no network: skip the pass but KEEP THE SCHEDULE. A computer that is
    // provisioned at lunchtime, or plugged in at four, must start syncing without a restart.
    if (this.options.isConfigured() && this.options.isOnline()) {
      await this.runNow(trigger);
    }
    this.scheduleNext();
  }

  private cancelTimer(): void {
    if (this.timer !== null) this.options.clearTimer(this.timer);
    this.timer = null;
    this.scheduledDelay = null;
  }

  private cancelNudge(): void {
    if (this.nudgeTimer !== null) this.options.clearTimer(this.nudgeTimer);
    this.nudgeTimer = null;
    this.afterPass = null;
  }

  private announce(): void {
    try {
      this.options.onStateChange?.(this.state());
    } catch {
      // A logger that throws must not stop the scheduler.
    }
  }
}
