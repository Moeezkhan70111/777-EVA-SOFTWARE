// Working through a backlog in one pass, within a budget.
//
// A pass used to send ONE batch (100 rows) and read ONE page (200 rows), once a minute. That is
// plenty day to day. It is not for a backfill: the store PC's history is ~12,700 rows, which took
// about two hours to send and another hour for a new PC to read, while the stock screen sat half
// filled. So a pass now carries on while each batch comes back FULL -- a full batch means there is
// more behind it -- and stops as soon as one comes back short, fails to reach the service, or the
// budget (a number of batches, and a time limit well inside the minute between passes) is spent.
//
// Nothing about a batch changes: each is the same claim, send and settle as before, so every rule
// about ordering, refusals and waiting holds batch by batch. Only the number of batches per pass
// changes.

import type { DrainResult } from "./drain.js";
import type { PullResult } from "./pull.js";

export interface BacklogBudget {
  /** Rows a full batch holds: a batch that comes back with fewer means the backlog is done. */
  readonly batchSize: number;
  readonly maxBatches: number;
  /** Stop starting new batches after this many milliseconds. */
  readonly withinMs: number;
  readonly now?: () => number;
}

/** A pass's sending budget: up to 2,000 rows, within 40 seconds. */
export const DRAIN_BUDGET = { batchSize: 100, maxBatches: 20, withinMs: 40_000 } as const;
/** A pass's reading budget: up to 5,000 log events, within 40 seconds. */
export const PULL_BUDGET = { batchSize: 200, maxBatches: 25, withinMs: 40_000 } as const;

/**
 * Sends batch after batch while each comes back full. `between` runs before every batch after the
 * first -- the pass builds what was marked, so a backfill's later records join the same pass.
 */
export async function drainBacklog(
  drain: { runOnce(): Promise<DrainResult> },
  budget: BacklogBudget,
  between: () => void = () => {}
): Promise<DrainResult> {
  const now = budget.now ?? Date.now;
  const stopAt = now() + budget.withinMs;
  let last = await drain.runOnce();
  let total = last;
  for (let batch = 1; batch < budget.maxBatches; batch += 1) {
    // Short: the queue is empty. Nothing sent: everything was refused or failed, and sending the
    // same rows again this minute will not change that. Unreached: the next pass retries.
    const more = last.transportError === undefined && last.leased === budget.batchSize && last.synced > 0;
    if (!more || now() >= stopAt) break;
    between();
    last = await drain.runOnce();
    total = mergeDrain(total, last);
  }
  return total;
}

/** Reads page after page while each comes back full. */
export async function pullBacklog(pull: { runOnce(): Promise<PullResult> }, budget: BacklogBudget): Promise<PullResult> {
  const now = budget.now ?? Date.now;
  const stopAt = now() + budget.withinMs;
  let total = await pull.runOnce();
  let lastFetched = total.fetched;
  for (let page = 1; page < budget.maxBatches; page += 1) {
    if (total.transportError !== undefined || lastFetched < budget.batchSize || now() >= stopAt) break;
    const next = await pull.runOnce();
    lastFetched = next.fetched;
    total = mergePull(total, next);
  }
  return total;
}

function mergeDrain(total: DrainResult, next: DrainResult): DrainResult {
  return {
    reclaimed: total.reclaimed + next.reclaimed,
    leased: total.leased + next.leased,
    synced: total.synced + next.synced,
    failed: total.failed + next.failed,
    deadLettered: total.deadLettered + next.deadLettered,
    refusals: [...total.refusals, ...next.refusals],
    counts: next.counts,
    ...(next.transportError !== undefined ? { transportError: next.transportError } : {}),
  };
}

function mergePull(total: PullResult, next: PullResult): PullResult {
  return {
    ...next,
    from: total.from,
    fetched: total.fetched + next.fetched,
    applied: total.applied + next.applied,
    duplicates: total.duplicates + next.duplicates,
    refused: [...total.refused, ...next.refused],
    ...(total.restartedForProject === true ? { restartedForProject: true } : {}),
  };
}
