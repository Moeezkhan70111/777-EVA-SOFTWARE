// What this computer tells the cloud about its own sync health, and when (cloud migration 014).
//
// ONE ROW PER COMPUTER, AND NOT EVERY PASS. The cloud keeps one row per computer, overwritten. This
// computer sends a report only when it differs from the last one it sent, or as a keepalive once
// the last one is 15 minutes old -- about 96 calls a day when nothing is wrong, instead of one per
// pass. A row whose reported_at goes hours stale then says "this computer is off or offline".

import { describeWaiting, type WaitingSummary } from "./waiting.js";
import type { SyncHealthReport } from "./supabaseTransport.js";
import { asRow, type SyncSqlHandle } from "./sqlPort.js";

export const HEALTH_KEEPALIVE_MS = 15 * 60 * 1000;

/** Waits shown in the report, oldest first. The cloud keeps at most this many too. */
const SAMPLE_SIZE = 5;

/** Master-data changes made without a lease epoch: only the backfill will send them. */
export function unsentMarkCount(sql: SyncSqlHandle): number {
  try {
    return Number(asRow(sql.prepare("SELECT COUNT(*) AS n FROM sync_dirty_records WHERE lease_epoch IS NULL").get())?.n ?? 0);
  } catch {
    return 0; // before migration 094
  }
}

export function buildHealthReport(summary: WaitingSummary, deadLetters: number, unsentMarks: number): SyncHealthReport {
  // Only waits worth reporting go in the sample: an under-an-hour wait is ordinary ordering lag.
  const worth = summary.entries.filter((entry) => entry.tier !== "WAITING");
  return {
    waiting: summary.waiting,
    stuck: summary.stuck,
    stale: summary.stale,
    oldestWaitingSince: summary.oldestSince,
    sample: worth.slice(0, SAMPLE_SIZE).map((entry) => ({ ...describeWaiting(entry), since: entry.since })),
    deadLetters,
    unsentMarks,
  };
}

export interface LastReport {
  readonly report: SyncHealthReport;
  readonly sentAtMs: number;
}

/** True when this report says something new, or the last one is old enough to need a keepalive. */
export function shouldReport(last: LastReport | null, report: SyncHealthReport, nowMs: number): boolean {
  if (last === null) return true;
  if (nowMs - last.sentAtMs >= HEALTH_KEEPALIVE_MS) return true;
  return JSON.stringify(last.report) !== JSON.stringify(report);
}
