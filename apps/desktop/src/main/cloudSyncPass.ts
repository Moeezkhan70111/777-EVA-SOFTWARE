// ONE CLOUD SYNC PASS — the only implementation of it.
//
// This was the body of the runCloudSync IPC handler. It moved here when passes started happening
// on a timer, because a scheduler that ran its own copy of "claim, drain, pull" would be a second
// competing implementation of the most consequential operation in the application (CLAUDE.md §2).
// The manual button and the background scheduler now call this same function; the only difference
// between them is the `trigger` recorded against the run.
//
// WHAT A PASS DOES
//
//   sign in   as this computer's device account, holding the token in memory only
//   claim     prove to the cloud that this account is bound to THIS device and workstation
//   push      the supported aggregate types from the local outbox, oldest first
//   pull      everything in the cloud log after this computer's cursor, and apply it
//
// THE CLAIM COMES FIRST AND NOTHING IS TOUCHED UNTIL IT SUCCEEDS. Migration 006 binds the
// account to one device and hands back an epoch every write must present; a second computer
// claiming the same enrolment evicts this one. The claim happens before the drain exists because
// a drain reclaims stale rows and leases a batch the moment it runs — both mutate the outbox, and
// a device that may not write must not have its queue disturbed for finding out.
//
// IT NEVER THROWS. Every failure becomes an outcome, because the scheduler must not have to
// catch and the ERP must not care. A week of failed passes is a week of ordinary local work.
//
// WHAT THE CALLER GETS BACK: counts, and the service's own already-scrubbed reason. Never a
// token, never the key, never the password.

import { app } from "electron";
import type { SqliteDatabase, StructuredLogger, SyncRunOutcome, SyncRunTrigger } from "@erp/data";
import type { DeviceSyncHealth, LastReport, SupabaseSyncTransport, SyncPassResult } from "@erp/sync";
import { describeCloudSyncConfig, readCloudSyncConfig } from "./cloudConfig";
import { DeviceCredentialStore } from "./deviceCredentialStore";
import { announceDataChanged } from "./dataChanged";
import { dataKindsOf } from "../shared/dataChange";

export interface CloudSyncPassOutcome extends SyncPassResult {
  /** Carton identities and production events sent and acknowledged this pass. */
  pushed?: number;
  /** Events read from the cloud log. */
  fetched?: number;
  /** Of those, written here for the first time. */
  applied?: number;
  /** Of those, already present — the normal result of a repeat. */
  duplicates?: number;
  /** Events this computer can never apply, each with the reason. Comes from the PULL. */
  refusedEvents?: Array<{ reason: string }>;
  /**
   * Events the cloud REFUSED to accept from us, with reasons. From the PUSH.
   *
   * Reported separately from refusedEvents because the two mean opposite things: one is work
   * arriving that this computer cannot apply, the other is this computer's own work being turned
   * away. Until this existed the reason reached sync_outbox.last_error and nowhere else, so a
   * refused push was indistinguishable from having nothing to send.
   */
  pushRefusals?: Array<{ aggregateType: string; aggregateId: string; reason: string; parked: boolean }>;
  /** Waiting on something that has not arrived yet, if the pull stopped early. */
  waitingFor?: string;
  /** Queue state afterwards, so an operator can see what is still unsent. */
  outbox?: Record<string, number>;
}

export interface CloudSyncPassDeps {
  readonly db: SqliteDatabase;
  readonly logger: StructuredLogger;
  readonly deviceId: string;
  readonly workstationId: string;
  readonly dataRoot: string;
  /** Who asked, when a person did. Absent for a scheduled pass. */
  readonly actor?: { id: string; username: string };
}

