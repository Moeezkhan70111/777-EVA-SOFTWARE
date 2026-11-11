// Stock Adjustment documents, from the Stock Adjustment page (packages/data/src/database/cartonStockDocuments.ts; docs/46).
//
// IPC handlers are registered per feature; every write is authorised through ctx.authorizer (see ../authorize.ts) and
// every channel name comes from shared/ipcChannels.ts.
//
//   postCartonStockAdjustment   Opening Stock or Stock Adjustment, all lines or none. AN ADMINISTRATOR, from the session,
//                               and a write under the CARTON_STOCK lease (leaseChannels.ts): the guard refuses it on a
//                               computer that does not hold carton stock before this handler runs.
//   getCartonAdjustmentArticle  one article's colours and sizes with their figure, for the preview. Reads only.
//   listCartonStockAdjustments  the posted documents, newest first. Reads only.
//
// Who posted it and where are read here, never from the screen. Nothing here touches the raw material store.

import type { IpcMainInvokeEvent } from "electron";
import { ipcMain } from "../leaseGuard";
import { IPC } from "../../shared/ipcChannels";
import type { IpcContext } from "./context";
import { asRecord, asString } from "@erp/domain";
import { rejection } from "../authorize";
import { refusalReason } from "../writeRefusal";

/** What an operator is told. One place, for translation later (R21). */
export const STOCK_ADJUSTMENT_MESSAGES = {
  BUSY: "The document was not posted because another stock operation is in progress. Nothing was changed. Please try again.",
  NOT_POSTED: "The document could not be posted. Nothing was changed.",
  NOT_READ: "Stock adjustments could not be read.",
} as const;

const asLines = (value: unknown): Array<{ articleSizeId: string; color: string; direction: string; cartons: number }> =>
  (Array.isArray(value) ? value : []).map((item) => {
    const line = asRecord(item);
    return { articleSizeId: asString(line.articleSizeId), color: asString(line.color), direction: asString(line.direction), cartons: Number(line.cartons) };
  });

export function registerCartonStockAdjustmentHandlers(ctx: Pick<IpcContext, "db" | "logger" | "authorizer" | "scanContext" | "deviceId">): void {
  const { db, logger, authorizer, scanContext, deviceId } = ctx;

  const log = (severity: "INFO" | "WARNING", operation: string, message: string, userId?: string) =>
    logger.log({ module: "stock-adjustment", severity, operation, deviceId, userId, message });

  const administrator = (event: IpcMainInvokeEvent) => {
    try {
      return { ok: true as const, user: authorizer.requireAdmin(event) };
    } catch (error) {
      return { ok: false as const, ...rejection(error, "Only an administrator can do this.") };
    }
  };

  ipcMain.handle(IPC.postCartonStockAdjustment, (event, input?: unknown) => {
    const who = administrator(event);
    if (!who.ok) return { accepted: false, reason: who.reason };
    const fields = asRecord(input);
    try {
      const result = db.postCartonStockAdjustment({
        requestId: asString(fields.requestId),
        kind: asString(fields.kind),
        businessDate: asString(fields.businessDate),
        reason: asString(fields.reason),
        remarks: asString(fields.remarks),
        lines: asLines(fields.lines),
        postedBy: who.user.username,
        workstationId: scanContext.workstationId,
        storeLocationId: scanContext.factoryId,
      });
      const { document } = result;
      log("INFO", "post", JSON.stringify({ document: document.code, kind: document.kind, in: document.cartonsIn, out: document.cartonsOut, lines: document.lines.length, duplicate: result.duplicate }), who.user.id);
      return { accepted: true, document, duplicate: result.duplicate };
    } catch (error) {
      log("WARNING", "post-refused", error instanceof Error ? error.message : String(error), who.user.id);
      return { accepted: false, reason: refusalReason(error, STOCK_ADJUSTMENT_MESSAGES.BUSY, STOCK_ADJUSTMENT_MESSAGES.NOT_POSTED) };
    }
  });

  ipcMain.handle(IPC.getCartonAdjustmentArticle, (event, article?: unknown) => {
    const who = administrator(event);
    if (!who.ok) return { accepted: false, reason: who.reason };
    try {
      return { accepted: true, choices: db.cartonAdjustmentArticle(typeof article === "string" ? article : "") };
    } catch (error) {
      return { accepted: false, reason: error instanceof Error ? error.message : STOCK_ADJUSTMENT_MESSAGES.NOT_READ };
    }
  });

  ipcMain.handle(IPC.listCartonStockAdjustments, (event, query?: unknown) => {
    const who = administrator(event);
    if (!who.ok) return { accepted: false, reason: who.reason };
    const fields = asRecord(query);
    try {
      return { accepted: true, page: db.listCartonStockAdjustments({ page: Number(fields.page) || 1, pageSize: Number(fields.pageSize) || 10 }) };
    } catch (error) {
      return { accepted: false, reason: error instanceof Error ? error.message : STOCK_ADJUSTMENT_MESSAGES.NOT_READ };
    }
  });
}
