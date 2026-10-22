// The renderer's two cloud-sync channels: what this computer's sync situation is, and one pass
// started by hand.
//
// THERE IS NOW A BACKGROUND LOOP. Passes happen on their own -- at startup, on an interval, and
// when the machine comes back online -- driven by the SyncScheduler in main.ts. This file no
// longer contains a pass: the one implementation lives in main/cloudSyncPass.ts and is what both
// the scheduler and the button below call. Two copies of "claim, drain, pull" would be two
// competing implementations of the most consequential operation here (CLAUDE.md section 2).
//
// WHY THE BUTTON STILL EXISTS. "Sync now" answers a question a timer cannot: did THIS change
// reach the other computers. It goes through the scheduler rather than around it, so it shares
// the single-flight guard -- two passes on one outbox would lease the same rows twice.
//
// WHAT THE RENDERER GETS BACK: counts, queue state, and the service's own already-scrubbed
// reason. Never a token, never the key, never the password.

import { ipcMain } from "electron";
import { IPC } from "../../shared/ipcChannels";
import type { IpcContext } from "./context";
import { rejection } from "../authorize";
import { describeCloudSync, isCloudSyncConfigured, runCloudSyncPass } from "../cloudSyncPass";

export interface CloudSyncOutcome {
  accepted: boolean;
  reason?: string;
  /** Carton identities sent and acknowledged this pass. */
  pushed?: number;
  /** Events read from the cloud log. */
  fetched?: number;
  /** Of those, written here for the first time. */
  applied?: number;
  /** Of those, already present — the normal result of a repeat. */
  duplicates?: number;
  /** Events this computer can never apply, each with the reason. From the pull. */
  refused?: Array<{ reason: string }>;
  /** Our own events the cloud turned away, with reasons. From the push. */
  pushRefusals?: Array<{ aggregateType: string; aggregateId: string; reason: string; parked: boolean }>;
  /** Waiting on something that has not arrived yet, if the pass stopped early. */
  waitingFor?: string;
  /** Queue state afterwards, so an operator can see what is still unsent. */
  outbox?: Record<string, number>;
}

const ALREADY_RUNNING = "A cloud sync is already running on this computer.";

/**
 * Single-flight guard for the fallback path only — when there is no scheduler to own it.
 *
 * Module scope because there is one main process and one outbox. With a scheduler present this
 * is never touched; the scheduler's own guard is the one in force, and the two can never both
 * be live because the handler takes exactly one branch.
 */
let manualPassRunning = false;

