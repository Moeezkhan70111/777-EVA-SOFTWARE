// Raw Material QR Generator: select a Party (supplier) + a raw material item, generate a
// batch of QR identities to print and attach to the incoming stock.
//
// IPC handlers are registered per feature; every write is authorised through ctx.authorizer
// (see ../authorize.ts) and every channel name comes from shared/ipcChannels.ts.

import { ipcMain } from "electron";
import { IPC } from "../../shared/ipcChannels";
import type { IpcContext } from "./context";
import { PERMISSION } from "@erp/domain";

export function registerRawMaterialQrHandlers(ctx: IpcContext): void {
  const { db, authorizer } = ctx;

  ipcMain.handle(IPC.generateRawMaterialQrBatch, (event, input?: Record<string, unknown>) => {
    try {
      authorizer.requirePermission(event, PERMISSION.RAW_MATERIAL_QR_GENERATOR);
      return {
        accepted: true,
        ...db.generateRawMaterialQrBatch({
          partyId: String(input?.partyId ?? ""),
          itemId: String(input?.itemId ?? ""),
          quantity: Number(input?.quantity ?? 0),
          packingQuantity: Number(input?.packingQuantity ?? 0),
          createdBy: typeof input?.createdBy === "string" ? input.createdBy : undefined,
          requestedBy: typeof input?.requestedBy === "string" ? input.requestedBy : undefined,
        }),
      };
    } catch (error) {
      return { accepted: false, reason: error instanceof Error ? error.message : "Could not generate raw material QR codes" };
    }
  });

  ipcMain.handle(IPC.rawMaterialQrBatchDeleteBlockers, (event, batchId: string) => {
    try {
      authorizer.requirePermission(event, PERMISSION.RAW_MATERIAL_QR_GENERATOR);
      return { accepted: true, blockers: db.rawMaterialQrBatchDeleteBlockers(String(batchId ?? "")) };
    } catch (error) {
      return { accepted: false, reason: error instanceof Error ? error.message : "Could not check this run" };
    }
  });

  ipcMain.handle(IPC.deleteRawMaterialQrBatch, (event, batchId: string) => {
    try {
      authorizer.requirePermission(event, PERMISSION.RAW_MATERIAL_QR_GENERATOR);
      return { accepted: true, ...db.deleteRawMaterialQrBatch({ batchId: String(batchId ?? ""), deletedBy: undefined }) };
    } catch (error) {
      return { accepted: false, reason: error instanceof Error ? error.message : "Could not erase this run" };
    }
  });

  ipcMain.handle(IPC.listRawMaterialQrBatches, (_event, input?: { limit?: number; sinceIso?: string }) =>
    db.listRawMaterialQrBatches(input)
  );

  ipcMain.handle(IPC.listRawMaterialQrsForBatch, (_event, batchId: string) => db.listRawMaterialQrsForBatch(batchId));

  // Reprinting one already-generated packet label, exactly as it was first printed.
  ipcMain.handle(IPC.getRawMaterialQrLabel, (_event, qrId: string) => db.getRawMaterialQrLabel(String(qrId ?? "")));

  ipcMain.handle(IPC.getRawMaterialQrSequenceState, (_event, input?: Record<string, unknown>) =>
    db.getRawMaterialQrSequenceState({
      partyId: String(input?.partyId ?? ""),
      itemId: String(input?.itemId ?? ""),
    })
  );
}
