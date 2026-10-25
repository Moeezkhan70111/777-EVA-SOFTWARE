import { app, BrowserWindow, net } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { SqliteDatabase, StructuredLogger } from "@erp/data";
import {
  DATA_DIR_ENV,
  effectivePaths,
  assertDevelopmentDataDir,
  ensureRuntimeDirectories,
  migrateLegacyData,
  missingRuntimeResources,
  resolveRuntimePaths,
  type MigrationReport,
  type RuntimePaths,
} from "./main/runtimePaths";
import { reportFatalStartupError, type StartupFailure } from "./main/startupFailure";
import { describeInstallation, resolveInstallation } from "./main/deviceIdentity";
import { DeviceCredentialStore } from "./main/deviceCredentialStore";
import { describeBuildInfo, readBuildInfo } from "./main/buildInfo";
import { createIpcContext, registerIpcHandlers } from "./main/ipc";
import type { UseCases } from "./main/ipc/context";
// updater.ts defers `electron-updater` itself (loadElectronUpdater), so importing this module
// costs a development run nothing.
import {
  LAST_UPDATE_SUCCESS_SETTING,
  UPDATE_TOKEN_ENV,
  UpdateService,
  loadElectronUpdater,
  type AutoUpdaterPort,
} from "./main/updater";
import { isCloudSyncConfigured, runCloudSyncPass } from "./main/cloudSyncPass";
import type { SyncScheduler } from "@erp/sync";

// Electron main process: filesystem locations, application-service composition, IPC
// registration and window lifecycle. The IPC handlers themselves live under ./main/ipc,
// one module per feature; authorisation is in ./main/authorize.ts.

// ─── Filesystem locations ─────────────────────────────────────────────────────
// All paths come from main/runtimePaths.ts (persistent data in the per-user app-data folder,
// disposable caches in temp, read-only schema/migrations from the application's own resources).
// A previous installation's data in the old temp/repo location is copied and verified once, and
// never deleted, before the database is opened.
//
// This runs at import time because Electron requires the cache switches and
// disableHardwareAcceleration() before the app is ready. Anything that goes wrong is kept in
// `startupFailure` and reported from whenReady(), where a dialog can actually be shown.

interface Bootstrap {
  paths: RuntimePaths;
  dataMigration: MigrationReport;
}

function bootstrapFilesystem(): Bootstrap {
  const environment = {
    platform: process.platform,
    appDataDir: app.getPath("appData"),
    localAppDataDir: process.env.LOCALAPPDATA,
    tempDir: app.getPath("temp"),
    appPath: app.getAppPath(),
    overrideDataDir: process.env[DATA_DIR_ENV],
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  };

  // FIRST, before any folder is created, any legacy data is copied, or any database is opened:
  // a launch from source must name its own data folder rather than inherit the live one.
  assertDevelopmentDataDir(environment);

  const resolvedPaths = resolveRuntimePaths(environment);
  ensureRuntimeDirectories(resolvedPaths);
  const dataMigration = migrateLegacyData(resolvedPaths);
  const paths = effectivePaths(resolvedPaths, dataMigration);
  ensureRuntimeDirectories(paths);

  app.setPath("userData", paths.dataRoot);
  app.setPath("sessionData", paths.sessionDataDir);
  app.commandLine.appendSwitch("disk-cache-dir", paths.cacheDir);
  app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
  app.commandLine.appendSwitch("disable-http-cache");
  app.disableHardwareAcceleration();

  return { paths, dataMigration };
}

let bootstrap: Bootstrap | null = null;
let startupFailure: StartupFailure | null = null;
try {
  bootstrap = bootstrapFilesystem();
} catch (error) {
  startupFailure = { stage: "filesystem-locations", error };
}

// One running instance per data folder: two processes on the same WAL database is how
// local ERP data gets corrupted. A second launch just focuses the existing window.
const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) {
  app.quit();
}