/**
 * THE TRANSPORT IS KEPT BETWEEN PASSES, and the claim it holds with it.
 *
 * A new transport per pass meant a new `claimDevice` per pass, because the claim lives in the
 * transport ("in memory only, and gone when the process is"). That bumped the epoch every five
 * minutes and wrote two audit rows each time — see heartbeatDevice in supabaseTransport.ts for
 * why that is worse than untidy.
 *
 * Held at module scope because there is one process, one device identity and one outbox. The
 * configuration is read afresh on every pass, so a computer provisioned mid-session still picks
 * it up; only the authenticated session and the claim are reused.
 *
 * THE IDENTITY BELOW IS EVERYTHING THAT DECIDES WHO THE TRANSPORT IS SIGNED IN AS. If any part
 * of it changes the transport is rebuilt, because reusing one would mean carrying a session, and
 * a claim, that belongs to somebody else:
 *
 *   url, email   — a different project or account entirely
 *   anonKey      — a rotated key: the cached transport would keep sending the old one
 *   deviceId     — the claim is per device, and so is the stored credential
 *   dataRoot     — which credential file the session was restored from
 */
interface CachedTransport {
  readonly transport: SupabaseSyncTransport;
  readonly url: string;
  readonly email: string;
  readonly anonKey: string;
  readonly deviceId: string;
  readonly dataRoot: string;
}

let cachedTransport: CachedTransport | null = null;

/**
 * The last sync-health report this process sent, per project and device, so a report goes only when
 * it says something new or as a 15-minute keepalive (healthReport.ts). In memory: a restart sends one
 * at once, which is what a restart should do. A project without the report (no cloud migration 014)
 * is remembered too, and not asked again until the next start.
 */
let healthReporting: { key: string; last: LastReport | null; unsupported: boolean } | null = null;

/** Whether this computer is set up to sync at all. Cheap, read-only, no network. */
export function isCloudSyncConfigured(deps: Pick<CloudSyncPassDeps, "deviceId" | "dataRoot">): boolean {
  const credentials = new DeviceCredentialStore(deps.dataRoot);
  return readCloudSyncConfig(process.env, { hasStoredCredential: credentials.matchesDevice(deps.deviceId) }).configured;
}

/** This computer's sync configuration as the renderer may see it — no secrets in it. */
export function describeCloudSync(deps: Pick<CloudSyncPassDeps, "deviceId" | "dataRoot">) {
  const credentials = new DeviceCredentialStore(deps.dataRoot);
  return describeCloudSyncConfig(
    readCloudSyncConfig(process.env, { hasStoredCredential: credentials.matchesDevice(deps.deviceId) })
  );
}

/**
 * The session the realtime doorbell listens with (realtimeWake.ts): this computer's project and its
 * signed-in transport, or null before a pass has made one. Nothing secret leaves here but the token
 * function, which the doorbell hands only to the cloud.
 */
export function doorbellSession(): { url: string; anonKey: string; deviceId: string; accessToken: () => Promise<string> } | null {
  const held = cachedTransport;
  if (held === null) return null;
  return { url: held.url, anonKey: held.anonKey, deviceId: held.deviceId, accessToken: () => held.transport.accessToken() };
}

/**
 * Every computer's last sync-health report, read through the transport the passes signed in with,
 * or null before the first pass has made one. On demand only (the Health page), never per pass.
 */
export async function readFactorySyncHealth(): Promise<DeviceSyncHealth[] | null> {
  const held = cachedTransport;
  if (held === null) return null;
  return held.transport.fetchFactorySyncHealth();
}

/** Builds marked master records into queued revisions. Never throws: a pass reports, it does not crash. */
function buildMasterRecords(db: SqliteDatabase, logger: StructuredLogger, deviceId: string): void {
  try {
    const built = db.buildLeasedRecordRevisions(new Date().toISOString());
    if (built.unqueued > 0) {
      logger.log({
        module: "sync", severity: "WARNING", operation: "master-records", deviceId,
        message: `${String(built.unqueued)} changed master record(s) could not be queued and stay marked for the next pass.`,
      });
    }
  } catch (error) {
    logger.log({
      module: "sync", severity: "ERROR", operation: "master-records", deviceId,
      message: `Changed master records could not be built: ${error instanceof Error ? error.message : String(error)}. They stay marked.`,
    });
  }
}

