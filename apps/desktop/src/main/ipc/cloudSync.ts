// Running one cloud sync pass, by hand.
//
// There is NO BACKGROUND LOOP. Nothing syncs on launch, on a timer, or after a scan. A pass only
// happens when an administrator asks for one, and only on a computer whose four environment
// variables are set. An installation without them is the local-only ERP it is today, and nothing
// about its behaviour changes.
//
// That is deliberate for a first slice: a sync that starts itself would be writing to a shared
// project before anyone has watched it work on two computers once.
//
// WHAT A PASS DOES
//
//   sign in   as this computer's device account, holding the token in memory only
//   push      carton identities (QR_MASTER) from the local outbox, oldest first
//   pull      everything in the cloud log after this computer's cursor, and apply it
//
// Only QR_MASTER is pushed. The drain is told to claim nothing else, so a PRODUCTION_PRODUCED
// event sits in the outbox as PENDING and is neither sent, refused, nor parked.
//
// WHAT THE RENDERER GETS BACK: counts and, when something went wrong, the service's own reason.
// Never a token, never the key, never the password.

import { app, ipcMain } from "electron";
import { IPC } from "../../shared/ipcChannels";
import type { IpcContext } from "./context";
import { rejection } from "../authorize";
import { describeCloudSyncConfig, readCloudSyncConfig } from "../cloudConfig";
import { DeviceCredentialStore } from "../deviceCredentialStore";

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
  /** Events this computer can never apply, each with the reason. */
  refused?: Array<{ reason: string }>;
  /** Waiting on something that has not arrived yet, if the pass stopped early. */
  waitingFor?: string;
  /** Queue state afterwards, so an operator can see what is still unsent. */
  outbox?: Record<string, number>;
}

/** One pass at a time. A second request while one is running is refused rather than queued. */
let running = false;

