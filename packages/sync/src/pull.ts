// Receiving what the other computers sent.
//
// This is the half that makes a second PC show the same business data. Pushing alone only empties
// one computer's queue; until a computer can pull, it has nothing of anyone else's.
//
// The shape is a cursor over an ordered log:
//
//   read cursor  →  fetch what is after it  →  apply each, in order  →  advance the cursor
//
// THE CURSOR ONLY EVER MOVES OVER A SETTLED RUN OF EVENTS. Applied, already here, or permanently
// refused all count as settled; an event waiting for a prerequisite does not. The cursor
// therefore advances to the end of the settled run only, so nothing unsettled is ever claimed to
// be dealt with.
//
// WHY THE BATCH IS SWEPT MORE THAN ONCE. Stopping dead at the first waiting event would be
// correct but can deadlock: if the log ever holds a scan before the carton identity it needs —
// another computer pushed the identity later, or it was parked and re-queued — the run would stop
// on the scan for ever and never reach the identity sitting behind it. So the sweep continues,
// applies everything it can, and repeats while it is still making progress. Re-applying is free
// (every apply is idempotent) and the loop is bounded by the number of events fetched.
//
// WHAT `seq > cursor` DEPENDS ON. Reading forward from a position is only safe if a position
// that becomes visible can never be followed by an EARLIER one appearing later. A plain
// bigserial does not give that: a position is taken when a row is inserted, and the row appears
// when its transaction commits, so a slow writer holding position 5 can be overtaken by one
// holding 6, and 5 would then be read past and lost for ever.
//
// The service is what guarantees it, not this file. In Postgres, migration 003's triggers take a
// transaction-level advisory lock before inserting, so only one writer at a time sits between
// taking a position and committing — which makes position order and commit order the same. The
// test service keeps the same promise trivially, because SQLite serialises writers anyway.
//
// So a hole in the positions means a transaction rolled back after taking one, and nothing can
// ever arrive in it. Holes are skipped, not waited for. If that guarantee were removed from the
// service, this cursor would start losing events silently — see logOrdering.test.ts, which holds
// the argument and shows the loss happening when the guarantee is absent.
//
// Nothing here throws. A computer whose network is down must keep working, so a failure is
// something to report, not an exception for the application to inherit.

import { applyEnvelope, type ApplyOutcome } from "./applyEnvelope.js";
import type { SyncEnvelope } from "./contract.js";
import {
  clearPullDeferral,
  readPullCursor,
  readPullDeferral,
  writePullCursor,
  writePullDeferral,
} from "./pullCursor.js";
import type { SyncSqlHandle } from "./sqlPort.js";
import type { SyncPullTransport } from "./transport.js";

export interface PullProblem {
  readonly seq: number;
  readonly dedupeKey: string;
  readonly reason: string;
}

export interface PullResult {
  /** Where the cursor stood before the run. */
  readonly from: number;
  /** Where it stands now. Unchanged when the first event could not be settled. */
  readonly cursor: number;
  readonly fetched: number;
  readonly applied: number;
  readonly duplicates: number;
  /** Permanently refused and stepped over. Each is reported, never silently dropped. */
  readonly refused: readonly PullProblem[];
  /** Set when the run stopped on an event whose prerequisite has not arrived. */
  readonly waitingFor?: PullProblem;
  /** Set when the service could not be reached. The cursor did not move. */
  readonly transportError?: string;
  /** Set when the run did not even look, because a recorded wait has not elapsed. */
  readonly deferredUntil?: number;
}

export interface SyncPullOptions {
  readonly batchSize?: number;
  /** The first wait after a prerequisite is missing. It doubles per attempt, up to the cap. */
  readonly deferBaseMs?: number;
  readonly deferMaxMs?: number;
  /** Injected so a test can move time forward without waiting. */
  readonly now?: () => number;
}

export class SyncPull {
  private readonly batchSize: number;
  private readonly deferBaseMs: number;
  private readonly deferMaxMs: number;
  private readonly now: () => number;

