// QR generator, QR management (void / restore / damaged), journey and search.
//
// IPC handlers are registered per feature; every write is authorised through ctx.authorizer
// (see ../authorize.ts) and every channel name comes from shared/ipcChannels.ts.

import { ipcMain } from "electron";
import { IPC } from "../../shared/ipcChannels";
import type { IpcContext } from "./context";
import { PERMISSION } from "@erp/domain";

export function registerQrCodesHandlers(ctx: IpcContext): void {
  const { db, logger, authorizer, scanContext, deviceId, useCases } = ctx;
  const { processScanUseCase, dispatchScanUseCase, returnScanUseCase, storeEntryScanUseCase, storeExitScanUseCase, createGatepassUseCase, cancelGatepassUseCase } = useCases;

  ipcMain.handle(IPC.generateQrBatch, (event, input?: Record<string, unknown>) => {
    try {
      authorizer.requirePermission(event, PERMISSION.QR_GENERATOR);
      return {
        accepted: true,
        ...db.generateQrBatch({
          articleSizeId: String(input?.articleSizeId ?? ""),
          color: String(input?.color ?? ""),
          quantity: Number(input?.quantity ?? 0),
          createdBy: typeof input?.createdBy === "string" ? input.createdBy : undefined,
          requestedBy: typeof input?.requestedBy === "string" ? input.requestedBy : undefined,
        }),
      };
    } catch (error) {
      return { accepted: false, reason: error instanceof Error ? error.message : "Could not generate QR codes" };
    }
  });

  ipcMain.handle(IPC.listQrBatches, (_event, input?: number | { limit?: number; sinceIso?: string }) =>
    db.listQrBatches(input)
  );

  ipcMain.handle(IPC.listQrCodesForBatch, (_event, batchId: string) => db.listQrCodesForBatch(batchId));

  ipcMain.handle(IPC.listQrColors, () => db.listQrColors());

  ipcMain.handle(IPC.getQrSequenceState, (_event, input?: Record<string, unknown>) =>
    db.getQrSequenceState({
      articleSizeId: String(input?.articleSizeId ?? ""),
      color: String(input?.color ?? ""),
    })
  );

  ipcMain.handle(IPC.searchQrCodes, (_event, query?: string, limit?: number) =>
    db.searchQrCodes(String(query ?? ""), typeof limit === "number" ? limit : undefined)
  );

  ipcMain.handle(IPC.getQrDetail, (_event, qrId?: string) => db.getQrDetail(String(qrId ?? "")));

  // QR Journey: the whole path one code has taken, derived from the registry + event log.
  ipcMain.handle(IPC.getQrJourney, (_event, qrId?: string) => db.getQrJourney(String(qrId ?? "")));

  // Read-only overview: grouped generation runs + stage tallies, filtered at the database.
  ipcMain.handle(IPC.getQrGenerationOverview, (_event, filter?: Record<string, unknown>) =>
    db.getQrGenerationOverview({
      fromDate: typeof filter?.fromDate === "string" && filter.fromDate ? filter.fromDate : undefined,
      toDate: typeof filter?.toDate === "string" && filter.toDate ? filter.toDate : undefined,
      article: typeof filter?.article === "string" && filter.article ? filter.article : undefined,
      color: typeof filter?.color === "string" && filter.color ? filter.color : undefined,
      size: typeof filter?.size === "string" && filter.size ? filter.size : undefined,
      page: Number.isFinite(filter?.page) ? Number(filter?.page) : undefined,
      pageSize: Number.isFinite(filter?.pageSize) ? Number(filter?.pageSize) : undefined,
      includeSummary: filter?.includeSummary === false ? false : undefined,
    })
  );

  ipcMain.handle(IPC.listQrGenerationFilterOptions, () => db.listQrGenerationFilterOptions());

  ipcMain.handle(IPC.listQrBatchMembers, (_event, batchId?: string, opts?: Record<string, unknown>) =>
    db.listQrBatchMembers(String(batchId ?? ""), {
      page: Number.isFinite(opts?.page) ? Number(opts?.page) : undefined,
      pageSize: Number.isFinite(opts?.pageSize) ? Number(opts?.pageSize) : undefined,
    })
  );

  ipcMain.handle(IPC.voidQrCode, (event, input?: Record<string, unknown>) => {
    try {
      authorizer.requirePermission(event, PERMISSION.QR_MANAGEMENT);
      db.voidQrCode({
        qrId: String(input?.qrId ?? ""),
        reason: String(input?.reason ?? ""),
        actor: typeof input?.actor === "string" ? input.actor : null,
      });
      logger.log({ module: "qr-management", severity: "INFO", operation: "void-qr-code", deviceId, message: String(input?.qrId ?? "") });
      return { accepted: true };
    } catch (error) {
      return { accepted: false, reason: error instanceof Error ? error.message : "Could not void this code" };
    }
  });

  ipcMain.handle(IPC.restoreQrCode, (event, input?: Record<string, unknown>) => {
    try {
      authorizer.requirePermission(event, PERMISSION.QR_MANAGEMENT);
      db.restoreQrCode({ qrId: String(input?.qrId ?? "") });
      logger.log({ module: "qr-management", severity: "INFO", operation: "restore-qr-code", deviceId, message: String(input?.qrId ?? "") });
      return { accepted: true };
    } catch (error) {
      return { accepted: false, reason: error instanceof Error ? error.message : "Could not restore this code" };
    }
  });

  ipcMain.handle(IPC.markQrCodeDamaged, (event, input?: Record<string, unknown>) => {
    try {
      authorizer.requirePermission(event, PERMISSION.QR_MANAGEMENT);
      const result = db.markQrCodeDamaged({
        qrId: String(input?.qrId ?? ""),
        reason: String(input?.reason ?? ""),
        actor: typeof input?.actor === "string" ? input.actor : null,
        // Same operational identity the production scanner stamps on its events.
        context: scanContext,
      });
      logger.log({ module: "qr-management", severity: "WARNING", operation: "mark-damaged", deviceId, message: `${String(input?.qrId ?? "")} — ${String(input?.reason ?? "")}` });
      return { accepted: true, ...result };
    } catch (error) {
      return { accepted: false, reason: error instanceof Error ? error.message : "Could not mark this unit damaged" };
    }
  });
}