export function registerCloudSyncHandlers(ctx: IpcContext): void {
  const { db, logger, authorizer, deviceId, scanContext } = ctx;
  // THIS COMPUTER'S CLOUD CREDENTIAL, encrypted against the signed-in Windows user by
  // Electron's safeStorage. See main/deviceCredentialStore.ts for why this and not a file the
  // application writes itself: it is the one artefact a copied data folder cannot use.
  //
  // Reading it is what makes a restart resume without the password; writing it is what makes the
  // password a first-run input rather than a permanent setting.
  const credentials = new DeviceCredentialStore(ctx.paths.dataRoot);

  // WHAT THIS COMPUTER'S SYNC SITUATION IS. Read-only in every sense: pure SELECTs against the
  // local queue, no network, no pass started, nothing in the outbox touched.
  //
  // The queue is reported twice over, because one view is not enough. By STATUS, which is what
  // the Health page has always shown. And by SENDABILITY, because four of the six aggregate
  // types have no transport yet: without that split, "14 pending" cannot tell an operator
  // whether anything would actually move.
  //
  // The two timestamps are read off rows that exist, never manufactured. lastSyncedAt is when a
  // row was last SENT, not when a pass last ran -- a pass that pushed nothing leaves no trace,
  // and this does not pretend otherwise. There is no last-attempt timestamp anywhere to report.
  //
  // @erp/sync is loaded here too, so a computer that never syncs still loads it to look at its
  // own queue. That is the price of the split, and it is a few kilobytes of pure JavaScript with
  // no side effects at import.
  ipcMain.handle(IPC.getCloudSyncStatus, async (event) => {
    authorizer.requireUser(event);
    const sync = await import("@erp/sync");
    const deferral = sync.readPullDeferral(db.db);
    return {
      // Asked with the same credential question a pass asks, so the panel cannot call this
      // computer unconfigured while a pass would in fact run: once a credential is stored here,
      // the device password is genuinely no longer needed.
      ...describeCloudSyncConfig(
        readCloudSyncConfig(process.env, { hasStoredCredential: credentials.matchesDevice(deviceId) })
      ),
      running,
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

    // The stored credential decides whether a password is still required at all.
    const stored = credentials.load();
    const usable = stored !== null && stored.deviceId === deviceId;
    const settings = readCloudSyncConfig(process.env, { hasStoredCredential: usable });
    if (!settings.configured) {
      return { accepted: false, reason: `This computer is not set up for cloud sync: ${settings.problems.join("; ")}` };
    }
    if (running) return { accepted: false, reason: "A cloud sync is already running on this computer." };

    running = true;
    try {
      // Loaded here rather than at startup: a computer that never syncs never loads it, exactly
      // as main.ts already loads @erp/data on demand.
      const sync = await import("@erp/sync");
      // The refresh token travels in the config, never the credential file's own shape: the auth
      // layer knows nothing about safeStorage, and the store knows nothing about Supabase.
      const auth = new sync.SupabaseDeviceAuth(
        { ...settings.config, refreshToken: usable ? stored.refreshToken : undefined },
        () => Date.now(),
        (session) => {
          // FIRST-RUN PROVISIONING, and every rotation after it. A refresh token that cannot be
          // stored must not fail the pass -- the sync itself is fine, and the cost is only that
          // the next start needs the password again -- so the outcome is logged, never thrown.
          const outcome = credentials.save({
            authUserId: session.userId ?? stored?.authUserId ?? "",
            deviceId,
            refreshToken: session.refreshToken,
            provisionedAt: new Date().toISOString(),
          });
          if (outcome !== "SAVED") {
            logger.log({
              module: "sync",
              severity: "WARNING",
              operation: "device-credential",
              deviceId,
              message: `This computer's cloud credential was not stored (${outcome}). Sync is unaffected; the device password will be needed again after a restart.`,
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

      // THE CLAIM COMES FIRST, AND NOTHING IS TOUCHED UNTIL IT SUCCEEDS.
      //
      // Migration 006 binds this account to one device and one workstation and hands back an
      // epoch that every write must present; a second computer claiming the same enrolment
      // evicts this one. The claim happens BEFORE the drain exists because a drain reclaims
      // stale rows and leases a batch the moment it runs -- both of which mutate the outbox.
      // A device that may not write must not have its queue disturbed for finding out.
      const claim = await transport.claimDevice({
        deviceId,
        workstationId: scanContext.workstationId,
        appVersion: app.getVersion(),
      });
      if (!claim.ok) {
        logger.log({
          module: "sync",
          severity: "WARNING",
          operation: "cloud-sync",
          deviceId,
          userId: admin.id,
          message: `Cloud sync refused for ${admin.username}: the cloud did not accept this computer (${claim.reason})`,
        });
        return {
          accepted: false,
          reason: `The cloud did not accept this computer: ${claim.reason}. Nothing was sent, and nothing in the queue changed.`,
          outbox: sync.outboxSummary(db.db, {
            pushableTypes: sync.SUPABASE_PUSHABLE_AGGREGATES,
            nowIso: new Date().toISOString(),
          }).counts,
        };
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
        userId: admin.id,
        message:
          `Cloud sync by ${admin.username}: sent ${String(pushed.synced)}, ` +
          `read ${String(pulled.fetched)}, applied ${String(pulled.applied)}, ` +
          `already here ${String(pulled.duplicates)}, refused ${String(pulled.refused.length)}`,
      });

      const failure = pushed.transportError ?? pulled.transportError;
      return {
        accepted: failure === undefined,
        reason: failure,
        pushed: pushed.synced,
        fetched: pulled.fetched,
        applied: pulled.applied,
        duplicates: pulled.duplicates,
        refused: pulled.refused.map((problem) => ({ reason: problem.reason })),
        waitingFor: pulled.waitingFor?.reason,
        outbox: pushed.counts,
      };
    } catch (error) {
      // The message is the transport's, already scrubbed of anything secret.
      const reason = error instanceof Error ? error.message : "The cloud could not be reached.";
      logger.log({
        module: "sync",
        severity: "ERROR",
        operation: "cloud-sync",
        deviceId,
        userId: admin.id,
        message: `Cloud sync failed: ${reason}`,
      });
      return { accepted: false, reason };
    } finally {
      running = false;
    }
  });
}
