// Events pulled but not yet applicable, held so the cursor can move on (migration 091).
//
// A pulled event whose prerequisite has not arrived used to hold the pull cursor where it was, and
// with it every event behind it: the same batch was fetched on every pass, and once a batch's worth
// sat behind the blocked one nothing newer was ever fetched. Parking takes the waiting event out of
// the log's way. It is kept here, exactly as it arrived, and retried until it applies or is refused
// for good -- never dropped, never skipped.

import { isSyncEnvelope, type SyncEnvelope } from "./contract.js";
import { asRow, type SyncSqlHandle } from "./sqlPort.js";
import { waitedForKey } from "./waiting.js";

export interface ParkedEvent {
  readonly seq: number;
  readonly envelope: SyncEnvelope;
  readonly reason: string;
  /** How many times it has been found waiting, the first included. Widens the backoff. */
  readonly attempts: number;
}

export interface ParkingBackoff {
  /** The wait after the first refusal. Doubles per attempt, up to maxMs. */
  readonly baseMs: number;
  readonly maxMs: number;
}

const nextTryAt = (attempts: number, nowMs: number, backoff: ParkingBackoff): number =>
  nowMs + Math.min(backoff.baseMs * 2 ** (attempts - 1), backoff.maxMs);

/**
 * Parks an event, or records that a parked one is still waiting. Keyed by dedupe key, so the same
 * event fetched again -- after a cursor reset, say -- is one row, not two.
 */
export function parkEvent(
  sql: SyncSqlHandle,
  input: { seq: number; envelope: SyncEnvelope; reason: string; nowMs: number },
  backoff: ParkingBackoff
): void {
  const existing = asRow(
    sql.prepare("SELECT attempts FROM sync_inbox_parked WHERE dedupe_key = ?").get(input.envelope.dedupeKey)
  );
  const attempts = existing === null ? 1 : Number(existing.attempts) + 1;
  sql
    .prepare(
      `INSERT INTO sync_inbox_parked (dedupe_key, seq, envelope_json, reason, attempts, parked_at, next_try_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(dedupe_key) DO UPDATE SET
         reason = excluded.reason, attempts = excluded.attempts, next_try_at = excluded.next_try_at`
    )
    .run(
      input.envelope.dedupeKey,
      input.seq,
      JSON.stringify(input.envelope),
      input.reason,
      attempts,
      new Date(input.nowMs).toISOString(),
      nextTryAt(attempts, input.nowMs, backoff)
    );
}

/**
 * The parked events worth trying now, oldest log position first:
 *
 *   * those waiting for a record that has just ARRIVED (`arrived`, "TYPE:id"), at once;
 *   * those whose wait names no one record (still in use, a name still held), whenever anything
 *     arrived -- any arrival might be the one that frees them, and there are only ever a few;
 *   * every other one only when its backoff has run out.
 *
 * TARGETED, NOT ALL. A first sync can hold thousands of events that arrived before what they need.
 * Retrying every one of them whenever anything new applied cost about ten seconds per page of 200,
 * on the main process, and froze the window (gate test, 2026-10-27). Each now waits for its own
 * prerequisite and is tried once when that arrives.
 *
 * A row that no longer reads as an envelope is not returned. It cannot be applied, and leaving it
 * is the honest outcome: it stays visible in the summary rather than vanishing.
 */
export function parkedEventsToTry(sql: SyncSqlHandle, nowMs: number, arrived: ReadonlySet<string>): ParkedEvent[] {
  // Reasons first, without the envelopes: cheap even for thousands of rows.
  const waits = sql.prepare("SELECT dedupe_key, reason, next_try_at FROM sync_inbox_parked").all().map(asRow);
  const wanted = new Set<string>();
  for (const wait of waits) {
    if (wait === null) continue;
    const key = waitedForKey(String(wait.reason));
    const due = Number(wait.next_try_at) <= nowMs;
    const freed = key === null ? arrived.size > 0 : arrived.has(key);
    if (due || freed) wanted.add(String(wait.dedupe_key));
  }
  if (wanted.size === 0) return [];

  const rows = sql.prepare("SELECT dedupe_key, seq, envelope_json, reason, attempts FROM sync_inbox_parked ORDER BY seq").all().map(asRow);
  const events: ParkedEvent[] = [];
  for (const row of rows) {
    if (row === null || !wanted.has(String(row.dedupe_key))) continue;
    const envelope = readEnvelope(String(row.envelope_json ?? ""));
    if (envelope === null) continue;
    events.push({ seq: Number(row.seq), envelope, reason: String(row.reason), attempts: Number(row.attempts) });
  }
  return events;
}

const readEnvelope = (json: string): SyncEnvelope | null => {
  try {
    const parsed: unknown = JSON.parse(json);
    return isSyncEnvelope(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

/** A parked event has been settled -- applied, already here, or refused for good. */
export function unparkEvent(sql: SyncSqlHandle, dedupeKey: string): void {
  sql.prepare("DELETE FROM sync_inbox_parked WHERE dedupe_key = ?").run(dedupeKey);
}

/** Forgets every parked event. Only for a move to another project, whose log they do not belong to. */
export function clearParkedEvents(sql: SyncSqlHandle): void {
  sql.prepare("DELETE FROM sync_inbox_parked").run();
}

export interface ParkedSummary {
  readonly count: number;
  /** The parked event at the earliest log position, and when it is next due. Null when none. */
  readonly oldest: {
    readonly seq: number;
    readonly dedupeKey: string;
    readonly reason: string;
    readonly attempts: number;
    readonly nextTryAt: number;
  } | null;
}

/** What the Health page shows: how many are parked, and the one that has waited longest. */
export function parkedSummary(sql: SyncSqlHandle): ParkedSummary {
  const count = asRow(sql.prepare("SELECT COUNT(*) AS n FROM sync_inbox_parked").get());
  const oldest = asRow(
    sql.prepare("SELECT seq, dedupe_key, reason, attempts, next_try_at FROM sync_inbox_parked ORDER BY seq LIMIT 1").get()
  );
  return {
    count: Number(count?.n ?? 0),
    oldest:
      oldest === null
        ? null
        : {
            seq: Number(oldest.seq),
            dedupeKey: String(oldest.dedupe_key),
            reason: String(oldest.reason),
            attempts: Number(oldest.attempts),
            nextTryAt: Number(oldest.next_try_at),
          },
  };
}
