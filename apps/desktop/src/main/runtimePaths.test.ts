// @vitest-environment node
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Vite's resolver does not know the `node:sqlite` built-in; load it through Node directly.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
import {
  APP_DATA_FOLDER,
  assertDevelopmentDataDir,
  DATABASE_FILE_NAME,
  PACKAGED_RESOURCES_FOLDER,
  SESSION_FILE_NAME,
  effectivePaths,
  migrateLegacyData,
  missingRuntimeResources,
  resetLocalData,
  resolveRuntimePaths,
  type RuntimeEnvironment,
} from "./runtimePaths";

const makeEnv = (root: string, overrides: Partial<RuntimeEnvironment> = {}): RuntimeEnvironment => ({
  platform: "win32",
  appDataDir: path.join(root, "Roaming"),
  localAppDataDir: path.join(root, "Local"),
  tempDir: path.join(root, "Temp"),
  appPath: path.join(root, "app", "apps", "desktop"),
  ...overrides,
});

/** A real, tiny SQLite database with one recognisable row. */
const writeDatabase = (file: string, marker: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE marker (value TEXT NOT NULL)");
  db.prepare("INSERT INTO marker (value) VALUES (?)").run(marker);
  db.close();
};

const readMarker = (file: string): string => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare("SELECT value FROM marker").get() as { value: string }).value;
  } finally {
    db.close();
  }
};