/**
 * Builds the label runs and packets the backfill marked, after the master records so a material and
 * its supplier are queued ahead of their labels. Never throws.
 */
function buildLabelRuns(db: SqliteDatabase, logger: StructuredLogger, deviceId: string): void {
  try {
    const built = db.buildLabelRuns(new Date().toISOString());
    if (built.unqueued > 0) {
      logger.log({
        module: "sync", severity: "WARNING", operation: "label-runs", deviceId,
        message: `${String(built.unqueued)} label run(s) or packet(s) could not be queued and stay marked.`,
      });
    }
  } catch (error) {
    logger.log({
      module: "sync", severity: "ERROR", operation: "label-runs", deviceId,
      message: `Label runs could not be built: ${error instanceof Error ? error.message : String(error)}. They stay marked.`,
    });
  }
}

/**
 * Builds marked stock movements into queued events, after the master records so a material is
 * queued ahead of its stock. Never throws.
 */
function buildStockEvents(db: SqliteDatabase, logger: StructuredLogger, deviceId: string): void {
  try {
    const built = db.buildStockEvents(new Date().toISOString());
    if (built.unqueued > 0 || built.vanished > 0) {
      logger.log({
        module: "sync", severity: "WARNING", operation: "stock-events", deviceId,
        message:
          `${String(built.unqueued)} stock movement(s) could not be queued and stay marked` +
          `${built.vanished > 0 ? `, and ${String(built.vanished)} were removed before they could be sent` : ""}.`,
      });
    }
  } catch (error) {
    logger.log({
      module: "sync", severity: "ERROR", operation: "stock-events", deviceId,
      message: `Stock movements could not be built: ${error instanceof Error ? error.message : String(error)}. They stay marked.`,
    });
  }
}

/** Sends this computer's sync health when it changed, or as a keepalive. Never throws. */
async function reportSyncHealth(
  sync: typeof import("@erp/sync"),
  transport: SupabaseSyncTransport,
  db: SqliteDatabase,
  key: string
): Promise<void> {
  if (healthReporting === null || healthReporting.key !== key) healthReporting = { key, last: null, unsupported: false };
  const state = healthReporting;
  if (state.unsupported) return;
  try {
    const nowMs = Date.now();
    const report = sync.buildHealthReport(
      sync.waitingSummary(db.db, nowMs),
      sync.outboxCounts(db.db).DEAD_LETTER,
      sync.unsentMarkCount(db.db)
    );
    if (!sync.shouldReport(state.last, report, nowMs)) return;
    const sent = await transport.reportSyncHealth(report);
    if (sent === "NOT_SUPPORTED") state.unsupported = true;
    else if (sent === "REPORTED") state.last = { report, sentAtMs: nowMs };
  } catch {
    // Unreachable, or refused: the next pass tries again, because nothing was recorded as sent.
  }
}

/**
 * Replaces the lease cache with the cloud's answer. Returns a transport failure's reason, or
 * undefined when the pass may call itself fine. Never throws: a pass reports, it does not crash.
 */
async function refreshLeaseCache(
  sync: typeof import("@erp/sync"),
  transport: SupabaseSyncTransport,
  db: SqliteDatabase,
  projectUrl: string,
  deviceId: string,
  logger: StructuredLogger
): Promise<string | undefined> {
  try {
    const fetched = await transport.fetchLeases();
    if (fetched.ok) {
      sync.replaceLeaseCache(db.db, projectUrl, fetched.leases, new Date().toISOString());
      return undefined;
    }
    // NOT_SUPPORTED is the normal state of a project without leases, and says so every pass, so it
    // is not logged. It is recorded: such a project cannot enforce a lease, so the gate lets this
    // computer write as it did before leases rather than lock it out. UNREADABLE is a fault worth seeing.
    if (fetched.reason === "NOT_SUPPORTED") {
      sync.markLeasesUnsupported(db.db, projectUrl);
      return undefined;
    }
    if (fetched.reason === "UNREADABLE") {
      logger.log({
        module: "sync", severity: "WARNING", operation: "leases", deviceId,
        message: "The cloud's answer about who holds each write lease was unreadable. The last good answer is kept.",
      });
    }
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : "The write leases could not be read.";
  }
}