  constructor(
    private readonly sql: SyncSqlHandle,
    private readonly transport: SyncPullTransport,
    options: SyncPullOptions = {}
  ) {
    this.batchSize = options.batchSize ?? 200;
    this.deferBaseMs = options.deferBaseMs ?? 30_000;
    this.deferMaxMs = options.deferMaxMs ?? 900_000;
    this.now = options.now ?? (() => Date.now());
  }

  async runOnce(): Promise<PullResult> {
    const from = readPullCursor(this.sql);

    // A recorded wait means the last run stopped on an event whose prerequisite had not
    // arrived. Fetching the same batch again before the wait is out would just fail the same
    // way, so the run does nothing and says when it is worth trying again. One row holds the
    // whole wait, so a prerequisite that never arrives costs nothing but that row.
    const deferral = readPullDeferral(this.sql);
    if (deferral !== null && deferral.seq > from && this.now() < deferral.until) {
      return {
        from,
        cursor: from,
        fetched: 0,
        applied: 0,
        duplicates: 0,
        refused: [],
        deferredUntil: deferral.until,
      };
    }

    let changes;
    try {
      changes = await this.transport.fetchChanges(from, this.batchSize);
    } catch (error) {
      const message = error instanceof Error ? error.message : "the service could not be reached";
      return { from, cursor: from, fetched: 0, applied: 0, duplicates: 0, refused: [], transportError: message };
    }

    let applied = 0;
    let duplicates = 0;
    const refused: PullProblem[] = [];
    const settled = new Set<number>();
    let waiting: PullProblem | undefined;
    // One arrival time for the whole run, from the injectable clock, so a test can fix it.
    const replicatedAt = new Date(this.now()).toISOString();

    // Sweep while something is still waiting and the last sweep settled something new.
    for (let sweep = 0; sweep <= changes.length; sweep += 1) {
      const before = settled.size;
      waiting = undefined;

      for (const change of changes) {
        if (settled.has(change.seq)) continue;
        const outcome = applyEnvelope(this.sql, change.envelope, replicatedAt);

        if (outcome.status === "APPLIED") {
          applied += 1;
          settled.add(change.seq);
        } else if (outcome.status === "DUPLICATE") {
          duplicates += 1;
          settled.add(change.seq);
        } else if (outcome.permanent === true) {
          refused.push(problem(change.seq, outcome));
          settled.add(change.seq);
        } else if (waiting === undefined) {
          // Its prerequisite has not arrived. Remembered, and the sweep carries on in case what
          // it needs is sitting further down the log.
          waiting = problem(change.seq, outcome);
        }
      }

      if (waiting === undefined || settled.size === before) break;
    }

    // Only the unbroken run of settled events from the start counts, so nothing unsettled is
    // ever left behind the cursor.
    let cursor = from;
    for (const change of changes) {
      if (!settled.has(change.seq)) break;
      cursor = change.seq;
    }

    writePullCursor(this.sql, cursor);

    // Record, or clear, the wait. The count only grows while the SAME position stays blocked, so
    // a prerequisite that arrives resets the wait instead of inheriting someone else's backoff.
    if (waiting === undefined) {
      if (deferral !== null) clearPullDeferral(this.sql);
    } else {
      const attempts = deferral !== null && deferral.seq === waiting.seq ? deferral.attempts + 1 : 1;
      const wait = Math.min(this.deferBaseMs * 2 ** (attempts - 1), this.deferMaxMs);
      writePullDeferral(this.sql, { seq: waiting.seq, until: this.now() + wait, attempts });
    }

    return { from, cursor, fetched: changes.length, applied, duplicates, refused, waitingFor: waiting };
  }
}

const problem = (seq: number, outcome: ApplyOutcome): PullProblem => ({
  seq,
  dedupeKey: outcome.dedupeKey,
  reason: outcome.reason ?? "REFUSED",
});

/** Applies one event straight away, outside a pull run. Used by the tests and by diagnostics. */
export const applyOne = (sql: SyncSqlHandle, envelope: SyncEnvelope): ApplyOutcome =>
  applyEnvelope(sql, envelope);
