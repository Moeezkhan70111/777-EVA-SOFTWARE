// Purchase vouchers (supplier bills), supplier ledger and balances.
//
// IPC handlers are registered per feature; every write is authorised through ctx.authorizer
// (see ../authorize.ts) and every channel name comes from shared/ipcChannels.ts.

import { ipcMain } from "electron";
import { IPC } from "../../shared/ipcChannels";
import type { IpcContext } from "./context";
import { PERMISSION } from "@erp/domain";

export function registerPurchasesHandlers(ctx: IpcContext): void {
  const { db, logger, authorizer, deviceId, useCases } = ctx;
  const { processScanUseCase, dispatchScanUseCase, returnScanUseCase, storeEntryScanUseCase, storeExitScanUseCase, createGatepassUseCase, cancelGatepassUseCase } = useCases;

  ipcMain.handle(IPC.getNextPurchaseVoucherNumber, () => {
    try {
      return db.getNextPurchaseVoucherNumber();
    } catch { return "1"; }
  });

  ipcMain.handle(IPC.createPurchaseVoucher, (event, input?: Record<string, unknown>) => {
    try {
      authorizer.requirePermission(event, PERMISSION.PURCHASE_VOUCHER_FORM);
      const partyId = typeof input?.partyId === "string" ? input.partyId : "";
      if (!partyId) return { accepted: false, reason: "Supplier is required" };
      const lines = Array.isArray(input?.lines) ? (input.lines as Array<Record<string, unknown>>).map((l) => ({
        itemId: String(l.itemId ?? ""),
        quantity: Number(l.quantity) || 0,
        unitPrice: Number(l.unitPrice) || 0,
      })).filter((l) => l.itemId) : [];
      const result = db.createPurchaseVoucher({
        partyId,
        voucherDate: typeof input?.voucherDate === "string" ? input.voucherDate : new Date().toISOString().split("T")[0],
        bookNo: typeof input?.bookNo === "string" ? input.bookNo : undefined,
        referenceNo: typeof input?.referenceNo === "string" ? input.referenceNo : undefined,
        remarks: typeof input?.remarks === "string" ? input.remarks : undefined,
        voucherNumber: typeof input?.voucherNumber === "string" ? input.voucherNumber : undefined,
        lines,
      });
      logger.log({ module: "billing", severity: "INFO", operation: "create-purchase-voucher", deviceId, message: `Purchase voucher created: ${result.voucherNumber}` });
      return { accepted: true, id: result.id, voucherNumber: result.voucherNumber };
    } catch (error) {
      logger.log({ module: "billing", severity: "ERROR", operation: "create-purchase-voucher", deviceId, message: error instanceof Error ? error.message : "Failed to create purchase voucher" });
      return { accepted: false, reason: error instanceof Error ? error.message : "Failed to create purchase voucher" };
    }
  });

  ipcMain.handle(IPC.getPurchaseVoucher, (_event, voucherId?: string) => {
    try {
      if (typeof voucherId !== "string" || !voucherId.trim()) return null;
      return db.getPurchaseVoucher(voucherId);
    } catch { return null; }
  });

  ipcMain.handle(IPC.listPurchaseVouchers, (_event, query?: Record<string, unknown>) => {
    try {
      return db.listPurchaseVouchers({
        search: typeof query?.search === "string" ? query.search : "",
        page: Number.isFinite(query?.page) ? Number(query?.page) : 1,
        pageSize: Number.isFinite(query?.pageSize) ? Number(query?.pageSize) : 20,
        status: typeof query?.status === "string" ? query.status : undefined,
        partyId: typeof query?.partyId === "string" ? query.partyId : undefined,
        dateFrom: typeof query?.dateFrom === "string" ? query.dateFrom : undefined,
        dateTo:   typeof query?.dateTo   === "string" ? query.dateTo   : undefined,
      });
    } catch { return { rows: [], total: 0, page: 1, pageSize: 20 }; }
  });

  ipcMain.handle(IPC.updatePurchaseVoucher, (event, voucherId?: string, input?: Record<string, unknown>) => {
    try {
      authorizer.requirePermission(event, PERMISSION.PURCHASE_VOUCHER_FORM);
      if (typeof voucherId !== "string" || !voucherId.trim()) return { accepted: false, reason: "Voucher ID is required" };
      const lines = Array.isArray(input?.lines) ? (input.lines as Array<Record<string, unknown>>).map((l) => ({
        itemId: String(l.itemId ?? ""),
        quantity: Number(l.quantity) || 0,
        unitPrice: Number(l.unitPrice) || 0,
      })).filter((l) => l.itemId) : undefined;
      db.updatePurchaseVoucher(voucherId, {
        partyId: typeof input?.partyId === "string" ? input.partyId : undefined,
        voucherDate: typeof input?.voucherDate === "string" ? input.voucherDate : undefined,
        bookNo: typeof input?.bookNo === "string" ? input.bookNo : undefined,
        referenceNo: typeof input?.referenceNo === "string" ? input.referenceNo : undefined,
        remarks: typeof input?.remarks === "string" ? input.remarks : undefined,
        lines,
      });
      return { accepted: true };
    } catch (error) {
      return { accepted: false, reason: error instanceof Error ? error.message : "Failed to update purchase voucher" };
    }
  });

  ipcMain.handle(IPC.deletePurchaseVoucher, (event, voucherId?: string) => {
    try {
      authorizer.requirePermission(event, PERMISSION.PURCHASE_VOUCHER_FORM);
      if (typeof voucherId !== "string" || !voucherId.trim()) return { accepted: false, reason: "Voucher ID is required" };
      db.deletePurchaseVoucher(voucherId);
      return { accepted: true };
    } catch (error) {
      return { accepted: false, reason: error instanceof Error ? error.message : "Failed to delete purchase voucher" };
    }
  });

  ipcMain.handle(IPC.getSupplierLedger, (_event, partyId?: string, query?: Record<string, unknown>) => {
    try {
      if (typeof partyId !== "string" || !partyId.trim()) return { partyId: "", partyName: "", openingBalance: 0, closingBalance: 0, entries: [] };
      return db.getSupplierLedger(partyId, {
        fromDate: typeof query?.fromDate === "string" ? query.fromDate : undefined,
        toDate: typeof query?.toDate === "string" ? query.toDate : undefined,
      });
    } catch { return { partyId: "", partyName: "", openingBalance: 0, closingBalance: 0, entries: [] }; }
  });

  ipcMain.handle(IPC.listSupplierBalances, (_event, query?: Record<string, unknown>) => {
    try {
      return db.listSupplierBalances({ asOfDate: typeof query?.asOfDate === "string" ? query.asOfDate : undefined });
    } catch { return { rows: [], total: 0 }; }
  });
}
