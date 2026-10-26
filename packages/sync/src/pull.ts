// Receiving what the other computers sent.
//
// This is the half that makes a second PC show the same business data. Pushing alone only empties
// one computer's queue; until a computer can pull, it has nothing of anyone else's.
//
// The shape is a cursor over an ordered log:
//
//   read cursor  →  fetch what is after it  →  apply each, in order  →  advance the cursor
//
// EVERY FETCHED EVENT IS SETTLED BEFORE THE CURSOR PASSES IT. Applied, already here, permanently
// refused -- or PARKED (parking.ts, migration 091) when its prerequisite has not arrived. A parked
// event is held locally, exactly as it arrived, and retried until it applies or is refused for good,
// so the cursor can pass it without it ever being skipped.
//
// It used to be the other way round: a waiting event held the cursor at its position, the same
// batch was fetched on every pass, and once a batch's worth of events sat behind it nothing newer
// was ever fetched. Raw material arrivals wait for their master data by decision (docs/37), so one
// new material on another computer would in time have frozen all replication into this one.
//
// WHY THE BATCH IS SWEPT MORE THAN ONCE. If the log ever holds a scan before the carton identity it
// needs -- another computer pushed the identity later, or a retry reordered them -- one pass would
// park the scan although its identity sits a few positions further on. So the sweep repeats while
// it is still making progress, and only what is STILL waiting at the end is parked. Re-applying is
// free (every apply is idempotent) and the loop is bounded by the number of events fetched.
//
// PARKED EVENTS ARE RETRIED after each fetch: all of them when the run applied anything new -- it
// may be exactly what one was waiting for -- and otherwise only those whose backoff has run out.
// A fetch that fails still retries them, because that work needs no network.
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
  clearParkedEvents,
  parkedEventsToTry,
  parkedSummary,
  parkEvent,
  unparkEvent,
  type ParkingBackoff,
} from "./parking.js";
import { bindPullCursorToProject, clearPullDeferral, readPullCursor, writePullCursor } from "./pullCursor.js";
import { asRow, type SyncSqlHandle } from "./sqlPort.js";
import type { SyncChange, SyncPullTransport } from "./transport.js";

export interface PullProblem {
  readonly seq: number;
  readonly dedupeKey: string;
  readonly reason: string;
}

export interface PullResult {
  /** Where the cursor stood before the run. */
  readonly from: number;
  /** Where it stands now: past every event fetched, because each one was settled or parked. */
  readonly cursor: number;
  readonly fetched: number;
  /** Applied for the first time this run, from the log or from the parked events. */
  readonly applied: number;
  /** The aggregate types of what was applied this run, so open screens showing them can refresh. */
  readonly appliedTypes?: readonly string[];
  readonly duplicates: number;
  /** Permanently refused. Each is reported, never silently dropped. */
  readonly refused: readonly PullProblem[];
  /** How many events are parked after this run, waiting for something to arrive. */
  readonly parked: number;
  /** The parked event at the earliest log position, when any is parked. */
  readonly waitingFor?: PullProblem;
  /** Set when the service could not be reached. The cursor did not move. */
  readonly transportError?: string;
  /** Set when the cursor belonged to another project, or to none, and was started again from zero. */
  readonly restartedForProject?: boolean;
}

export interface SyncPullOptions {
  readonly batchSize?: number;
  /** A parked event's first wait. It doubles per attempt, up to the cap. */
  readonly deferBaseMs?: number;
  readonly deferMaxMs?: number;
  /** Injected so a test can move time forward without waiting. */
  readonly now?: () => number;
  /**
   * The project this computer is pulling from (its URL). When given, a cursor recorded for a
   * different project -- or for none -- is forgotten before the first fetch. See pullCursor.ts.
   */
  readonly project?: string;
}

/** What one run did, gathered as it goes. */
interface Tally {
  applied: number;
  appliedTypes: Set<string>;
  duplicates: number;
  refused: PullProblem[];
  /** Parked by THIS run, so the retry at its end does not try them a second time. */
  parkedNow: Set<string>;
}

export class SyncPull {
  private readonly batchSize: number;
  private readonly backoff: ParkingBackoff;
  private readonly now: () => number;
  private readonly project: string | undefined;

  constructor(
    private readonly sql: SyncSqlHandle,
    private readonly transport: SyncPullTransport,
    options: SyncPullOptions = {}
  ) {
    this.batchSize = options.batchSize ?? 200;
    this.backoff = { baseMs: options.deferBaseMs ?? 30_000, maxMs: options.deferMaxMs ?? 900_000 };
    this.now = options.now ?? (() => Date.now());
    this.project = options.project;
  }

