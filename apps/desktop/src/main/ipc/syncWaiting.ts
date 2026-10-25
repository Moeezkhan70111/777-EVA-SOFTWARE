// What this computer, and every other computer of the factory, is waiting on -- so a wait is never
// silent (docs/37, the stock-screen slice; owner decision 2026-10-25, points 3 to 5).
//
//   getSyncWaiting          this computer's waits, with their tiers and the material each leaves
//                           incomplete. Local SELECTs only. Every signed-in user: the stock screen
//                           marks its rows from it.
//   getFactorySyncHealth    every computer's last report (cloud migration 014), read through the
//                           pass's own signed-in transport. Administrators.
//   sendMasterRecordAgain   marks one master record so the next pass sends a new revision of it --
//                           the fix for a record another computer waits for and never received. A
//                           master-data write: leased (leaseChannels.ts), so only the holder may.

import { ipcMain } from "../leaseGuard";
import { IPC } from "../../shared/ipcChannels";
import type { IpcContext } from "./context";
import { rejection } from "../authorize";
import { readFactorySyncHealth } from "../cloudSyncPass";

/** "TYPE:id", as a wait names the record that would end it. */
const RECORD_KEY = /^([A-Z_]+):(.+)$/;

const SEND_AGAIN_REFUSED: Readonly<Record<string, string>> = {
  UNKNOWN_TYPE: "Only master data (materials, categories, units, parties, machines) can be sent again.",
  NOT_HERE: "This computer does not have that record, so it has nothing to send.",
  NO_LEASE: "This computer does not know the master-data lease yet. Sync once, then try again.",
};

/** Exactly what these handlers need, like DeadLetterContext. */
export interface SyncWaitingContext {
  db: Pick<IpcContext["db"], "db" | "markRecordToSendAgain">;
  logger: Pick<IpcContext["logger"], "log">;
  authorizer: Pick<IpcContext["authorizer"], "requireUser" | "requireAdmin">;
  deviceId: string;
}

export function registerSyncWaitingHandlers(ctx: SyncWaitingContext): void {
  const { db, logger, authorizer, deviceId } = ctx;

  ipcMain.handle(IPC.getSyncWaiting, async (event) => {
    try {
      authorizer.requireUser(event);
    } catch (error) {
      return rejection(error, "What this computer is waiting on could not be read.");
    }
    const sync = await import("@erp/sync");
    const summary = sync.waitingSummary(db.db, Date.now());
    // Whether the material a wait leaves incomplete is here at all: one that is not is missing
    // from the stock list entirely, so the stock screen lists it above the table.
    const material = db.db.prepare("SELECT 1 AS here FROM inventory_items WHERE id = ?");
    const entries = summary.entries.map((entry) => ({
      ...entry,
      itemHere: entry.itemId === null ? null : material.get(entry.itemId) !== undefined,
    }));
    return {
      accepted: true as const,
      value: {
        ...summary,
        entries,
        unsentMarks: sync.unsentMarkCount(db.db),
        deadLetters: sync.outboxCounts(db.db).DEAD_LETTER,
      },
    };
  });

  ipcMain.handle(IPC.getFactorySyncHealth, async (event) => {
    try {
      authorizer.requireAdmin(event);
    } catch (error) {
      return rejection(error, "The other computers' reports could not be read.");
    }
    try {
      const devices = await readFactorySyncHealth();
      if (devices === null) return { accepted: false as const, reason: "This computer has not reached the cloud yet. Sync once, then look again." };
      return { accepted: true as const, value: devices };
    } catch (error) {
      return rejection(error, "The other computers' reports could not be read.");
    }
  });

  ipcMain.handle(IPC.sendMasterRecordAgain, (event, recordKey?: unknown) => {
    let admin;
    try {
      admin = authorizer.requireAdmin(event);
    } catch (error) {
      return rejection(error, "The record could not be sent again.");
    }
    const match = typeof recordKey === "string" ? RECORD_KEY.exec(recordKey.trim()) : null;
    if (match === null) return { accepted: false as const, reason: "Choose the record to send again." };
    const [, type = "", recordId = ""] = match;

    const outcome = db.markRecordToSendAgain(type, recordId, new Date().toISOString());
    logger.log({
      module: "sync",
      severity: outcome === "MARKED" ? "WARNING" : "INFO",
      operation: "send-record-again",
      deviceId,
      userId: admin.id,
      message: `${admin.username} asked to send ${type} ${recordId} again: ${outcome}`,
    });
    if (outcome !== "MARKED") return { accepted: false as const, reason: SEND_AGAIN_REFUSED[outcome] ?? outcome };
    return { accepted: true as const };
  });
}
