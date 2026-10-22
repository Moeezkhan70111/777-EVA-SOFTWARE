import type { CloudSyncStatus } from "../../types/desktopApi";

// TURNING EIGHT NUMBERS INTO ONE ANSWER.
//
// The Cloud Sync panel shows a queue partitioned two ways, a pull cursor, a deferral, a
// scheduler state and two run records. That is the right amount of detail for somebody
// diagnosing a problem and far too much for somebody walking past a screen.
//
// This reduces all of it to one of four states and the two or three numbers that matter for
// that state. It is a pure function with no React in it, so the rule it encodes can be tested
// directly rather than inferred from a rendered component (CLAUDE.md R13).
//
// THE ORDER OF THE CHECKS IS THE DESIGN. Worst news first: something stuck outranks something
// waiting, and being refused outranks both, because they need different people to do different
// things. A computer that is merely behind is not "attention" — it is working.

export type SyncHealthLevel =
  /** Not set up to sync. Not a fault: this is every computer until it is provisioned. */
  | "OFF"
  /** Reaching the others and current, or sending right now. */
  | "WORKING"
  /** Cannot reach the others, or has work queued. It will sort itself out. */
  | "WAITING"
  /** Somebody has to do something: events parked, or this computer refused. */
  | "ATTENTION";

export interface SyncHealth {
  readonly level: SyncHealthLevel;
  /** True while a pass is actually in flight. */
  readonly busy: boolean;
  /** Items this computer still has to send. Excludes those no transport can carry yet. */
  readonly waiting: number;
  /** Items that failed their attempts and stopped being retried. Needs a person. */
  readonly stuck: number;
  /** When a pass last completed, or null. */
  readonly lastSuccessAt: string | null;
  /** Set when the level is ATTENTION because the cloud refused this computer. */
  readonly refused: boolean;
}

/**
 * The one answer, from the whole status.
 *
 * `waiting` deliberately counts only what a pass would actually try to carry — `pushableNow`
 * plus `pushableWaiting`. The third bucket, `notPushable`, is events whose domain has no cloud
 * contract yet: they are not late, nothing is wrong, and nobody can do anything about them. The
 * old panel showed them under "not sendable yet", which is honest for an administrator reading
 * a diagnostic page and alarming on a rail that is supposed to say whether things are fine.
 */
export const deriveSyncHealth = (status: CloudSyncStatus | null | undefined): SyncHealth => {
  const empty: SyncHealth = {
    level: "OFF",
    busy: false,
    waiting: 0,
    stuck: 0,
    lastSuccessAt: null,
    refused: false,
  };
  // Null before the first poll lands, undefined if a caller has not read one at all. Both mean
  // "nothing known yet", which reads as OFF — the quietest of the four, and the right default
  // for a rail that must not flash a warning while it is still loading.
  if (status === null || status === undefined || !status.configured) return empty;

  const queue = status.queue;
  const waiting = Math.max(0, (queue?.pushableNow ?? 0) + (queue?.pushableWaiting ?? 0));
  const stuck = Math.max(0, queue?.counts?.DEAD_LETTER ?? 0);
  const lastSuccessAt = status.lastSuccess?.startedAt ?? null;
  const refused = status.lastAttempt?.outcome === "REFUSED";
  const busy = status.running === true;

  // Parked events, or a computer the cloud will not accept. Both need a person, and neither
  // gets better by waiting, so they outrank everything below.
  if (stuck > 0 || refused) {
    return { level: "ATTENTION", busy, waiting, stuck, lastSuccessAt, refused };
  }

  // Sending right now is good news, whatever is queued behind it.
  if (busy) return { level: "WORKING", busy, waiting, stuck, lastSuccessAt, refused };

  // Set up but never once succeeded: not an error — a computer provisioned ten minutes ago is
  // in exactly this state — but not "up to date" either, because nothing has been shared yet.
  if (lastSuccessAt === null) {
    return { level: "WAITING", busy, waiting, stuck, lastSuccessAt, refused };
  }

  // Work queued, or the last attempt could not reach anybody.
  const lastFailed =
    status.lastAttempt?.outcome === "TRANSPORT_ERROR" || status.lastAttempt?.outcome === "FAILED";
  if (waiting > 0 || lastFailed) {
    return { level: "WAITING", busy, waiting, stuck, lastSuccessAt, refused };
  }

  return { level: "WORKING", busy, waiting, stuck, lastSuccessAt, refused };
};

/**
 * "2 minutes ago", for somebody glancing at a rail.
 *
 * Deliberately coarse and deliberately not a clock time: the question is "is this current?",
 * and an exact timestamp makes a reader do the arithmetic themselves. The detail panel shows
 * the real time underneath.
 */
export const describeAge = (iso: string | null, now: number = Date.now()): string | null => {
  if (iso === null || iso === "") return null;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return null;

  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)} ${minutes === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${String(hours)} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.round(hours / 24);
  return `${String(days)} ${days === 1 ? "day" : "days"} ago`;
};
