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
import type { SyncPassResult } from "@erp/sync";
import { describeCloudSyncConfig, readCloudSyncConfig } from "./cloudConfig";
import { DeviceCredentialStore } from "./deviceCredentialStore";

export interface CloudSyncPassOutcome extends SyncPassResult {
  /** Carton identities and production events sent and acknowledged this pass. */
  pushed?: number;
  /** Events read from the cloud log. */
  fetched?: number;
  /** Of those, written here for the first time. */
  applied?: number;
  /** Of those, already present — the normal result of a repeat. */
  duplicates?: number;
  /** Events this computer can never apply, each with the reason. */
  refusedEvents?: Array<{ reason: string }>;
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

    const transport = new sync.SupabaseSyncTransport({
      url: settings.config.url,
      anonKey: settings.config.anonKey,
      auth,
    });

    const queueNow = () =>
      sync.outboxSummary(db.db, {
        pushableTypes: sync.SUPABASE_PUSHABLE_AGGREGATES,
        nowIso: new Date().toISOString(),
      }).counts;

    const claim = await transport.claimDevice({ deviceId, workstationId, appVersion: app.getVersion() });
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

    const drain = new sync.OutboxDrain(db.db, transport, {
      deviceId,
      aggregateTypes: sync.SUPABASE_PUSHABLE_AGGREGATES,
    });
    const pushed = await drain.runOnce();

    const pull = new sync.SyncPull(db.db, transport);
    const pulled = await pull.runOnce();

    logger.log({
      module: "sync",
      severity: "INFO",
      operation: "cloud-sync",
      deviceId,
      userId: actor?.id,
      message:
        `Cloud sync (${trigger}${actor ? ` by ${actor.username}` : ""}): sent ${String(pushed.synced)}, ` +
        `read ${String(pulled.fetched)}, applied ${String(pulled.applied)}, ` +
        `already here ${String(pulled.duplicates)}, refused ${String(pulled.refused.length)}`,
    });

    const transportError = pushed.transportError ?? pulled.transportError;
    const result = {
      reason: transportError,
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
