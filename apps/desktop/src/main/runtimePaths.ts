import fs from "node:fs";
import path from "node:path";

// `node:sqlite` is loaded on demand: the main process is CommonJS, and Vite's resolver
// (used by the unit tests) does not recognise this newer built-in as a static import.
const loadSqlite = (): typeof import("node:sqlite") => require("node:sqlite");

// Where the desktop app keeps its data — the ONE place filesystem locations are decided.
//
// History: the database first lived in the repo (`apps/desktop/.runtime/electron`), then in
// the OS temp folder ("to avoid Windows ACL issues"). Temp is cleaned by the OS, so
// persistent ERP data now lives in the per-user application-data folder. Everything that
// is disposable (Chromium cache, print scratch files) stays in temp.
//
// This module has no Electron dependency so it can be unit-tested: main.ts feeds it the
// values it reads from `app`.

export const APP_DATA_FOLDER = "777-erp";
export const DATABASE_FILE_NAME = "erp.local.sqlite";
const SCHEMA_FILE_NAME = "local-schema.sql";
/**
 * Folder under the installed application's `resources` directory that carries the read-only
 * application resources (base schema + migrations). Written by electron-builder's
 * `extraResources` — see apps/desktop/electron-builder.yml.
 */
export const PACKAGED_RESOURCES_FOLDER = "erp-resources";
const LEGACY_TEMP_FOLDER = "erp-desktop-runtime";
const MIGRATION_MARKER = "data-migration.json";
/** Encrypted sign-in state, kept beside the database (see sessionStore.ts). */
export const SESSION_FILE_NAME = "session.bin";

/** Environment override for operators and tests: ERP_DATA_DIR=<folder>. */
export const DATA_DIR_ENV = "ERP_DATA_DIR";

export interface RuntimeEnvironment {
  platform: NodeJS.Platform;
  /** app.getPath("appData") — %APPDATA% on Windows. */
  appDataDir: string;
  /** process.env.LOCALAPPDATA on Windows (non-roaming; preferred for a multi-MB database). */
  localAppDataDir?: string;
  /** app.getPath("temp"). */
  tempDir: string;
  /** app.getAppPath() — used only to locate the legacy repo-local runtime folder and the schema file. */
  appPath: string;
  /** process.env[DATA_DIR_ENV]. */
  overrideDataDir?: string;
  /** app.isPackaged — decides where the schema and migrations are read from. */
  isPackaged?: boolean;
  /** process.resourcesPath — the installed application's `resources` folder (packaged only). */
  resourcesPath?: string;
}

export interface RuntimePaths {
  /** Persistent root: database, images, logs, backups, session store. Also Electron userData. */
  dataRoot: string;
  databaseFile: string;
  productImagesDir: string;
  /** Persistent delivery/builty proof photos, beside the product images. */
  deliveryProofsDir: string;
  logsDir: string;
  backupsDir: string;
  /** Chromium session (localStorage, IndexedDB) — persistent, under dataRoot. */
  sessionDataDir: string;
  /** Disposable Chromium disk cache. */
  cacheDir: string;
  /** Disposable scratch files (print-to-PDF HTML). */
  scratchDir: string;
  /** Read-only application resource: the base schema. */
  schemaFile: string;
  /** Read-only application resource: the folder of versioned `*.up.sql` migrations. */
  migrationsDir: string;
  /** Previous data roots, newest first, that a fresh install may inherit from. */
  legacyRoots: string[];
}

/**
 * Where the two read-only application resources live. These are part of the *application*,
 * never of the user's data: packaged they come out of `resources/erp-resources`, which
 * electron-builder fills from the repository; in development they are read straight out of
 * the working tree. The database itself is never here — it stays under `dataRoot`.
 */
function resolveAppResources(env: RuntimeEnvironment): { schemaFile: string; migrationsDir: string } {
  if (env.isPackaged) {
    // Packaged, appPath is `<install>/resources/app.asar`, so its parent is the resources folder.
    const resources = env.resourcesPath?.trim() || path.join(env.appPath, "..");
    const root = path.join(resources, PACKAGED_RESOURCES_FOLDER);
    return { schemaFile: path.join(root, SCHEMA_FILE_NAME), migrationsDir: path.join(root, "migrations", "sqlite") };
  }

  // Development: appPath is `<repo>/apps/desktop`.
  const repoRoot = path.resolve(env.appPath, "..", "..");
  return {
    schemaFile: path.join(repoRoot, "packages", "data", "src", SCHEMA_FILE_NAME),
    migrationsDir: path.join(repoRoot, "migrations", "sqlite"),
  };
}

/**
 * Running from source must never fall through to the real data folder.
 *
 * `resolveRuntimePaths` treats a missing, blank or whitespace ERP_DATA_DIR as "not set" and
 * quietly uses %LOCALAPPDATA%\777-erp — correct for an installed copy, and dangerous from a
 * checkout. A developer who forgets the variable, or sets it in a different terminal from the
 * one that launches, gets the factory's live database: opened, migrated to whatever the working
 * tree ships, and seeded with default roles, with nothing on screen to say so. That has already
 * happened once here.
 *
 * So a development launch has to say where its data goes. There is no default, because the only
 * available default is the one thing that must not be chosen.
 *
 * A PACKAGED application is untouched: it has no ERP_DATA_DIR and is supposed to use the real
 * folder.
 */