  async runOnce(): Promise<PullResult> {
    const restartedForProject = this.bindToProject() ? { restartedForProject: true } : {};
    const from = readPullCursor(this.sql);
    const tally: Tally = { applied: 0, appliedTypes: new Set(), duplicates: 0, refused: [], parkedNow: new Set() };
    // One arrival time for the whole run, from the injectable clock, so a test can fix it.
    const replicatedAt = new Date(this.now()).toISOString();

    let changes: SyncChange[];
    try {
      changes = await this.transport.fetchChanges(from, this.batchSize);
    } catch (error) {
      this.retryParked(tally, false, replicatedAt);
      const message = error instanceof Error ? error.message : "the service could not be reached";
      return { ...this.result(from, from, 0, tally), transportError: message, ...restartedForProject };
    }

    this.applyBatch(changes, tally, replicatedAt);
    // Every fetched event is now settled or parked, so the cursor passes the whole batch.
    const cursor = changes.reduce((highest, change) => Math.max(highest, change.seq), from);
    writePullCursor(this.sql, cursor);

    this.retryParked(tally, tally.applied > 0, replicatedAt);
    return { ...this.result(from, cursor, changes.length, tally), ...restartedForProject };
  }

  /**
   * Makes the cursor this project's. On a move, parked events go too: they belong to the old log.
   * The pull-level wait of earlier builds (sync.pull.deferred) is retired by parking and cleared.
   */
  private bindToProject(): boolean {
    const restarted = this.project !== undefined && bindPullCursorToProject(this.sql, this.project);
    if (restarted) clearParkedEvents(this.sql);
    clearPullDeferral(this.sql);
    return restarted;
  }

  /** Applies a fetched batch, sweeping while it makes progress, and parks what still waits. */
  private applyBatch(changes: readonly SyncChange[], tally: Tally, replicatedAt: string): void {
    const alreadyParked = this.parkedKeys();
    const settled = new Set<number>();
    const waiting = new Map<number, PullProblem>();

    for (let sweep = 0; sweep <= changes.length; sweep += 1) {
      const before = settled.size;
      waiting.clear();
      for (const change of changes) {
        if (settled.has(change.seq)) continue;
        const outcome = applyEnvelope(this.sql, change.envelope, replicatedAt);
        if (outcome.status === "REJECTED" && outcome.permanent !== true) {
          waiting.set(change.seq, problem(change.seq, outcome));
          continue;
        }
        settled.add(change.seq);
        this.count(outcome, change.seq, tally, change.envelope.aggregateType);
        if (alreadyParked.has(change.envelope.dedupeKey)) unparkEvent(this.sql, change.envelope.dedupeKey);
      }
      if (waiting.size === 0 || settled.size === before) break;
    }

    for (const change of changes) {
      const waited = waiting.get(change.seq);
      if (waited === undefined) continue;
      parkEvent(this.sql, { seq: change.seq, envelope: change.envelope, reason: waited.reason, nowMs: this.now() }, this.backoff);
      tally.parkedNow.add(change.envelope.dedupeKey);
    }
  }

  /** Tries parked events again: all of them, or only those whose backoff has run out. */
  private retryParked(tally: Tally, all: boolean, replicatedAt: string): void {
    for (const parked of parkedEventsToTry(this.sql, this.now(), all)) {
      if (tally.parkedNow.has(parked.envelope.dedupeKey)) continue;
      const outcome = applyEnvelope(this.sql, parked.envelope, replicatedAt);
      if (outcome.status === "REJECTED" && outcome.permanent !== true) {
        // Still waiting: the row stays, with a wider backoff.
        parkEvent(this.sql, { seq: parked.seq, envelope: parked.envelope, reason: outcome.reason ?? parked.reason, nowMs: this.now() }, this.backoff);
        continue;
      }
      this.count(outcome, parked.seq, tally, parked.envelope.aggregateType);
      unparkEvent(this.sql, parked.envelope.dedupeKey);
    }
  }

  private count(outcome: ApplyOutcome, seq: number, tally: Tally, aggregateType: string): void {
    if (outcome.status === "APPLIED") {
      tally.applied += 1;
      tally.appliedTypes.add(aggregateType);
    } else if (outcome.status === "DUPLICATE") {
      tally.duplicates += 1;
    } else {
      tally.refused.push(problem(seq, outcome));
    }
  }

  private parkedKeys(): Set<string> {
    const rows = this.sql.prepare("SELECT dedupe_key FROM sync_inbox_parked").all().map(asRow);
    return new Set(rows.flatMap((row) => (row === null ? [] : [String(row.dedupe_key)])));
  }

  private result(from: number, cursor: number, fetched: number, tally: Tally): PullResult {
    const summary = parkedSummary(this.sql);
    return {
      from,
      cursor,
      fetched,
      applied: tally.applied,
      appliedTypes: [...tally.appliedTypes].sort(),
      duplicates: tally.duplicates,
      refused: tally.refused,
      parked: summary.count,
      waitingFor:
        summary.oldest === null
          ? undefined
          : { seq: summary.oldest.seq, dedupeKey: summary.oldest.dedupeKey, reason: summary.oldest.reason },
    };
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