describe("assertDevelopmentDataDir", () => {
  // Running from source must never inherit the live data folder. resolveRuntimePaths treats a
  // missing or blank ERP_DATA_DIR as "not set" and quietly uses %LOCALAPPDATA%\777-erp, which
  // from a checkout means opening, migrating and seeding the factory's real database with
  // nothing on screen to say so. It has happened once here, which is why this guard exists.

  const DEV = { isPackaged: false };

  it("refuses a development launch that did not say where its data goes", () => {
    for (const missing of [undefined, "", "   ", "\t\n"]) {
      expect(
        () => assertDevelopmentDataDir(makeEnv("C:\\u", { ...DEV, overrideDataDir: missing })),
        `overrideDataDir ${JSON.stringify(missing)} must be refused`
      ).toThrow(/ERP_DATA_DIR is not set/);
    }
  });

  it("names the variable and shows how to set it, so the message is actionable", () => {
    let message = "";
    try {
      assertDevelopmentDataDir(makeEnv("C:\\u", DEV));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("ERP_DATA_DIR");
    expect(message).toContain("live business database");
    expect(message).toContain("$env:ERP_DATA_DIR");
  });

  it("refuses a path that is not usable or not absolute", () => {
    expect(() => assertDevelopmentDataDir(makeEnv("C:\\u", { ...DEV, overrideDataDir: "erp-devtest" }))).toThrow(
      /must be an absolute path/
    );
    expect(() => assertDevelopmentDataDir(makeEnv("C:\\u", { ...DEV, overrideDataDir: ".\\data" }))).toThrow(
      /must be an absolute path/
    );
    expect(() => assertDevelopmentDataDir(makeEnv("C:\\u", { ...DEV, overrideDataDir: "C:\\bad\0dir" }))).toThrow(
      /not a usable path/
    );
  });

  it("refuses the installed data folder itself, and anything inside it", () => {
    const installed = path.join("C:\\u", "Local", APP_DATA_FOLDER);
    for (const target of [installed, path.join(installed, "sub"), `${installed}\\`]) {
      expect(
        () => assertDevelopmentDataDir(makeEnv("C:\\u", { ...DEV, overrideDataDir: target })),
        `${target} must be refused`
      ).toThrow(/points at the installed data folder/);
    }
  });

  it("accepts a disposable folder, including one that merely looks similar", () => {
    for (const target of ["C:\\erp-devtest", "C:\\u\\Local\\777-erp-copy", "D:\\scratch\\erp"]) {
      expect(
        () => assertDevelopmentDataDir(makeEnv("C:\\u", { ...DEV, overrideDataDir: target })),
        `${target} should be accepted`
      ).not.toThrow();
    }
  });

  it("leaves a packaged installation alone — it is SUPPOSED to use the real folder", () => {
    expect(() => assertDevelopmentDataDir(makeEnv("C:\\u", { isPackaged: true }))).not.toThrow();
    expect(() =>
      assertDevelopmentDataDir(makeEnv("C:\\u", { isPackaged: true, overrideDataDir: "" }))
    ).not.toThrow();
  });
});

describe("resolveRuntimePaths", () => {
  it("uses the non-roaming local app-data folder on Windows and keeps disposable files in temp", () => {
    const paths = resolveRuntimePaths(makeEnv("C:\\u"));
    expect(paths.dataRoot).toBe(path.resolve("C:\\u\\Local", APP_DATA_FOLDER));
    expect(paths.databaseFile).toBe(path.join(paths.dataRoot, DATABASE_FILE_NAME));
    expect(paths.backupsDir).toBe(path.join(paths.dataRoot, "backups"));
    expect(paths.sessionDataDir).toBe(path.join(paths.dataRoot, "session"));
    expect(paths.cacheDir.startsWith(path.join("C:\\u\\Temp", `${APP_DATA_FOLDER}-cache`))).toBe(true);
    expect(paths.scratchDir.startsWith(path.join("C:\\u\\Temp", `${APP_DATA_FOLDER}-cache`))).toBe(true);
  });

  it("falls back to appData when there is no local app-data folder (other platforms)", () => {
    const paths = resolveRuntimePaths(makeEnv("/home/u", { platform: "linux", localAppDataDir: undefined }));
    expect(paths.dataRoot).toBe(path.resolve("/home/u/Roaming", APP_DATA_FOLDER));
  });

  it("honours the ERP_DATA_DIR override", () => {
    const paths = resolveRuntimePaths(makeEnv("C:\\u", { overrideDataDir: "D:\\erp-data" }));
    expect(paths.dataRoot).toBe(path.resolve("D:\\erp-data"));
  });

  it("knows both legacy locations, temp first", () => {
    const paths = resolveRuntimePaths(makeEnv("C:\\u"));
    expect(paths.legacyRoots[0]).toBe(path.join("C:\\u\\Temp", "erp-desktop-runtime"));
    expect(paths.legacyRoots[1]).toBe(path.join("C:\\u\\app\\apps\\desktop", ".runtime", "electron"));
  });
});

describe("read-only application resources", () => {
  it("reads the schema and migrations out of the repository in development", () => {
    const paths = resolveRuntimePaths(makeEnv("C:\\u"));
    expect(paths.schemaFile).toBe(path.join("C:\\u\\app", "packages", "data", "src", "local-schema.sql"));
    expect(paths.migrationsDir).toBe(path.join("C:\\u\\app", "migrations", "sqlite"));
  });

  it("reads them from the installed resources folder when packaged", () => {
    const paths = resolveRuntimePaths(
      makeEnv("C:\\u", {
        isPackaged: true,
        appPath: "C:\\Program Files\\777 ERP\\resources\\app.asar",
        resourcesPath: "C:\\Program Files\\777 ERP\\resources",
      })
    );
    const resources = path.join("C:\\Program Files\\777 ERP\\resources", PACKAGED_RESOURCES_FOLDER);
    expect(paths.schemaFile).toBe(path.join(resources, "local-schema.sql"));
    expect(paths.migrationsDir).toBe(path.join(resources, "migrations", "sqlite"));
  });

  it("falls back to the asar's parent folder when resourcesPath is not supplied", () => {
    const paths = resolveRuntimePaths(
      makeEnv("C:\\u", { isPackaged: true, appPath: "C:\\app\\resources\\app.asar", resourcesPath: undefined })
    );
    expect(paths.schemaFile).toBe(path.join("C:\\app\\resources", PACKAGED_RESOURCES_FOLDER, "local-schema.sql"));
  });

  it("keeps the database out of the resources folder — it stays under the data root", () => {
    const paths = resolveRuntimePaths(
      makeEnv("C:\\u", { isPackaged: true, resourcesPath: "C:\\Program Files\\777 ERP\\resources" })
    );
    expect(paths.databaseFile).toBe(path.join("C:\\u\\Local", APP_DATA_FOLDER, DATABASE_FILE_NAME));
    expect(paths.databaseFile.includes(PACKAGED_RESOURCES_FOLDER)).toBe(false);
  });

  it("reports both resources as missing when nothing is installed, and none when both are there", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "erp-resources-"));
    try {
      const paths = resolveRuntimePaths(makeEnv("C:\\u", { isPackaged: true, resourcesPath: root }));
      expect(missingRuntimeResources(paths).map((item) => item.label)).toEqual(["database schema", "migrations folder"]);

      fs.mkdirSync(paths.migrationsDir, { recursive: true });
      fs.writeFileSync(paths.schemaFile, "-- schema");
      expect(missingRuntimeResources(paths)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("migrateLegacyData", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "erp-paths-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("is a fresh install when no legacy data exists", () => {
    const paths = resolveRuntimePaths(makeEnv(root));
    const report = migrateLegacyData(paths);
    expect(report.status).toBe("FRESH_INSTALL");
    expect(report.databaseFile).toBe(paths.databaseFile);
  });

  it("copies the legacy database, side files, images, log and backups, verifies the copy, and leaves the legacy files untouched", () => {
    const paths = resolveRuntimePaths(makeEnv(root));
    const legacy = paths.legacyRoots[0];
    writeDatabase(path.join(legacy, DATABASE_FILE_NAME), "legacy-data");
    fs.writeFileSync(path.join(legacy, `${DATABASE_FILE_NAME}-wal`), "");
    fs.mkdirSync(path.join(legacy, "product-images"), { recursive: true });
    fs.writeFileSync(path.join(legacy, "product-images", "SK6.png"), "png");
    fs.mkdirSync(path.join(legacy, "logs"), { recursive: true });
    fs.writeFileSync(path.join(legacy, "logs", "app.log"), "{}\n");
    fs.mkdirSync(path.join(legacy, "backups"), { recursive: true });
    fs.writeFileSync(path.join(legacy, "backups", "b1.sqlite"), "backup");

    const report = migrateLegacyData(paths);

    expect(report.status).toBe("MIGRATED");
    expect(report.legacyRoot).toBe(legacy);
    expect(readMarker(paths.databaseFile)).toBe("legacy-data");
    expect(fs.existsSync(`${paths.databaseFile}-wal`)).toBe(true);
    expect(fs.existsSync(path.join(paths.productImagesDir, "SK6.png"))).toBe(true);
    expect(fs.existsSync(path.join(paths.logsDir, "app.log"))).toBe(true);
    expect(fs.existsSync(path.join(paths.backupsDir, "b1.sqlite"))).toBe(true);
    expect(fs.existsSync(path.join(paths.dataRoot, "data-migration.json"))).toBe(true);
    // Legacy data is preserved, never moved or deleted.
    expect(readMarker(path.join(legacy, DATABASE_FILE_NAME))).toBe("legacy-data");
    expect(fs.existsSync(path.join(legacy, "product-images", "SK6.png"))).toBe(true);
  });

  it("does nothing once a database exists in the new location", () => {
    const paths = resolveRuntimePaths(makeEnv(root));
    writeDatabase(paths.databaseFile, "current");
    writeDatabase(path.join(paths.legacyRoots[0], DATABASE_FILE_NAME), "older");
    const report = migrateLegacyData(paths);
    expect(report.status).toBe("ALREADY_PRESENT");
    expect(readMarker(paths.databaseFile)).toBe("current");
  });

  it("prefers the newer temp location over the repo-local one", () => {
    const paths = resolveRuntimePaths(makeEnv(root));
    writeDatabase(path.join(paths.legacyRoots[0], DATABASE_FILE_NAME), "from-temp");
    writeDatabase(path.join(paths.legacyRoots[1], DATABASE_FILE_NAME), "from-repo");
    const report = migrateLegacyData(paths);
    expect(report.status).toBe("MIGRATED");
    expect(readMarker(paths.databaseFile)).toBe("from-temp");
  });

  it("after a reset the next launch starts fresh instead of bringing the legacy database back", () => {
    const paths = resolveRuntimePaths(makeEnv(root));
    writeDatabase(path.join(paths.legacyRoots[0], DATABASE_FILE_NAME), "legacy-data");
    expect(migrateLegacyData(paths).status).toBe("MIGRATED");

    resetLocalData(paths, "admin");

    // The legacy database is still there, but the reset root must not inherit it again.
    const relaunch = migrateLegacyData(paths);
    expect(relaunch.status).toBe("FRESH_INSTALL");
    expect(fs.existsSync(paths.databaseFile)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(paths.dataRoot, "data-migration.json"), "utf8"))).toMatchObject({ resetBy: "admin" });
  });

  it("keeps using the legacy database when the copy does not verify", () => {
    const paths = resolveRuntimePaths(makeEnv(root));
    const legacyDb = path.join(paths.legacyRoots[0], DATABASE_FILE_NAME);
    fs.mkdirSync(path.dirname(legacyDb), { recursive: true });
    fs.writeFileSync(legacyDb, "this is not a sqlite file");

    const report = migrateLegacyData(paths);

    expect(report.status).toBe("FAILED");
    expect(report.databaseFile).toBe(legacyDb);
    expect(fs.existsSync(paths.databaseFile)).toBe(false);
    const active = effectivePaths(paths, report);
    expect(active.dataRoot).toBe(paths.legacyRoots[0]);
    expect(active.productImagesDir).toBe(path.join(paths.legacyRoots[0], "product-images"));
    expect(active.cacheDir).toBe(paths.cacheDir);
  });
});

