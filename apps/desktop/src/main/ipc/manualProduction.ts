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

import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { IPC } from "../../shared/ipcChannels";
import type { IpcContext } from "./context";
import { PERMISSION, asRecord, asString } from "@erp/domain";
import { rejection } from "../authorize";

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
      // A refusal (bad quantity, disabled product, machine not ready) is the data layer's own words.
      const reason = error instanceof Error ? error.message : "The production could not be recorded. Nothing was saved.";
      log("WARNING", "record-refused", reason, who.user.id);
      return { accepted: false, reason, entry: null };
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
