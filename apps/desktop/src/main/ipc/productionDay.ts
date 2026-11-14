// The Manual Production page and the Daily Production page (docs/48; data layer, database/manualProduction.ts and
// database/productionDays.ts).
//
//   saveManualProduction    the page's Save: several lines, for one machine or several, all recorded or none
//   completeProductionDay   "Complete today's production": marks today, once
//   getProductionDay        one day's production, per machine and together (Daily Production)
//   getProductionDayMark    whether a day is marked complete (Carton Stock's status box)
//   getManualProductionArticle  one article on one machine today: what the edit grid starts from
//   editManualProduction    that article's new figures: each changed one reversed and recorded again, all or none
//
// IPC handlers are registered per feature; every call is authorised through ctx.authorizer (see ../authorize.ts) and
// every channel name comes from shared/ipcChannels.ts.
//
// WHO. Saving and completing are production, behind the same Live Production permission as every other way of
// recording it, and written on the carton computer only (leaseChannels.ts). Reading a day is open to anyone signed
// in, like the Daily Production page it is for: it shows quantities, no rates and no money.
// Nothing the screen sends is trusted: who saved, and where the cartons are stocked, come from the session and this
// computer. The machine, product and quantity of every line are checked by the data layer inside its write lock.

import type { IpcMainInvokeEvent } from "electron";
// Lease-gated (leaseChannels.ts): saving moves the carton figure, and the mark travels under the same lease.
import { ipcMain } from "../leaseGuard";
import { IPC } from "../../shared/ipcChannels";
import type { IpcContext } from "./context";
import { MANUAL_PRODUCTION_MOST_LINES, PERMISSION, asRecord, asString } from "@erp/domain";
import { rejection } from "../authorize";
import { refusalReason } from "../writeRefusal";

/** What an operator is told. One place, for translation later (R21). */
export const PRODUCTION_DAY_MESSAGES = {
  SAVE_BUSY: "The production was not saved because another stock operation is in progress. Nothing was saved. Please try again.",
  NOT_SAVED: "The production could not be saved. Nothing was saved.",
  COMPLETE_BUSY: "The day was not completed because another stock operation is in progress. Please try again.",
  NOT_COMPLETED: "The day could not be completed. Nothing was changed.",
  NOT_LOADED: "This could not be loaded. Try again.",
  BAD_DAY: "Choose a valid day.",
  TOO_MANY: `Save at most ${String(MANUAL_PRODUCTION_MOST_LINES)} lines at a time.`,
  EDIT_BUSY: "The production was not changed because another stock operation is in progress. Nothing was changed. Please try again.",
  NOT_EDITED: "The production could not be changed. Nothing was changed.",
} as const;

/** An edit's boxes as sent, each read as text. More than the limit is refused before anything is read. */
const editCellsOf = (value: unknown) => {
  const cells = Array.isArray(value) ? value : [];
  if (cells.length > MANUAL_PRODUCTION_MOST_LINES) throw new Error(PRODUCTION_DAY_MESSAGES.TOO_MANY);
  return cells.map((cell) => {
    const fields = asRecord(cell);
    return { articleSizeId: asString(fields.articleSizeId), color: asString(fields.color), dozens: asString(fields.dozens) };
  });
};

/** The lines as sent, each field read as text. More than the limit is refused before anything is read. */
const linesOf = (value: unknown) => {
  const lines = Array.isArray(value) ? value : [];
  if (lines.length > MANUAL_PRODUCTION_MOST_LINES) throw new Error(PRODUCTION_DAY_MESSAGES.TOO_MANY);
  return lines.map((line) => {
    const fields = asRecord(line);
    return {
      requestId: asString(fields.requestId),
      machineId: asString(fields.machineId),
      articleSizeId: asString(fields.articleSizeId),
      color: asString(fields.color),
      dozens: asString(fields.dozens),
    };
  });
};

