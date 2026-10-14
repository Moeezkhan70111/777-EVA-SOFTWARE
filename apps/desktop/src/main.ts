import { app, BrowserWindow } from "electron";
import path from "node:path";
import type { SqliteDatabase, StructuredLogger } from "@erp/data";
import {
  DATA_DIR_ENV,
  effectivePaths,
  ensureRuntimeDirectories,
  migrateLegacyData,
  missingRuntimeResources,
  resolveRuntimePaths,
  type MigrationReport,
  type RuntimePaths,
} from "./main/runtimePaths";
import { reportFatalStartupError, type StartupFailure } from "./main/startupFailure";
import { resolveDeviceIdentity } from "./main/deviceIdentity";
import { createIpcContext, registerIpcHandlers } from "./main/ipc";
import type { UseCases } from "./main/ipc/context";

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
  const resolvedPaths = resolveRuntimePaths({
    platform: process.platform,
    appDataDir: app.getPath("appData"),
    localAppDataDir: process.env.LOCALAPPDATA,
    tempDir: app.getPath("temp"),
    appPath: app.getAppPath(),
    overrideDataDir: process.env[DATA_DIR_ENV],
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  });
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

  // Who this machine is. Decided once per installation and then stable — an existing database
  // keeps the workstation its own history already refers to. See main/deviceIdentity.ts.
  const identity = resolveDeviceIdentity({
    dataRoot: paths.dataRoot,
    findExistingWorkstation: () => db.findExistingWorkstation(),
  });

  logger.log({
    module: "runtime",
    severity: dataMigration.status === "FAILED" ? "CRITICAL" : "INFO",
    operation: "data-location",
    deviceId: identity.deviceId,
    message: JSON.stringify({ status: dataMigration.status, dataRoot: paths.dataRoot, legacyRoot: dataMigration.legacyRoot ?? null, copied: dataMigration.copied.length }),
    errorDetails: dataMigration.error,
  });

  db.ensureOperationalContext({ ...identity, appVersion: app.getVersion() });

  const useCases = composeUseCases(db, dataModule, applicationModule);
  const scanContext = {
    factoryId: identity.factoryId,
    workstationId: identity.workstationId,
    deviceId: identity.deviceId,
  };

  registerIpcHandlers(
    createIpcContext({ db, logger, scanContext, paths, dbPath: paths.databaseFile, dataMigration, useCases })
  );

  return { db, logger, useCases };
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
  services?.db.close();
});
