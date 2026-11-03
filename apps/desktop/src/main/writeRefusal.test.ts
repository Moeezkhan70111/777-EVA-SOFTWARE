// @vitest-environment node
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { isDatabaseBusy, refusalReason } from "./writeRefusal";
import { MANUAL_PRODUCTION_MESSAGES } from "./ipc/manualProduction";

// The handler module registers with Electron's ipcMain through the lease guard; nothing here calls it.
vi.mock("electron", () => ({ ipcMain: { handle: () => undefined } }));

// A refused write is told in the operator's words: a real SQLite lock from a second connection, and a
// refusal the data layer wrote itself, which is passed on unchanged.

// Loaded at run time: the test bundler does not resolve Node's built-in sqlite module itself.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

/** The error SQLite really throws when another connection holds the write lock. */
function realLockError(): unknown {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-lock-"));
  const file = path.join(dir, "lock.db");
  const holder = new DatabaseSync(file);
  const other = new DatabaseSync(file);
  try {
    holder.exec("CREATE TABLE t (x INTEGER)");
    holder.exec("BEGIN IMMEDIATE");
    other.exec("BEGIN IMMEDIATE");
    return null;
  } catch (error) {
    return error;
  } finally {
    try { holder.exec("ROLLBACK"); } catch { /* nothing held */ }
    holder.close();
    other.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("a refused write, in the operator's words", () => {
  it("a database lock says nothing was saved and to try again, never SQLite's own words", () => {
    const error = realLockError();
    expect(error).toBeInstanceOf(Error);
    expect(isDatabaseBusy(error)).toBe(true);
    const reason = refusalReason(error, MANUAL_PRODUCTION_MESSAGES.STOCK_BUSY, MANUAL_PRODUCTION_MESSAGES.NOT_RECORDED);
    expect(reason).toBe("Production entry was not saved because another stock operation is in progress. Please try again.");
    expect(reason).not.toMatch(/database is locked/i);
  });

  it("a refusal the data layer wrote is passed on as it is", () => {
    const error = new Error("SK6 7/10 RED is disabled in Product Master. Re-enable it before recording production.");
    expect(isDatabaseBusy(error)).toBe(false);
    expect(refusalReason(error, MANUAL_PRODUCTION_MESSAGES.STOCK_BUSY, MANUAL_PRODUCTION_MESSAGES.NOT_RECORDED)).toBe(error.message);
    expect(refusalReason("not an error", MANUAL_PRODUCTION_MESSAGES.STOCK_BUSY, MANUAL_PRODUCTION_MESSAGES.NOT_RECORDED)).toBe(
      MANUAL_PRODUCTION_MESSAGES.NOT_RECORDED
    );
  });
});