/**
 * Runs one pass and records it in sync_runs.
 *
 * The run row is opened before the network is touched and closed on every path out, so an
 * unclosed row means the process died mid-pass — which is worth being able to see.
 */
export async function runCloudSyncPass(
  deps: CloudSyncPassDeps,
  trigger: SyncRunTrigger
): Promise<CloudSyncPassOutcome> {
  const { db, logger, deviceId, workstationId, dataRoot, actor } = deps;
  const runId = db.startSyncRun(trigger);

  /** Closes the run and hands the outcome back in one place, so no path can forget. */
  const finish = (
    outcome: SyncRunOutcome,
    result: Omit<CloudSyncPassOutcome, "outcome">
  ): CloudSyncPassOutcome => {
    db.finishSyncRun(
      runId,
      outcome,
      {
        pushed: result.pushed,
        fetched: result.fetched,
        applied: result.applied,
        duplicates: result.duplicates,
        refused: result.refusedEvents?.length,
      },
      result.reason
    );
    return { ...result, outcome };
  };

  const credentials = new DeviceCredentialStore(dataRoot);
  const stored = credentials.load();
  const usable = stored !== null && stored.deviceId === deviceId;
  const settings = readCloudSyncConfig(process.env, { hasStoredCredential: usable });
  if (!settings.configured) {
    return finish("FAILED", {
      reason: `This computer is not set up for cloud sync: ${settings.problems.join("; ")}`,
    });
  }

  try {
    const sync = await import("@erp/sync");
    const auth = new sync.SupabaseDeviceAuth(
      { ...settings.config, refreshToken: usable ? stored.refreshToken : undefined },
      () => Date.now(),
      (session) => {
        // FIRST-RUN PROVISIONING, and every rotation after it. A refresh token that cannot be
        // stored must not fail the pass — the sync itself is fine, and the cost is only that the
        // next start needs the password again — so the outcome is logged, never thrown.
        const saved = credentials.save({
          authUserId: session.userId ?? stored?.authUserId ?? "",
          deviceId,
          refreshToken: session.refreshToken,
          provisionedAt: new Date().toISOString(),
        });
        if (saved !== "SAVED") {
          logger.log({
            module: "sync",
            severity: "WARNING",
            operation: "device-credential",
            deviceId,
            message: `This computer's cloud credential was not stored (${saved}). Sync is unaffected; the device password will be needed again after a restart.`,
          });
          return;
        }
        if (!usable) {
          logger.log({
            module: "sync",
            severity: "INFO",
            operation: "device-credential",
            deviceId,
            message: "This computer's cloud credential was stored. The device password is no longer needed to sync here.",
          });
        }
      }
    );

    // Reused only when every part of the identity matches, so a re-provisioned computer can
    // never keep signing in as whoever it used to be.
    const identity = {
      url: settings.config.url,
      email: settings.config.email ?? "",
      anonKey: settings.config.anonKey,
      deviceId,
      dataRoot,
    };
    const held = cachedTransport;
    const sameTarget =
      held !== null &&
      held.url === identity.url &&
      held.email === identity.email &&
      held.anonKey === identity.anonKey &&
      held.deviceId === identity.deviceId &&
      held.dataRoot === identity.dataRoot;
    const transport: SupabaseSyncTransport =
      sameTarget && held !== null
        ? held.transport
        : new sync.SupabaseSyncTransport({ url: identity.url, anonKey: identity.anonKey, auth });
    if (!sameTarget) {
      cachedTransport = { transport, ...identity };
    }

    const queueNow = () =>
      sync.outboxSummary(db.db, {
        pushableTypes: sync.SUPABASE_PUSHABLE_AGGREGATES,
        nowIso: new Date().toISOString(),
      }).counts;

    // CLAIM ONCE, THEN CONFIRM. A held claim is heartbeaten rather than retaken, so the epoch
    // increments only on a restart or a genuine eviction. A refused heartbeat drops the claim,
    // and the fresh claim below is what a real takeover looks like from this side.
    const beat = transport.claimed
      ? await transport.heartbeatDevice()
      : { ok: false as const, reason: "NOT_CLAIMED" };

    const claim = beat.ok
      ? { ok: true as const, reason: undefined }
      : await transport.claimDevice({ deviceId, workstationId, appVersion: app.getVersion() });
    if (!claim.ok) {
      logger.log({
        module: "sync",
        severity: "WARNING",
        operation: "cloud-sync",
        deviceId,
        userId: actor?.id,
        // The administrator who asked is named: a refused claim is an enrolment problem, and the
        // audit trail has to say who was told about it. A scheduled pass has no actor.
        message:
          `Cloud sync refused (${trigger}${actor ? ` for ${actor.username}` : ""}): ` +
          `the cloud did not accept this computer (${claim.reason})`,
      });
      return finish("REFUSED", {
        reason: `The cloud did not accept this computer: ${claim.reason}. Nothing was sent, and nothing in the queue changed.`,
        outbox: queueNow(),
      });
    }

    // MASTER DATA FIRST: every record changed under this computer's master-data lease becomes a
    // queued revision (masterRecords.ts), so this pass's drain carries it. A failure here is logged
    // and the pass goes on: the marks stay, and the next pass builds them.
    buildMasterRecords(db, logger, deviceId);
    // Then the labels the backfill marked, then the stock movements, each behind its material.
    buildLabelRuns(db, logger, deviceId);
    buildStockEvents(db, logger, deviceId);

    const drain = new sync.OutboxDrain(db.db, transport, {
      deviceId,
      aggregateTypes: sync.SUPABASE_PUSHABLE_AGGREGATES,
      batchSize: sync.DRAIN_BUDGET.batchSize,
    });
    // BATCH AFTER BATCH while each comes back full, within the budget (backlog.ts): a backfill's
    // thousands of rows go in minutes, not hours. What was marked meanwhile is built between
    // batches, so a backfill's later master records and their stock join this pass.
    const pushed = await sync.drainBacklog(drain, sync.DRAIN_BUDGET, () => {
      buildMasterRecords(db, logger, deviceId);
      buildLabelRuns(db, logger, deviceId);
      buildStockEvents(db, logger, deviceId);
    });

    // The project goes with the cursor: a computer moved to another project (test -> production)
    // starts reading that project's log from the beginning instead of from a position that only
    // meant something in the old one.
    const pull = new sync.SyncPull(db.db, transport, { project: identity.url, batchSize: sync.PULL_BUDGET.batchSize });
    // Page after page while each comes back full: a new computer reads the log in minutes.
    const pulled = await sync.pullBacklog(pull, sync.PULL_BUDGET);
    // Open screens showing what just arrived reload in place: a figure that is current in the
    // database but stale on the screen is no better than a slow sync. Anything read can also settle
    // or start a wait, so a read that applied nothing still tells the waiting lists.
    if (pulled.applied > 0 || pulled.fetched > 0) announceDataChanged(dataKindsOf(pulled.appliedTypes ?? []));
    if (pulled.restartedForProject) {
      logger.log({
        module: "sync",
        severity: "INFO",
        operation: "pull-cursor",
        deviceId,
        message: `Reading ${describeCloudSyncConfig(settings).host ?? "this project"} from the beginning: the saved position belonged to another project, or to none.`,
      });
    }

    // WHO HOLDS WHAT (docs/37 section W), read after the pull so the catch-up barrier is judged
    // against what this computer has just read. The local write gate reads this cache, offline too.
    // A project without leases (no cloud migration 011) is not a failure: carton sync carries on,
    // and the cache keeps whatever it had. A failure to reach the cloud is one, like any other call.
    const leaseError = await refreshLeaseCache(sync, transport, db, identity.url, deviceId, logger);

    // WHETHER THIS COMPUTER IS WAITING ON ANYTHING, told to the cloud (migration 014), so a wait that
    // lasts is seen somewhere other than this computer's own Health page. Never fails the pass.
    await reportSyncHealth(sync, transport, db, `${identity.url}|${deviceId}`);

    // Read through a default. The drain always supplies this, but a pass must not be able to
    // throw on the SHAPE of its own result -- that would turn a reported refusal into an
    // unreported crash, which is the opposite of what the field is for.
    const pushRefusals = pushed.refusals ?? [];
    const transportError = pushed.transportError ?? pulled.transportError ?? leaseError;

    // A PASS THAT DID NOTHING IS NOT LOGGED. At one pass a minute, logging every one added about
    // 1,440 identical lines a day to app.log, which is never rotated, and buried the passes that
    // mattered. sync_runs still records it (pruned after a day), and Sync Now is always logged: a
    // person asked, and the log says who.
    const didNothing =
      trigger !== "MANUAL" &&
      transportError === undefined &&
      pushed.synced === 0 &&
      pushRefusals.length === 0 &&
      pulled.fetched === 0 &&
      pulled.applied === 0 &&
      pulled.refused.length === 0;

    if (!didNothing) logger.log({
      module: "sync",
      severity: "INFO",
      operation: "cloud-sync",
      deviceId,
      userId: actor?.id,
      message:
        `Cloud sync (${trigger}${actor ? ` by ${actor.username}` : ""}): sent ${String(pushed.synced)}, ` +
        `read ${String(pulled.fetched)}, applied ${String(pulled.applied)}, ` +
        `already here ${String(pulled.duplicates)}, refused ${String(pulled.refused.length)}` +
        // The push verdicts, named. "sent 0" on its own hid these entirely.
        (pushRefusals.length === 0
          ? ""
          : `; cloud refused ${String(pushRefusals.length)}: ` +
            pushRefusals.map((r) => `${r.aggregateType} ${r.aggregateId} (${r.reason})`).join(", ")),
    });

    // THE CAUSE, NOT JUST THE COUNT. `reason` is what sync_runs records and what the panel
    // reads back as the newest verdict, so a refusal with no transport error has to put its
    // cause here or the operator is told "would not accept 2 items" and nothing else.
    //
    // It does NOT make the pass a failure: the outcome below is decided by transportError
    // alone, and rightly — other rows may well have gone through on the same pass.
    //
    // Distinct reasons only, and no payload: the aggregate ids are in the log line above and in
    // Settings, and this sentence has to stay short enough to read.
    const distinctReasons = [...new Set(pushRefusals.map((refusal) => refusal.reason))];
    const result = {
      reason: transportError ?? (distinctReasons.length > 0 ? distinctReasons.join(", ") : undefined),
      pushRefusals: pushRefusals.map((r) => ({
        aggregateType: r.aggregateType,
        aggregateId: r.aggregateId,
        reason: r.reason,
        parked: r.parked,
      })),
      pushed: pushed.synced,
      fetched: pulled.fetched,
      applied: pulled.applied,
      duplicates: pulled.duplicates,
      refusedEvents: pulled.refused.map((problem) => ({ reason: problem.reason })),
      waitingFor: pulled.waitingFor?.reason,
      outbox: pushed.counts,
    };
    // A pass that delivered some rows and then lost the network is still a transport failure:
    // it is the thing the backoff exists for, and calling it OK would hide a dead connection.
    return finish(transportError === undefined ? "OK" : "TRANSPORT_ERROR", result);
  } catch (error) {
    // The message is the transport's, already scrubbed of anything secret.
    const reason = error instanceof Error ? error.message : "The cloud could not be reached.";
    logger.log({
      module: "sync",
      severity: "ERROR",
      operation: "cloud-sync",
      deviceId,
      userId: actor?.id,
      message: `Cloud sync failed (${trigger}): ${reason}`,
    });
    return finish("TRANSPORT_ERROR", { reason });
  }
}