export function registerProductionDayHandlers(ctx: IpcContext): void {
  const { db, logger, authorizer, scanContext, deviceId } = ctx;

  const log = (severity: "INFO" | "WARNING" | "ERROR", operation: string, message: string, userId?: string) =>
    logger.log({ module: "production-day", severity, operation, deviceId, userId, message });

  const operator = (event: IpcMainInvokeEvent) => {
    try {
      return { ok: true as const, user: authorizer.requirePermission(event, PERMISSION.LIVE_PRODUCTION) };
    } catch (error) {
      return { ok: false as const, ...rejection(error, "Your account cannot record production.") };
    }
  };

  const anyone = (event: IpcMainInvokeEvent) => {
    try {
      return { ok: true as const, user: authorizer.requireUser(event) };
    } catch (error) {
      return { ok: false as const, ...rejection(error, "Sign in to see production.") };
    }
  };

  ipcMain.handle(IPC.saveManualProduction, (event, input?: unknown) => {
    const who = operator(event);
    if (!who.ok) return { accepted: false, reason: who.reason };
    try {
      const result = db.recordManualProductionBatch({
        lines: linesOf(asRecord(input).lines),
        // The store Store In credits on this computer: the same location a scanned carton goes to.
        storeLocationId: scanContext.factoryId,
        createdBy: who.user.username,
      });
      const cartons = result.entries.reduce((sum, entry) => sum + entry.cartons, 0);
      log("INFO", "save", JSON.stringify({ entries: result.entries.length, cartons, duplicates: result.duplicates }), who.user.id);
      return { accepted: true, entries: result.entries.length, cartons, duplicates: result.duplicates };
    } catch (error) {
      const reason = refusalReason(error, PRODUCTION_DAY_MESSAGES.SAVE_BUSY, PRODUCTION_DAY_MESSAGES.NOT_SAVED);
      log("WARNING", "save-refused", error instanceof Error ? error.message : String(error), who.user.id);
      return { accepted: false, reason };
    }
  });

  // EDITING TODAY'S PRODUCTION of one article on one machine (database/manualProductionEdit.ts): the figure it is
  // now, then the figure it should be. Each changed size and colour is reversed and recorded again, so stock and the
  // Contractor Ledger follow. Recording production, so the same permission and the same computer as Save.
  ipcMain.handle(IPC.getManualProductionArticle, (event, query?: unknown) => {
    const who = operator(event);
    if (!who.ok) return { accepted: false, reason: who.reason };
    const fields = asRecord(query);
    try {
      return { accepted: true, article: db.manualProductionArticleToday({ machineName: asString(fields.machineName), article: asString(fields.article) }) };
    } catch (error) {
      log("WARNING", "edit-read", error instanceof Error ? error.message : String(error), who.user.id);
      return { accepted: false, reason: refusalReason(error, PRODUCTION_DAY_MESSAGES.NOT_LOADED, PRODUCTION_DAY_MESSAGES.NOT_LOADED) };
    }
  });

  ipcMain.handle(IPC.editManualProduction, (event, input?: unknown) => {
    const who = operator(event);
    if (!who.ok) return { accepted: false, reason: who.reason };
    const fields = asRecord(input);
    try {
      const result = db.editManualProduction({
        requestId: asString(fields.requestId),
        machineId: asString(fields.machineId),
        article: asString(fields.article),
        cells: editCellsOf(fields.cells),
        // The store Store In credits on this computer, as for Save.
        storeLocationId: scanContext.factoryId,
        editedBy: who.user.username,
      });
      log("INFO", "edit", JSON.stringify({ article: asString(fields.article), changes: result.changes }), who.user.id);
      return { accepted: true, changes: result.changes };
    } catch (error) {
      const reason = refusalReason(error, PRODUCTION_DAY_MESSAGES.EDIT_BUSY, PRODUCTION_DAY_MESSAGES.NOT_EDITED);
      log("WARNING", "edit-refused", error instanceof Error ? error.message : String(error), who.user.id);
      return { accepted: false, reason };
    }
  });

  ipcMain.handle(IPC.completeProductionDay, (event) => {
    const who = operator(event);
    if (!who.ok) return { accepted: false, reason: who.reason };
    try {
      const result = db.completeProductionDay({ completedBy: who.user.username });
      log("INFO", "complete", JSON.stringify({ date: result.mark.date, cartons: result.mark.cartons, duplicate: result.duplicate }), who.user.id);
      return { accepted: true, mark: result.mark, duplicate: result.duplicate };
    } catch (error) {
      const reason = refusalReason(error, PRODUCTION_DAY_MESSAGES.COMPLETE_BUSY, PRODUCTION_DAY_MESSAGES.NOT_COMPLETED);
      log("WARNING", "complete-refused", error instanceof Error ? error.message : String(error), who.user.id);
      return { accepted: false, reason };
    }
  });

  ipcMain.handle(IPC.getProductionDay, (event, query?: unknown) => {
    const who = anyone(event);
    if (!who.ok) return { accepted: false, reason: who.reason };
    try {
      const day = db.productionDayView(asString(asRecord(query).date));
      return day ? { accepted: true, day } : { accepted: false, reason: PRODUCTION_DAY_MESSAGES.BAD_DAY };
    } catch (error) {
      log("WARNING", "day", error instanceof Error ? error.message : String(error));
      return { accepted: false, reason: PRODUCTION_DAY_MESSAGES.NOT_LOADED };
    }
  });

  ipcMain.handle(IPC.getProductionDayMark, (event, query?: unknown) => {
    const who = anyone(event);
    if (!who.ok) return { accepted: false, reason: who.reason };
    try {
      return { accepted: true, mark: db.productionDayMark(asString(asRecord(query).date)) };
    } catch (error) {
      log("WARNING", "mark", error instanceof Error ? error.message : String(error));
      return { accepted: false, reason: PRODUCTION_DAY_MESSAGES.NOT_LOADED };
    }
  });
}