export function assertDevelopmentDataDir(env: RuntimeEnvironment): void {
  if (env.isPackaged === true) return;

  const given = env.overrideDataDir;
  const named = typeof given === "string" ? given.trim() : "";
  if (named === "") {
    throw new Error(
      `${DATA_DIR_ENV} is not set.\n\n` +
        "Running from source will not fall back to the installed data folder, because that is " +
        "the live business database. Set it to a disposable folder in the SAME terminal that " +
        `starts the app, for example:\n\n  $env:${DATA_DIR_ENV} = "C:\\erp-devtest"\n\n` +
        "A packaged installation does not need this."
    );
  }
  if (named.includes("\0")) {
    throw new Error(`${DATA_DIR_ENV} is not a usable path.`);
  }
  if (!path.isAbsolute(named)) {
    throw new Error(
      `${DATA_DIR_ENV} must be an absolute path, not "${named}".\n` +
        "A relative path is resolved against whatever directory the launcher happened to run in."
    );
  }

  // The one destination that is never acceptable from a checkout.
  const installed = path.resolve(
    path.join(env.platform === "win32" && env.localAppDataDir ? env.localAppDataDir : env.appDataDir, APP_DATA_FOLDER)
  );
  const chosen = path.resolve(named);
  const within = (child: string, parent: string): boolean => {
    const relative = path.relative(parent, child);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };
  if (within(chosen, installed)) {
    throw new Error(
      `${DATA_DIR_ENV} points at the installed data folder (${chosen}).\n` +
        "That is the live business database. Choose a disposable folder instead."
    );
  }
}

export function resolveRuntimePaths(env: RuntimeEnvironment): RuntimePaths {
  const base =
    env.overrideDataDir?.trim() ||
    path.join(env.platform === "win32" && env.localAppDataDir ? env.localAppDataDir : env.appDataDir, APP_DATA_FOLDER);
  const dataRoot = path.resolve(base);
  const disposableRoot = path.join(env.tempDir, `${APP_DATA_FOLDER}-cache`);
  const resources = resolveAppResources(env);

  return {
    dataRoot,
    databaseFile: path.join(dataRoot, DATABASE_FILE_NAME),
    productImagesDir: path.join(dataRoot, "product-images"),
    deliveryProofsDir: path.join(dataRoot, "delivery-proofs"),
    logsDir: path.join(dataRoot, "logs"),
    backupsDir: path.join(dataRoot, "backups"),
    sessionDataDir: path.join(dataRoot, "session"),
    cacheDir: path.join(disposableRoot, "chromium-cache"),
    scratchDir: path.join(disposableRoot, "scratch"),
    schemaFile: resources.schemaFile,
    migrationsDir: resources.migrationsDir,
    legacyRoots: [
      path.join(env.tempDir, LEGACY_TEMP_FOLDER),
      path.join(env.appPath, ".runtime", "electron"),
    ],
  };
}

/** One read-only application resource that should be present but is not. */
export interface MissingResource {
  /** Operator-facing name, e.g. "database schema". */
  label: string;
  path: string;
}

/**
 * Checks the read-only application resources before the database is opened. A missing file
 * here means the installation is incomplete — the application must say so and stop (see
 * main.ts), never open a window on a half-built database. Returns an empty array when both
 * resources are present.
 */
export function missingRuntimeResources(paths: RuntimePaths): MissingResource[] {
  const missing: MissingResource[] = [];
  if (!fs.existsSync(paths.schemaFile)) missing.push({ label: "database schema", path: paths.schemaFile });
  if (!fs.existsSync(paths.migrationsDir)) missing.push({ label: "migrations folder", path: paths.migrationsDir });
  return missing;
}

export function ensureRuntimeDirectories(paths: RuntimePaths): void {
  for (const dir of [paths.dataRoot, paths.productImagesDir, paths.deliveryProofsDir, paths.logsDir, paths.backupsDir, paths.sessionDataDir, paths.cacheDir, paths.scratchDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ─── One-time migration from a legacy location ──────────────────────────────

export type MigrationStatus =
  /** A database already exists in the new location; nothing to do. */
  | "ALREADY_PRESENT"
  /** No legacy data anywhere; the app starts with a fresh database. */
  | "FRESH_INSTALL"
  /** Legacy data was copied and verified. The legacy files are left untouched. */
  | "MIGRATED"
  /** Copying or verifying failed; the app keeps using the legacy database so no data is lost. */
  | "FAILED";

export interface MigrationReport {
  status: MigrationStatus;
  /** The database file the application must open. */
  databaseFile: string;
  legacyRoot?: string;
  copied: string[];
  error?: string;
}

/** The SQLite main file plus its WAL/SHM side files, which carry committed-but-uncheckpointed data. */
const databaseFileSet = (file: string): string[] => [file, `${file}-wal`, `${file}-shm`];

const findLegacyRoot = (paths: RuntimePaths): string | undefined =>
  paths.legacyRoots.find((root) => fs.existsSync(path.join(root, DATABASE_FILE_NAME)));

/**
 * The marker says this data root has been set up before (migrated from a legacy location,
 * or reset). While it is present a missing database means "start fresh", never "go and
 * fetch the legacy one again".
 */
const hasBeenSetUp = (paths: RuntimePaths): boolean => fs.existsSync(path.join(paths.dataRoot, MIGRATION_MARKER));

const copyIfExists = (from: string, to: string, copied: string[]): void => {
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true, errorOnExist: false, force: true });
  copied.push(to);
};

/** Opens the copied database read-only and runs SQLite's integrity check. */
const verifyDatabase = (file: string): string | null => {
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
    return row?.quick_check === "ok" ? null : `quick_check returned ${String(row?.quick_check ?? "nothing")}`;
  } finally {
    db.close();
  }
};

