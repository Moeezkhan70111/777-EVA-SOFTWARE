// Manual Production: cartons recorded by typing them in, with no carton QR — they go on the
// machine's program for today, into store stock and onto the contractors' ledgers (data layer,
// database/manualProduction.ts).
//
// IPC handlers are registered per feature; every call is authorised through ctx.authorizer
// (see ../authorize.ts) and every channel name comes from shared/ipcChannels.ts.
//
// Production is production whichever screen records it, so this sits behind the same Live Production
// permission as Receive Production. Hiding the tab is not authorisation: each call checks again.
// Nothing the screen sends is trusted — the machine, the product and the quantity are all checked
// by the data layer inside the write lock.

import type { IpcMainInvokeEvent } from "electron";
// Lease-gated (leaseChannels.ts): recording and voiding move the carton figure, written on one computer only.
import { ipcMain } from "../leaseGuard";
import { IPC } from "../../shared/ipcChannels";
import type { IpcContext } from "./context";
import { CARTON_STOCK_MOST_SHOWN, CARTON_STOCK_PAGE_SIZE, PERMISSION, USER_ROLE, asRecord, asString } from "@erp/domain";
import { rejection } from "../authorize";
import { refusalReason } from "../writeRefusal";

/** What an operator is told. One place, for translation later (R21). */
export const MANUAL_PRODUCTION_MESSAGES = {
  STOCK_BUSY: "Production entry was not saved because another stock operation is in progress. Please try again.",
  VOID_BUSY: "The entry was not voided because another stock operation is in progress. Nothing was changed. Please try again.",
  NOT_RECORDED: "The production could not be recorded. Nothing was saved.",
  NOT_VOIDED: "The entry could not be voided. Nothing was changed.",
  ADJUST_BUSY: "The adjustment was not saved because another stock operation is in progress. Nothing was changed. Please try again.",
  NOT_ADJUSTED: "The adjustment could not be saved. Nothing was changed.",
} as const;