describe("resetLocalData", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "erp-reset-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("removes the database with its side files, the product images and the saved sign-ins, and keeps logs and backups", () => {
    const paths = resolveRuntimePaths(makeEnv(root));
    writeDatabase(paths.databaseFile, "everything");
    fs.writeFileSync(`${paths.databaseFile}-wal`, "");
    fs.writeFileSync(`${paths.databaseFile}-shm`, "");
    fs.mkdirSync(paths.productImagesDir, { recursive: true });
    fs.writeFileSync(path.join(paths.productImagesDir, "SK6.png"), "png");
    fs.writeFileSync(path.join(paths.dataRoot, SESSION_FILE_NAME), "encrypted");
    fs.mkdirSync(paths.logsDir, { recursive: true });
    fs.writeFileSync(path.join(paths.logsDir, "app.log"), "{}\n");
    fs.mkdirSync(paths.backupsDir, { recursive: true });
    fs.writeFileSync(path.join(paths.backupsDir, "b1.sqlite"), "backup");

    resetLocalData(paths, "admin");

    expect(fs.existsSync(paths.databaseFile)).toBe(false);
    expect(fs.existsSync(`${paths.databaseFile}-wal`)).toBe(false);
    expect(fs.existsSync(`${paths.databaseFile}-shm`)).toBe(false);
    expect(fs.readdirSync(paths.productImagesDir)).toEqual([]);
    expect(fs.existsSync(path.join(paths.dataRoot, SESSION_FILE_NAME))).toBe(false);
    expect(fs.existsSync(path.join(paths.logsDir, "app.log"))).toBe(true);
    expect(fs.existsSync(path.join(paths.backupsDir, "b1.sqlite"))).toBe(true);
  });
});