/**
 * Brings a previous installation's data into `paths.dataRoot`. Runs before the database is
 * opened. The legacy files are never modified or deleted — if anything goes wrong the app
 * continues on the legacy database and the report says so.
 */
export function migrateLegacyData(paths: RuntimePaths): MigrationReport {
  if (fs.existsSync(paths.databaseFile)) {
    return { status: "ALREADY_PRESENT", databaseFile: paths.databaseFile, copied: [] };
  }
  const legacyRoot = hasBeenSetUp(paths) ? undefined : findLegacyRoot(paths);
  if (!legacyRoot) {
    return { status: "FRESH_INSTALL", databaseFile: paths.databaseFile, copied: [] };
  }

  const copied: string[] = [];
  try {
    const sources = databaseFileSet(path.join(legacyRoot, DATABASE_FILE_NAME));
    const targets = databaseFileSet(paths.databaseFile);
    sources.forEach((source, index) => copyIfExists(source, targets[index], copied));

    const problem = verifyDatabase(paths.databaseFile);
    if (problem) throw new Error(`Copied database failed verification: ${problem}`);

    copyIfExists(path.join(legacyRoot, "product-images"), paths.productImagesDir, copied);
    copyIfExists(path.join(legacyRoot, "delivery-proofs"), paths.deliveryProofsDir, copied);
    copyIfExists(path.join(legacyRoot, "logs", "app.log"), path.join(paths.logsDir, "app.log"), copied);
    copyIfExists(path.join(legacyRoot, "backups"), paths.backupsDir, copied);

    fs.writeFileSync(
      path.join(paths.dataRoot, MIGRATION_MARKER),
      JSON.stringify({ migratedFrom: legacyRoot, migratedAt: new Date().toISOString(), copied }, null, 2),
      "utf8"
    );
    return { status: "MIGRATED", databaseFile: paths.databaseFile, legacyRoot, copied };
  } catch (error) {
    // Leave no half-copied database behind, then keep working on the legacy one.
    for (const file of databaseFileSet(paths.databaseFile)) fs.rmSync(file, { force: true });
    return {
      status: "FAILED",
      databaseFile: path.join(legacyRoot, DATABASE_FILE_NAME),
      legacyRoot,
      copied,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ─── Reset ──────────────────────────────────────────────────────────────────

/**
 * Wipes the local data so the next launch starts from nothing: the database (every table —
 * products, QR codes, gatepasses, bills, vouchers, ledgers, users, settings), the product
 * images and the saved sign-ins. Logs and backups are kept: the log records who reset, and
 * the backups are the way back. The marker is (re)written so the next launch does not
 * bring the legacy database back in. The caller must have closed the database first.
 */
export function resetLocalData(paths: RuntimePaths, requestedBy: string): void {
  for (const file of databaseFileSet(paths.databaseFile)) fs.rmSync(file, { force: true });
  fs.rmSync(paths.productImagesDir, { recursive: true, force: true });
  fs.mkdirSync(paths.productImagesDir, { recursive: true });
  fs.rmSync(paths.deliveryProofsDir, { recursive: true, force: true });
  fs.mkdirSync(paths.deliveryProofsDir, { recursive: true });
  fs.rmSync(path.join(paths.dataRoot, SESSION_FILE_NAME), { force: true });
  fs.writeFileSync(
    path.join(paths.dataRoot, MIGRATION_MARKER),
    JSON.stringify({ resetAt: new Date().toISOString(), resetBy: requestedBy }, null, 2),
    "utf8"
  );
}

/**
 * The paths the application must actually use after migration. On FAILED every persistent
 * location stays on the legacy root (database, images, logs, backups) so nothing is split
 * across two folders; disposable paths are unaffected.
 */
export function effectivePaths(paths: RuntimePaths, report: MigrationReport): RuntimePaths {
  if (report.status !== "FAILED" || !report.legacyRoot) return paths;
  const root = report.legacyRoot;
  return {
    ...paths,
    dataRoot: root,
    databaseFile: report.databaseFile,
    productImagesDir: path.join(root, "product-images"),
    deliveryProofsDir: path.join(root, "delivery-proofs"),
    logsDir: path.join(root, "logs"),
    backupsDir: path.join(root, "backups"),
    sessionDataDir: path.join(root, "session"),
  };
}