interface DesktopServices {
  db: SqliteDatabase;
  logger: StructuredLogger;
  useCases: UseCases;
  /** Null when automatic updates could not be arranged on this computer. */
  updates: UpdateService | null;
  /** Null when this computer has no background sync loop. */
  syncScheduler: SyncScheduler | null;
}

/**
 * The private repository the Windows installers are published to.
 *
 * Here rather than in electron-builder.yml's publish block because the token that goes with it
 * must NOT be baked into the installer: the owner/repo are not secret, the credential is, and it
 * is read per machine from ERP_UPDATE_TOKEN at runtime. See main/updater.ts.
 */
const RELEASE_REPOSITORY = { owner: "Moeezkhan70111", repo: "777-EVA-SOFTWARE" } as const;

/**
 * Starts the update service, or returns null with the reason logged.
 *
 * NEVER THROWS. An ERP that refuses to open because it could not reach GitHub would be a far
 * worse failure than an ERP running last month's build.
 */
async function startUpdateService(
  logger: StructuredLogger,
  deviceId: string,
  db: SqliteDatabase
): Promise<UpdateService | null> {
  try {
    const token = process.env[UPDATE_TOKEN_ENV];
    // In development electron-updater is never even loaded: it reads app-update.yml at import
    // time, which a source run does not have.
    const service = new UpdateService({
      logger,
      deviceId,
      currentVersion: app.getVersion(),
      isPackaged: app.isPackaged,
      token,
      repository: RELEASE_REPOSITORY,
      updater: app.isPackaged ? await loadElectronUpdater() : stubUpdater(),
      // SURVIVES A RESTART, which is the whole point: a failure count would reset every morning
      // and could never show that this computer has not updated for a fortnight.
      history: {
        readLastSuccessAt: () => db.getSettings()[LAST_UPDATE_SUCCESS_SETTING] ?? null,
        writeLastSuccessAt: (iso) => db.setSettings({ [LAST_UPDATE_SUCCESS_SETTING]: iso }, "updater"),
      },
      removeStagedDownload: () => removeStagedDownload(logger, deviceId),
    });
    service.start();
    return service;
  } catch (error) {
    logger.log({
      module: "update",
      severity: "WARNING",
      operation: "auto-update",
      deviceId,
      message: "Automatic updates are not available on this computer. 777 ERP is unaffected and will keep running this version.",
      errorDetails: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

// ─── Background cloud sync ────────────────────────────────────────────────────

/** How long after launch the first sync pass waits, so it never competes with the first scan. */
const SYNC_STARTUP_DELAY_MS = 120_000;
/** Then every five minutes: often enough that three computers feel current to each other. */
const SYNC_INTERVAL_MS = 5 * 60 * 1000;
/**
 * After a transport failure, doubling to the cap.
 *
 * THE CAP IS DELIBERATELY LOW — sixty seconds, not ten minutes — and that is because of what
 * `net.isOnline()` can and cannot tell us. See the comment on the connectivity poll below: in
 * the factory's most likely outage (the LAN is fine, the internet is not) the machine never
 * looks offline, so the offline-to-online transition never happens and the RECONNECT trigger
 * never fires. Recovery then depends entirely on the next backoff slot.
 *
 * A ten-minute cap meant up to ten minutes of three computers not seeing each other's work
 * after the internet came back, with nothing on screen to explain the wait. A sixty-second cap
 * bounds that at a minute, and the thing it is retrying costs one HTTP request that fails fast.
 * Retrying a dead WAN once a minute is not load worth optimising away.
 */
const SYNC_MIN_BACKOFF_MS = 15_000;
const SYNC_MAX_BACKOFF_MS = 60_000;
/**
 * How often Chromium's online/offline state is read.
 *
 * Twenty seconds: fast enough that a reconnection is noticed while somebody is still standing
 * there, cheap enough to ignore — it is a synchronous read of a flag, and the scheduler does
 * nothing at all unless the answer has changed from offline to online.
 */
const CONNECTIVITY_POLL_MS = 20_000;
/**
 * How often the queue is checked for something new to send (push on save).
 *
 * One second, plus the scheduler's own short bundling delay, puts new work in the cloud within a
 * few seconds instead of at the next five-minute pass. Each check is one local SELECT; it never
 * touches the network, and a save never waits for it.
 */
const OUTBOX_WATCH_MS = 1_000;

/**
 * Starts the background sync loop, or returns null with the reason logged.
 *
 * NEVER THROWS, for the same reason startUpdateService does not: local work must not depend on
 * the cloud being reachable, or even on this code being correct.
 *
 * The scheduler itself is in @erp/sync and knows nothing about Electron, Supabase or the ERP —
 * it is given a function that runs one pass. That function is main/cloudSyncPass.ts, which is
 * also what the Sync Now button calls.
 */
async function startSyncScheduler(deps: {
  db: SqliteDatabase;
  logger: StructuredLogger;
  paths: RuntimePaths;
  scanContext: { workstationId: string; deviceId: string };
}): Promise<SyncScheduler | null> {
  const { db, logger, paths, scanContext } = deps;
  try {
    const sync = await import("@erp/sync");
    const passDeps = {
      db,
      logger,
      deviceId: scanContext.deviceId,
      workstationId: scanContext.workstationId,
      dataRoot: paths.dataRoot,
    };

    const scheduler = new sync.SyncScheduler({
      runPass: (trigger) => runCloudSyncPass(passDeps, trigger),
      // Asked before every pass rather than cached: a computer provisioned at lunchtime must
      // start syncing without a restart.
      isConfigured: () => isCloudSyncConfigured({ deviceId: scanContext.deviceId, dataRoot: paths.dataRoot }),
      // Chromium's own view, used ONLY as a negative signal.
      //
      // Electron's own documentation is explicit that a `true` here is inconclusive: it means
      // some link is up, not that any particular remote host can be reached. A `false` is the
      // reliable half — no interface at all, so a pass would certainly fail.
      //
      // So this saves pointless passes when the cable is out or wifi is off, and says nothing
      // useful when the LAN is up and the internet is down. The pass itself is the only real
      // test of reachability, which is why the backoff cap above is what actually bounds
      // recovery time.
      isOnline: () => net.isOnline(),
      startupDelayMs: SYNC_STARTUP_DELAY_MS,
      intervalMs: SYNC_INTERVAL_MS,
      minBackoffMs: SYNC_MIN_BACKOFF_MS,
      maxBackoffMs: SYNC_MAX_BACKOFF_MS,
      setTimer: (handler, ms) => setTimeout(handler, ms),
      clearTimer: (timer) => clearTimeout(timer),
    });

    scheduler.start();

    // THE MOMENT A WAITING QUEUE CAN DRAIN. The office internet is unreliable, so a computer
    // that has been offline for an hour must not sit out the rest of its backoff once the
    // connection returns.
    //
    // POLLED, because Electron's main process has no connectivity event — `online`/`offline`
    // are renderer (DOM) events, and routing them through IPC would make the background loop
    // depend on a window being open. `net.isOnline()` is a cheap synchronous read of
    // Chromium's own state.
    //
    // WHAT THIS DOES NOT CATCH, stated plainly: the LAN up / WAN down case. The interface stays
    // up, so `isOnline()` stays true, so there is no offline-to-online transition and this
    // trigger never fires for the outage the factory is most likely to have. It catches the
    // cable-unplugged and wifi-off cases, which are real but rarer.
    //
    // A reachability probe against the Supabase host would catch both — and is deliberately not
    // here, because the low backoff cap already bounds recovery at a minute and a probe is a
    // second network path to maintain for the same outcome. Revisit if a minute proves too long.
    const connectivityTimer = setInterval(() => scheduler.connectivityChanged(), CONNECTIVITY_POLL_MS);
    // Let the process exit without waiting for this timer.
    connectivityTimer.unref?.();

    // PUSH ON SAVE. Anything queued is sent within seconds rather than at the next timer pass.
    // Watched here rather than called from each write path, so every path that queues is covered
    // and the data layer knows nothing of the scheduler. A save never waits for this: it reads
    // what the save has already written, and the pass it may start runs in the background.
    let newestSeen = sync.newestSendableRow(db.db, sync.SUPABASE_PUSHABLE_AGGREGATES);
    const outboxWatch = setInterval(() => {
      try {
        const newest = sync.newestSendableRow(db.db, sync.SUPABASE_PUSHABLE_AGGREGATES);
        if (newest > newestSeen) scheduler.nudge();
        // Lowered too, when sent rows leave the count, so the next new row is still noticed.
        newestSeen = newest;
      } catch {
        // A check that cannot read the queue skips one beat; the timer pass still carries the row.
      }
    }, OUTBOX_WATCH_MS);
    outboxWatch.unref?.();

    logger.log({
      module: "sync",
      severity: "INFO",
      operation: "sync-scheduler",
      deviceId: scanContext.deviceId,
      message: `Background cloud sync is on: first pass in ${String(Math.round(SYNC_STARTUP_DELAY_MS / 1000))}s, then every ${String(Math.round(SYNC_INTERVAL_MS / 60000))} minutes, and within seconds of anything new being queued.`,
    });
    return scheduler;
  } catch (error) {
    logger.log({
      module: "sync",
      severity: "WARNING",
      operation: "sync-scheduler",
      deviceId: scanContext.deviceId,
      message: "Background cloud sync could not be started. 777 ERP works normally; nothing will be exchanged with the other computers until this is fixed.",
      errorDetails: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Deletes the installer electron-updater has already staged, so it cannot install on quit.
 *
 * The folder is electron-updater's own, named by `updaterCacheDirName` in the packaged
 * app-update.yml (`@erpdesktop-updater`). Only the staged download lives there — no business
 * data — and electron-updater recreates it as needed, so removing it is safe.
 *
 * Never throws: discarding an update is a convenience, and failing it must not take anything
 * else down. The caller reports the outcome.
 */
function removeStagedDownload(logger: StructuredLogger, deviceId: string): void {
  // %LOCALAPPDATA%, the same source bootstrapFilesystem reads. Electron's getPath has no name
  // for it, and app.setPath("userData") has already been pointed at the ERP data folder, so
  // neither would find electron-updater's cache.
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return;
  const pending = path.join(localAppData, "@erpdesktop-updater", "pending");
  try {
    fs.rmSync(pending, { recursive: true, force: true });
  } catch (error) {
    logger.log({
      module: "update",
      severity: "WARNING",
      operation: "discard-update",
      deviceId,
      message: `The staged update folder could not be removed (${pending}).`,
      errorDetails: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Stands in for electron-updater in a development run, where it cannot work at all.
 *
 * UpdateService reports DISABLED before touching it, so nothing here is ever called — it exists
 * so a source run does not have to load the real module to construct the service.
 */
function stubUpdater(): AutoUpdaterPort {
  return {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    setFeedURL: () => undefined,
    checkForUpdates: () => Promise.resolve(undefined),
    quitAndInstall: () => undefined,
    on: () => undefined,
  };
}

const servicesPromise = bootstrap
  ? initializeServices(bootstrap)
  : Promise.reject<DesktopServices>(startupFailure?.error ?? new Error("The application could not determine where to store its data."));
// whenReady() awaits the same promise and reports the failure there; this only stops an early
// rejection from being treated as an unhandled one first.
servicesPromise.catch(() => undefined);

/**
 * The schema and the migrations ship with the application. If either is missing the installation
 * is incomplete, and the ERP must say so rather than open a window over a half-built database.
 */
function assertResourcesPresent(paths: RuntimePaths): void {
  const missing = missingRuntimeResources(paths);
  if (missing.length === 0) return;
  const described = missing.map((resource) => `${resource.label} (${resource.path})`).join(", ");
  throw new Error(`The installation is incomplete — missing ${described}.`);
}

async function initializeServices({ paths, dataMigration }: Bootstrap): Promise<DesktopServices> {
  assertResourcesPresent(paths);

  const dataModule = await import("@erp/data");
  const applicationModule = await import("@erp/application");

  const db = new dataModule.SqliteDatabase({
    dbPath: paths.databaseFile,
    schemaPath: paths.schemaFile,
    migrationsDir: paths.migrationsDir,
  });
  const logger = new dataModule.StructuredLogger(paths.logsDir);

  // ELECTRON HAS TO BE READY BEFORE THE CREDENTIAL CAN BE READ.
  //
  // safeStorage is only usable once the app is ready; asked earlier it reports that encryption
  // is unavailable, whatever the machine. This function starts at module scope so the slow part
  // — opening the database and running its migrations — overlaps Electron's own startup, and
  // that is worth keeping. But everything below needs the answer safeStorage gives, and asking
  // too early turned every installation into "there is a credential here this computer cannot
  // read" when the truth was "there is no credential". Worse, that reading REFUSES adoption, so
  // a machine whose identity file was missing would have minted a fresh identity rather than
  // keeping the one its own history refers to — a wrong outcome caused purely by call timing.
  //
  // No deadlock: whenReady() resolves on Electron's schedule, and the handler that awaits this
  // promise runs after it. Nothing above this line moves, so the database is still opened early.
  await app.whenReady();

  // Who this machine is. Decided once per installation and then stable — an existing database
  // keeps the workstation its own history already refers to. See main/deviceIdentity.ts.
  //
  // The credential is READ, never written: it is the one artefact a copied data folder cannot
  // use, so it is what decides whether this installation may adopt the workstation a database
  // already names. With no credential anywhere — which is every installation until provisioning
  // exists — this behaves exactly as it did before: the identity file wins, and a database
  // alone is never adopted on trust.
  const credentials = new DeviceCredentialStore(paths.dataRoot);
  const installation = resolveInstallation({
    dataRoot: paths.dataRoot,
    findExistingWorkstation: () => db.findExistingWorkstation(),
    credential: () => credentials.credentialState(),
  });
  const identity = installation.identity;

  // THE BACKUP TAKEN BEFORE THIS BUILD MIGRATED THE DATABASE, if it migrated one at all.
  //
  // Logged first among the startup facts because it is the only one that matters retroactively:
  // if an upgrade turns out to have been wrong, this line is where the way back is named. On an
  // ordinary launch nothing was pending and there is nothing to say.
  const safetyCopy = db.preMigrationBackup;
  if (safetyCopy !== null) {
    logger.log({
      module: "runtime",
      severity: safetyCopy.recorded ? "INFO" : "WARNING",
      operation: "database-backup",
      deviceId: identity.deviceId,
      message: JSON.stringify({
        backupPath: safetyCopy.backupPath,
        fromVersion: safetyCopy.fromVersion,
        toVersion: safetyCopy.toVersion,
        migrationsApplied: safetyCopy.pending,
        listedInSettings: safetyCopy.recorded,
      }),
      errorDetails: safetyCopy.recordError,
    });
  }

  logger.log({
    module: "runtime",
    severity: dataMigration.status === "FAILED" ? "CRITICAL" : "INFO",
    operation: "data-location",
    deviceId: identity.deviceId,
    message: JSON.stringify({ status: dataMigration.status, dataRoot: paths.dataRoot, legacyRoot: dataMigration.legacyRoot ?? null, copied: dataMigration.copied.length }),
    errorDetails: dataMigration.error,
  });

  // Which computer this installation believes it is, and whether the cloud would accept it as
  // that. Five non-secret facts — see describeInstallation, which exists to keep it that way.
  logger.log({
    module: "runtime",
    severity: installation.enrolment.enrolled ? "INFO" : "WARNING",
    operation: "device-identity",
    deviceId: identity.deviceId,
    message: JSON.stringify(describeInstallation(installation, credentials.canPersist())),
  });

  // Which code this machine is running, in the log from the first line onward: a support call
  // starts with "what is installed?", and a version alone could not answer it.
  const build = readBuildInfo();
  logger.log({
    module: "runtime",
    severity: build.dirty === true || build.commit === null ? "WARNING" : "INFO",
    operation: "build-provenance",
    deviceId: identity.deviceId,
    message: describeBuildInfo(build),
  });

  db.ensureOperationalContext({ ...identity, appVersion: app.getVersion() });

  const useCases = composeUseCases(db, dataModule, applicationModule);
  const scanContext = {
    factoryId: identity.factoryId,
    workstationId: identity.workstationId,
    deviceId: identity.deviceId,
  };

  // AUTOMATIC UPDATES. Arranged last, and allowed to fail: a computer that cannot update is a
  // computer that runs the version it has. Nothing above this line depends on it, and the window
  // opens either way — so every failure here is logged and swallowed, never thrown.
  const updates = await startUpdateService(logger, identity.deviceId, db);

  // THE BACKGROUND SYNC LOOP. Allowed to be absent for exactly the same reason updates are: an
  // ERP that will not open because it cannot reach Supabase would be a far worse failure than
  // three computers whose events are a few minutes apart.
  const syncScheduler = await startSyncScheduler({ db, logger, paths, scanContext });

  registerIpcHandlers(
    createIpcContext({
      db, logger, scanContext, paths, dbPath: paths.databaseFile, dataMigration, useCases, updates, syncScheduler,
    })
  );

  return { db, logger, useCases, updates, syncScheduler };
}

type DataModule = typeof import("@erp/data");
type ApplicationModule = typeof import("@erp/application");

/** Wires every application use case to the one SqliteDatabase that implements its ports. */
function composeUseCases(db: SqliteDatabase, dataModule: DataModule, applicationModule: ApplicationModule): UseCases {
  const eventPublisher = () => new applicationModule.InMemoryEventBus();
  const idGenerator = () => new dataModule.UuidGenerator();
  const machineProgramStoreOutUseCases = () => {
    const deps = { txManager: db, repo: db, eventPublisher: eventPublisher(), idGenerator: idGenerator() };
    return {
      open: new applicationModule.OpenMachineProgramForStoreOutUseCase(deps),
      checkScan: new applicationModule.CheckMachineProgramScanUseCase(deps),
      saveBatch: new applicationModule.SaveMachineProgramBatchUseCase(deps),
    };
  };
  const machineProgramUseCases = () => {
    const deps = { txManager: db, repo: db, eventPublisher: eventPublisher(), idGenerator: idGenerator() };
    return {
      assignContractor: new applicationModule.AssignMachineContractorUseCase(deps),
      addMachine: new applicationModule.AddMachineUseCase(deps),
      saveLine: new applicationModule.SaveMachineProgramLineUseCase(deps),
      saveRun: new applicationModule.SaveMachineProgramRunUseCase(deps),
      saveFixRun: new applicationModule.SaveMachineProgramFixRunUseCase(deps),
      removeLine: new applicationModule.RemoveMachineProgramLineUseCase(deps),
      removeRun: new applicationModule.RemoveMachineProgramRunUseCase(deps),
      deleteProgram: new applicationModule.DeleteMachineProgramUseCase(deps),
      setShift: new applicationModule.SetMachineProgramShiftUseCase(deps),
      setSoleSlot: new applicationModule.SetMachineProgramSoleSlotUseCase(deps),
      saveArticleRates: new applicationModule.SaveMachineProgramArticleRatesUseCase(deps),
    };
  };

  return {
    processScanUseCase: new applicationModule.ProcessScanUseCase({
      txManager: db,
      duplicateChecker: db,
      qrRegistry: db,
      productCatalog: db,
      qrMasterRepo: db,
      productionEventsRepo: db,
      stockProjectionRepo: db,
      outboxRepo: db,
      eventPublisher: eventPublisher(),
      idGenerator: idGenerator(),
    }),
    // Receive Production (Phase 2): the same production step, for generated carton QRs only.
    receiveProductionUseCase: new applicationModule.ReceiveProductionUseCase({
      txManager: db,
      duplicateChecker: db,
      qrRegistry: db,
      productCatalog: db,
      qrMasterRepo: db,
      productionEventsRepo: db,
      stockProjectionRepo: db,
      outboxRepo: db,
      eventPublisher: eventPublisher(),
      idGenerator: idGenerator(),
    }),
    dispatchScanUseCase: new applicationModule.DispatchScanUseCase({
      txManager: db,
      qrLookupRepo: db,
      stockProjectionRepo: db,
      qrMasterRepo: db,
      dispatchEventsRepo: db,
      outboxRepo: db,
      eventPublisher: eventPublisher(),
      idGenerator: idGenerator(),
      dispatchSessionRepo: db,
      // Gatepass-locked dispatch: the document supplies the allow-list (it knows the colour,
      // which the bill does not) while the attribution stays bill-keyed (gatepassRepo is the same db).
      gatepassRepo: db,
    }),
    // Carton returns: the party is read from the carton's own dispatch (attributionRepo) and
    // credited through sale_returns. Deliberately NO stockProjectionRepo — recording a return
    // must not move stock; the ordinary Store Move In below does that when the carton arrives.
    returnScanUseCase: new applicationModule.ReturnScanUseCase({
      txManager: db,
      qrLookupRepo: db,
      attributionRepo: db,
      qrMasterRepo: db,
      saleReturnsRepo: db,
      returnEventsRepo: db,
      outboxRepo: db,
      eventPublisher: eventPublisher(),
      idGenerator: idGenerator(),
    }),
    // Raw Material Input: its own scanner, its own registry, its own stock. Deliberately
    // not the carton store screens — a packet and a carton never share a scanner.
    receiveRawMaterialScanUseCase: new applicationModule.ReceiveRawMaterialScanUseCase({
      txManager: db,
      repo: db,
      eventPublisher: eventPublisher(),
      idGenerator: idGenerator(),
    }),
    // Raw Material Output: the mirror of Input. Where a packet goes is read from its
    // material, so the operator only scans.
    issueRawMaterialScanUseCase: new applicationModule.IssueRawMaterialScanUseCase({
      txManager: db,
      repo: db,
      eventPublisher: eventPublisher(),
      idGenerator: idGenerator(),
    }),
    // Upper Move Out (Phase 3): the same packet issue, uppers only, to a named machine.
    upperMoveOutUseCase: new applicationModule.UpperMoveOutUseCase({
      txManager: db,
      repo: db,
      eventPublisher: eventPublisher(),
      idGenerator: idGenerator(),
    }),
    // Store Scanning: same repositories, same event log — one more lifecycle consumer.
    storeEntryScanUseCase: new applicationModule.StoreEntryScanUseCase({
      txManager: db,
      qrLookupRepo: db,
      gatepassRepo: db,
      qrRegistry: db,
      qrMasterRepo: db,
      storeEntryEventsRepo: db,
      stockProjectionRepo: db,
      outboxRepo: db,
      eventPublisher: eventPublisher(),
      idGenerator: idGenerator(),
    }),
    // Store Move Out: the store's exit step — In Store → To Gate, ready to be dispatched. With a
    // Gatepass selected it consumes that document's reservation (gatepassRepo is the same db).
    storeExitScanUseCase: new applicationModule.StoreExitScanUseCase({
      txManager: db,
      qrLookupRepo: db,
      gatepassRepo: db,
      qrRegistry: db,
      qrMasterRepo: db,
      storeExitEventsRepo: db,
      stockProjectionRepo: db,
      outboxRepo: db,
      eventPublisher: eventPublisher(),
      idGenerator: idGenerator(),
    }),
    // Gatepass: a document cut against store stock. Same transaction manager and repository,
    // but it touches none of the QR / event / stock tables the scanners above own.
    createGatepassUseCase: new applicationModule.CreateGatepassUseCase({ txManager: db, repo: db, idGenerator: idGenerator() }),
    cancelGatepassUseCase: new applicationModule.CancelGatepassUseCase({ txManager: db, repo: db, idGenerator: idGenerator() }),
    // Machine Program: a reservation against raw material store stock, for one machine on one
    // date. Like the Gatepass above it writes only its own tables — the uppers leave the store
    // through the Raw Material Output scanner, which is where the reservation is consumed.
    machineProgram: machineProgramUseCases(),
    // Store Out working through ONE open Machine Program. Same repository, and the packets still
    // leave through issueRawMaterialPacket — the one function that debits raw material stock —
    // so this adds a way of choosing which allocation is kept, never a second deduction path.
    machineProgramStoreOut: machineProgramStoreOutUseCases(),
    // Store In receiving the cartons a program sent back. It runs the production step and the
    // Store Move In step above — the same functions, in one transaction — never a third path.
    machineProgramCartonIn: new applicationModule.ReceiveMachineProgramCartonUseCase({
      txManager: db,
      duplicateChecker: db,
      qrRegistry: db,
      productCatalog: db,
      qrMasterRepo: db,
      productionEventsRepo: db,
      stockProjectionRepo: db,
      outboxRepo: db,
      qrLookupRepo: db,
      gatepassRepo: db,
      storeEntryEventsRepo: db,
      cartonOriginRepo: db,
      eventPublisher: eventPublisher(),
      idGenerator: idGenerator(),
    }),
    // Return Upper in a program's reconciliation: the same packet receipt Raw Material Input
    // runs, with the program's checks in place of the supplier session's.
    machineProgramUpperReturn: new applicationModule.ReturnMachineProgramUpperUseCase({
      txManager: db,
      repo: db,
      eventPublisher: eventPublisher(),
      idGenerator: idGenerator(),
    }),
  };
}

// ─── Window lifecycle ─────────────────────────────────────────────────────────

const createWindow = (): void => {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const rendererPath = path.join(app.getAppPath(), "src", "renderer", "index.html");
  mainWindow.loadFile(rendererPath);
};

app.on("second-instance", () => {
  const [existing] = BrowserWindow.getAllWindows();
  if (!existing) return;
  if (existing.isMinimized()) existing.restore();
  existing.focus();
});

// The window opens only once every service is up, so the renderer can never call an IPC channel
// that has no handler registered behind it. A failure here is fatal and reported, never logged
// and walked past.
app.whenReady().then(async () => {
  if (!hasInstanceLock) return;

  try {
    if (startupFailure) throw startupFailure.error;
    await servicesPromise;
  } catch (error) {
    reportFatalStartupError({ stage: startupFailure?.stage ?? "database", error }, bootstrap?.paths.logsDir);
    return;
  }

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", async () => {
  // A startup failure already exited; there is no database handle to close in that case.
  const services = await servicesPromise.catch(() => null);
  // Before the database: a check firing into a closing process has nothing useful to do, and an
  // update that lands here installs on quit through electron-updater, not through this timer.
  services?.updates?.stop();
  // Before the database closes: a pass firing into a closing connection would fail for a reason
  // that has nothing to do with the cloud, and record it as though it did.
  services?.syncScheduler?.stop();
  services?.db.close();
});