export function registerManualProductionHandlers(ctx: IpcContext): void {
  const { db, logger, authorizer, scanContext, deviceId } = ctx;

  const log = (severity: "INFO" | "WARNING" | "ERROR", operation: string, message: string, userId?: string) =>
    logger.log({ module: "manual-production", severity, operation, deviceId, userId, message });

  const operator = (event: IpcMainInvokeEvent) => {
    try {
      return { ok: true as const, user: authorizer.requirePermission(event, PERMISSION.LIVE_PRODUCTION) };
    } catch (error) {
      return { ok: false as const, ...rejection(error, "Your account cannot record production.") };
    }
  };

  ipcMain.handle(IPC.recordManualProduction, (event, input?: unknown) => {
    const who = operator(event);
    if (!who.ok) return { accepted: false, reason: who.reason, entry: null };
    const fields = asRecord(input);
    try {
      const result = db.recordManualProduction({
        requestId: asString(fields.requestId),
        machineId: asString(fields.machineId),
        articleSizeId: asString(fields.articleSizeId),
        color: asString(fields.color),
        dozens: asString(fields.dozens),
        // The store Store In credits on this computer — the same location a scanned carton goes to.
        storeLocationId: scanContext.factoryId,
        createdBy: who.user.username,
      });
      log("INFO", "record", JSON.stringify({ entry: result.entry.code, cartons: result.entry.cartons, duplicate: result.duplicate }), who.user.id);
      return { accepted: true, entry: result.entry, duplicate: result.duplicate };
    } catch (error) {
      // A refusal (bad quantity, disabled product, machine not ready) is the data layer's own words; a
      // database lock is said plainly. The original error is logged as it came, for diagnosis.
      const reason = refusalReason(error, MANUAL_PRODUCTION_MESSAGES.STOCK_BUSY, MANUAL_PRODUCTION_MESSAGES.NOT_RECORDED);
      log("WARNING", "record-refused", error instanceof Error ? error.message : String(error), who.user.id);
      return { accepted: false, reason, entry: null };
    }
  });

  // A void, never a delete (docs/42 section 5): the entry stays, marked, and its cartons leave stock on
  // every computer. The reason is required by the data layer, and logged with who voided it.
  // WHO: the production operator voids TODAY's entries; only an administrator voids an earlier day's.
  // The person's role is read here from their session, never from the screen; the business day is
  // decided by the data layer inside the write lock.
  ipcMain.handle(IPC.voidManualProduction, (event, input?: unknown) => {
    const who = operator(event);
    if (!who.ok) return { accepted: false, reason: who.reason, entry: null };
    const fields = asRecord(input);
    try {
      const entry = db.voidManualProduction({
        entryId: asString(fields.entryId),
        reason: asString(fields.reason),
        voidedBy: who.user.username,
        mayVoidEarlierDays: who.user.role === USER_ROLE.ADMIN,
      });
      log("INFO", "void", JSON.stringify({ entry: entry.code, cartons: entry.cartons, reason: entry.voidReason }), who.user.id);
      return { accepted: true, entry };
    } catch (error) {
      const reason = refusalReason(error, MANUAL_PRODUCTION_MESSAGES.VOID_BUSY, MANUAL_PRODUCTION_MESSAGES.NOT_VOIDED);
      log("WARNING", "void-refused", error instanceof Error ? error.message : String(error), who.user.id);
      return { accepted: false, reason, entry: null };
    }
  });

  // AN ADMINISTRATOR ONLY, from the session, whatever the screen sends: the figure moves on every computer.
  // Who made it and the reason travel with the movement (docs/42 section 11).
  const administrator = (event: IpcMainInvokeEvent) => {
    try {
      return { ok: true as const, user: authorizer.requireAdmin(event) };
    } catch (error) {
      return { ok: false as const, ...rejection(error, "Only an administrator can do this.") };
    }
  };

  ipcMain.handle(IPC.adjustCartonStock, (event, input?: unknown) => {
    const who = administrator(event);
    if (!who.ok) return { accepted: false, reason: who.reason };
    const fields = asRecord(input);
    try {
      const result = db.adjustCartonStock({
        requestId: asString(fields.requestId),
        articleSizeId: asString(fields.articleSizeId),
        color: asString(fields.color),
        direction: asString(fields.direction),
        cartons: Number(fields.cartons),
        reason: asString(fields.reason),
        adjustedBy: who.user.username,
        storeLocationId: scanContext.factoryId,
      });
      log("INFO", "adjust", JSON.stringify({ event: result.eventId, type: result.eventType, cartons: result.cartons, duplicate: result.duplicate, reason: asString(fields.reason) }), who.user.id);
      return { accepted: true, duplicate: result.duplicate };
    } catch (error) {
      const reason = refusalReason(error, MANUAL_PRODUCTION_MESSAGES.ADJUST_BUSY, MANUAL_PRODUCTION_MESSAGES.NOT_ADJUSTED);
      log("WARNING", "adjust-refused", error instanceof Error ? error.message : String(error), who.user.id);
      return { accepted: false, reason };
    }
  });

  // The Carton Stock page's matrix. Administrators only, like the page and the reconciliation.
  // The page scrolls without end: it asks for its first `shown` articles, 20 more each time.
  ipcMain.handle(IPC.getCartonStockMatrix, (event, query?: unknown) => {
    const who = administrator(event);
    if (!who.ok) return { accepted: false, reason: who.reason };
    const input = asRecord(query);
    const asked = Math.trunc(Number(input.shown));
    const shown = Number.isFinite(asked) && asked > 0 ? Math.min(asked, CARTON_STOCK_MOST_SHOWN) : CARTON_STOCK_PAGE_SIZE;
    try {
      return {
        accepted: true,
        ...db.cartonStockMatrix({ search: asString(input.search), series: asString(input.series), page: 1, pageSize: shown }),
      };
    } catch (error) {
      log("WARNING", "carton-matrix", error instanceof Error ? error.message : String(error));
      return { accepted: false, reason: "This could not be loaded. Try again." };
    }
  });

  ipcMain.handle(IPC.getCartonStockReconciliation, (event, query?: unknown) => {
    const who = administrator(event);
    if (!who.ok) return { accepted: false, reason: who.reason, reconciliation: null };
    const input = asRecord(query);
    try {
      return { accepted: true, reconciliation: db.cartonStockReconciliation({ page: Number(input.page), pageSize: Number(input.pageSize) }) };
    } catch (error) {
      log("WARNING", "reconcile", error instanceof Error ? error.message : String(error));
      return { accepted: false, reason: "This could not be loaded. Try again.", reconciliation: null };
    }
  });

  ipcMain.handle(IPC.listManualProduction, (event, query?: unknown) => {
    const who = operator(event);
    if (!who.ok) return { accepted: false, reason: who.reason, page: null };
    const input = asRecord(query);
    try {
      const page = db.listManualProduction({ date: asString(input.date), page: Number(input.page), pageSize: Number(input.pageSize) });
      return page ? { accepted: true, page } : { accepted: false, reason: "Choose a valid day.", page: null };
    } catch (error) {
      log("WARNING", "list", error instanceof Error ? error.message : String(error));
      return { accepted: false, reason: "This could not be loaded. Try again.", page: null };
    }
  });
}