export function registerCloudSyncHandlers(ctx: IpcContext): void {
  const { db, logger, authorizer, deviceId, scanContext } = ctx;

  // WHAT THIS COMPUTER'S SYNC SITUATION IS. Read-only in every sense: pure SELECTs against the
  // local queue, no network, no pass started, nothing in the outbox touched.
  //
  // The queue is reported twice over, because one view is not enough. By STATUS, which is what
  // the Health page has always shown. And by SENDABILITY, because four of the six aggregate
  // types have no transport yet: without that split, "14 pending" cannot tell an operator
  // whether anything would actually move.
  //
  // ATTEMPTS ARE NOW RECORDED, not inferred. This used to report when a row was last SENT, so a
  // pass that carried nothing left no trace and the panel said "never" on a computer that had
  // been syncing all day. sync_runs (migration 085) holds one row per pass, so lastAttempt and
  // lastSuccess are read off attempts that actually happened -- which is the only way to tell a
  // working background loop from a broken one.
  //
  // @erp/sync is loaded here too, so a computer that never syncs still loads it to look at its
  // own queue. That is the price of the split, and it is a few kilobytes of pure JavaScript with
  // no side effects at import.
  ipcMain.handle(IPC.getCloudSyncStatus, async (event) => {
    authorizer.requireUser(event);
    const sync = await import("@erp/sync");
    const deferral = sync.readPullDeferral(db.db);
    // Read once: two calls to state() could disagree if a pass started between them.
    const schedulerState = ctx.syncScheduler?.state() ?? null;
    return {
      // Asked with the same credential question a pass asks, so the panel cannot call this
      // computer unconfigured while a pass would in fact run: once a credential is stored here,
      // the device password is genuinely no longer needed.
      ...describeCloudSync({ deviceId, dataRoot: ctx.paths.dataRoot }),
      // From the scheduler, which owns the single-flight guard, so "running" here is the same
      // fact the manual press is refused on.
      // The scheduler's view when there is one, the fallback guard's when there is not — the
      // same fact a manual press is refused on either way.
      running: schedulerState?.running ?? manualPassRunning,
      // What the background loop is doing: when the next pass is due, and how many transport
      // failures it has backed off over. Absent on a computer with no scheduler.
      schedule: schedulerState === null
        ? undefined
        : { nextPassInMs: schedulerState.nextPassInMs, consecutiveFailures: schedulerState.consecutiveFailures },
      // The last attempt and the last one that completed, from sync_runs.
      ...db.syncRunSummary(),
      queue: sync.outboxSummary(db.db, {
        pushableTypes: sync.SUPABASE_PUSHABLE_AGGREGATES,
        nowIso: new Date().toISOString(),
      }),
      // How far through the cloud log this computer has read. 0 means it has never applied one.
      pullCursor: sync.readPullCursor(db.db),
      // Set only while a pull is waiting on something that has not arrived.
      waitingFor:
        deferral === null
          ? undefined
          : {
              seq: deferral.seq,
              attempts: deferral.attempts,
              retryAfter: new Date(deferral.until).toISOString(),
            },
    };
  });

  ipcMain.handle(IPC.runCloudSync, async (event): Promise<CloudSyncOutcome> => {
    let admin;
    try {
      admin = authorizer.requireAdmin(event);
    } catch (error) {
      return rejection(error, "The cloud sync could not be started.");
    }

    if (!isCloudSyncConfigured({ deviceId, dataRoot: ctx.paths.dataRoot })) {
      // `problems` is present precisely when `configured` is false, which is the branch this is,
      // but the type does not say so — so it is read defensively rather than asserted.
      const settings = describeCloudSync({ deviceId, dataRoot: ctx.paths.dataRoot });
      const problems = settings.problems ?? [];
      return {
        accepted: false,
        reason:
          problems.length > 0
            ? `This computer is not set up for cloud sync: ${problems.join("; ")}`
            : "This computer is not set up for cloud sync.",
      };
    }

    // THROUGH THE SCHEDULER, not past it. It owns the single-flight guard, so a manual press
    // while a timed pass is running is declined rather than overlapping it — two passes on one
    // outbox is how rows get leased twice.
    // Nullish, not `=== null`: a context assembled without a scheduler leaves it undefined, and
    // treating that as "has a scheduler" would call runNow on nothing.
    const scheduler = ctx.syncScheduler ?? null;

    // ONE PASS AT A TIME, WHICHEVER PATH IS TAKEN.
    //
    // The scheduler owns the guard when there is one. When there is not — a computer whose
    // background loop failed to start — this handler still has to enforce it: two passes on one
    // outbox lease the same rows twice, and "the scheduler is missing" must not quietly remove
    // the protection along with the loop.
    let result;
    if (scheduler !== null) {
      result = await scheduler.runNow("MANUAL");
    } else {
      if (manualPassRunning) return { accepted: false, reason: ALREADY_RUNNING };
      manualPassRunning = true;
      try {
        result = await runCloudSyncPass(
          { db, logger, deviceId, workstationId: scanContext.workstationId, dataRoot: ctx.paths.dataRoot, actor: admin },
          "MANUAL"
        );
      } finally {
        manualPassRunning = false;
      }
    }

    if (result === null) return { accepted: false, reason: ALREADY_RUNNING };

    const pass = result as Awaited<ReturnType<typeof runCloudSyncPass>>;
    return {
      accepted: pass.outcome === "OK",
      reason: pass.reason,
      pushed: pass.pushed,
      fetched: pass.fetched,
      applied: pass.applied,
      duplicates: pass.duplicates,
      refused: pass.refusedEvents,
      pushRefusals: pass.pushRefusals,
      waitingFor: pass.waitingFor,
      outbox: pass.outbox,
    };
  });
}
