// Cash vouchers and the customer ledger with cash.
//
// IPC handlers are registered per feature; every write is authorised through ctx.authorizer
// (see ../authorize.ts) and every channel name comes from shared/ipcChannels.ts.

import { ipcMain } from "electron";
import { IPC } from "../../shared/ipcChannels";
import type { IpcContext } from "./context";
import { PERMISSION } from "@erp/domain";
import type { SqliteDatabase } from "@erp/data";

export function registerCashHandlers(ctx: IpcContext): void {
  const { db, logger, authorizer, deviceId, useCases } = ctx;
  const { processScanUseCase, dispatchScanUseCase, returnScanUseCase, storeEntryScanUseCase, storeExitScanUseCase, createGatepassUseCase, cancelGatepassUseCase } = useCases;

  ipcMain.handle(IPC.getNextCashVoucherNumber, () => {
    try {
      return db.getNextCashVoucherNumber();
    } catch (error) {
      logger.log({
        module: "cash-voucher",
        severity: "ERROR",
        operation: "get-next-voucher-number",
        deviceId,
        message: error instanceof Error ? error.message : "Failed to get next cash voucher number",
      });
      return 1;
    }
  });

  ipcMain.handle(IPC.createCashVoucher, (event, input?: Record<string, unknown>) => {
    try {
      authorizer.requirePermission(event, PERMISSION.CASH_VOUCHER_FORM);
      const lines = Array.isArray(input?.lines) ? input.lines : [];
      if (!input?.voucherDate || !lines.length) return { accepted: false, reason: "Voucher date and at least one party row are required" };
      if (lines.some((line) => !line || typeof line !== "object")) return { accepted: false, reason: "Invalid party row" };

      const normalizedLines = lines.map((line) => {
        const row = line as Record<string, unknown>;
        return {
          partyId: String(row.partyId ?? "").trim(),
          description: String(row.description ?? "").trim(),
          modeOfTransfer: String(row.modeOfTransfer ?? "Cash").trim() || "Cash",
          bankAccountTitle: String(row.bankAccountTitle ?? "").trim(),
          chequeNumber: String(row.chequeNumber ?? "").trim(),
          chequeDate: String(row.chequeDate ?? "").trim(),
          onlineFrom: String(row.onlineFrom ?? "").trim(),
          onlineTo: String(row.onlineTo ?? "").trim(),
          referenceNo: String(row.referenceNo ?? "").trim(),
          receiptAmount: Number(row.receiptAmount) || 0,
          paymentAmount: Number(row.paymentAmount) || 0,
        };
      });
      if (normalizedLines.some((line) => !line.partyId || !line.modeOfTransfer || (line.receiptAmount <= 0 && line.paymentAmount <= 0) || (line.receiptAmount > 0 && line.paymentAmount > 0))) {
        return { accepted: false, reason: "Each party row needs a party, payment mode, and either a receipt or payment amount" };
      }

      const firstLine = normalizedLines[0];

      const voucherId = db.createCashVoucher({
        partyId: firstLine.partyId,
        voucherDate: String(input.voucherDate),
        modeOfTransfer: firstLine.modeOfTransfer,
        description: String(input.description ?? "").trim(),
        receiptAmount: firstLine.receiptAmount,
        paymentAmount: firstLine.paymentAmount,
        lines: normalizedLines,
      });

      logger.log({
        module: "cash-voucher",
        severity: "INFO",
        operation: "create-cash-voucher",
        deviceId,
        message: `Cash voucher created: ${voucherId}`,
      });

      return { accepted: true, voucherId };
    } catch (error) {
      logger.log({
        module: "cash-voucher",
        severity: "ERROR",
        operation: "create-cash-voucher",
        deviceId,
        message: error instanceof Error ? error.message : "Failed to create cash voucher",
      });
      return { accepted: false, reason: `Failed to create cash voucher: ${error instanceof Error ? error.message : "Unknown error"}` };
    }
  });

  ipcMain.handle(IPC.updateCashVoucher, (event, voucherId?: string, input?: Record<string, unknown>) => {
    try {
      authorizer.requirePermission(event, PERMISSION.CASH_VOUCHER_FORM);
      if (!voucherId) {
        return { accepted: false, reason: "Voucher ID is required" };
      }

      const updateData: Parameters<SqliteDatabase["updateCashVoucher"]>[1] = {};
      if (input?.partyId) updateData.partyId = String(input.partyId);
      if (input?.voucherDate) updateData.voucherDate = String(input.voucherDate);
      if (input?.description !== undefined) updateData.description = String(input.description ?? "");
      if (typeof input?.receiptAmount === "number") updateData.receiptAmount = input.receiptAmount;
      if (typeof input?.paymentAmount === "number") updateData.paymentAmount = input.paymentAmount;
      if (typeof input?.modeOfTransfer === "string") updateData.modeOfTransfer = input.modeOfTransfer || "Cash";
      if (Array.isArray(input?.lines)) {
        const lines = input.lines.map((line) => {
          const row = line as Record<string, unknown>;
          return {
            partyId: String(row.partyId ?? "").trim(),
            description: String(row.description ?? "").trim(),
            modeOfTransfer: String(row.modeOfTransfer ?? "Cash").trim() || "Cash",
            bankAccountTitle: String(row.bankAccountTitle ?? "").trim(),
            chequeNumber: String(row.chequeNumber ?? "").trim(),
            chequeDate: String(row.chequeDate ?? "").trim(),
            onlineFrom: String(row.onlineFrom ?? "").trim(),
            onlineTo: String(row.onlineTo ?? "").trim(),
            referenceNo: String(row.referenceNo ?? "").trim(),
            receiptAmount: Number(row.receiptAmount) || 0,
            paymentAmount: Number(row.paymentAmount) || 0,
          };
        });
        if (!lines.length || lines.some((line) => !line.partyId || !line.modeOfTransfer || (line.receiptAmount <= 0 && line.paymentAmount <= 0) || (line.receiptAmount > 0 && line.paymentAmount > 0))) {
          return { accepted: false, reason: "Each party row needs a party, payment mode, and either a receipt or payment amount" };
        }
        updateData.partyId = lines[0].partyId;
        updateData.modeOfTransfer = lines[0].modeOfTransfer;
        updateData.receiptAmount = lines[0].receiptAmount;
        updateData.paymentAmount = lines[0].paymentAmount;
        updateData.lines = lines;
      }

      // Validate that we don't have both receipt and payment amounts
      if ((updateData.receiptAmount ?? 0) > 0 && (updateData.paymentAmount ?? 0) > 0) {
        return { accepted: false, reason: "Cannot have both receipt and payment amounts in the same voucher" };
      }

      db.updateCashVoucher(voucherId, updateData);

      logger.log({
        module: "cash-voucher",
        severity: "INFO",
        operation: "update-cash-voucher",
        deviceId,
        message: `Cash voucher updated: ${voucherId}`,
      });

      return { accepted: true };
    } catch (error) {
      logger.log({
        module: "cash-voucher",
        severity: "ERROR",
        operation: "update-cash-voucher",
        deviceId,
        message: error instanceof Error ? error.message : "Failed to update cash voucher",
      });
      return { accepted: false, reason: `Failed to update cash voucher: ${error instanceof Error ? error.message : "Unknown error"}` };
    }
  });

  ipcMain.handle(IPC.getCashVoucher, (_event, id?: string) => {
    try {
      if (!id) return null;
      return db.getCashVoucher(id);
    } catch (error) {
      logger.log({
        module: "cash-voucher",
        severity: "ERROR",
        operation: "get-cash-voucher",
        deviceId,
        message: error instanceof Error ? error.message : "Failed to get cash voucher",
      });
      return null;
    }
  });

  ipcMain.handle(IPC.getCashVoucherByNumber, (_event, voucherNumber?: number) => {
    try {
      if (typeof voucherNumber !== "number") return null;
      return db.getCashVoucherByNumber(voucherNumber);
    } catch (error) {
      logger.log({
        module: "cash-voucher",
        severity: "ERROR",
        operation: "get-cash-voucher-by-number",
        deviceId,
        message: error instanceof Error ? error.message : "Failed to get cash voucher by number",
      });
      return null;
    }
  });

  ipcMain.handle(IPC.listCashVouchers, (_event, query?: Record<string, unknown>) => {
    try {
      return db.listCashVouchers({
        search: typeof query?.search === "string" ? query.search : undefined,
        fromDate: typeof query?.fromDate === "string" ? query.fromDate : undefined,
        toDate: typeof query?.toDate === "string" ? query.toDate : undefined,
        partyId: typeof query?.partyId === "string" ? query.partyId : undefined,
        page: typeof query?.page === "number" ? query.page : undefined,
        pageSize: typeof query?.pageSize === "number" ? query.pageSize : undefined,
      });
    } catch (error) {
      logger.log({
        module: "cash-voucher",
        severity: "ERROR",
        operation: "list-cash-vouchers",
        deviceId,
        message: error instanceof Error ? error.message : "Failed to list cash vouchers",
      });
      return { rows: [], total: 0, page: 1, pageSize: 20 };
    }
  });

  ipcMain.handle(IPC.deleteCashVoucher, (event, id?: string) => {
    try {
      authorizer.requirePermission(event, PERMISSION.CASH_VOUCHER_FORM);
      if (!id) {
        return { accepted: false, reason: "Voucher ID is required" };
      }

      db.deleteCashVoucher(id);

      logger.log({
        module: "cash-voucher",
        severity: "INFO",
        operation: "delete-cash-voucher",
        deviceId,
        message: `Cash voucher deleted: ${id}`,
      });

      return { accepted: true };
    } catch (error) {
      logger.log({
        module: "cash-voucher",
        severity: "ERROR",
        operation: "delete-cash-voucher",
        deviceId,
        message: error instanceof Error ? error.message : "Failed to delete cash voucher",
      });
      return { accepted: false, reason: "Failed to delete cash voucher" };
    }
  });

  ipcMain.handle(IPC.getCustomerLedgerWithCash, (_event, partyId?: string, query?: Record<string, unknown>) => {
    try {
      if (typeof partyId !== "string" || !partyId.trim()) {
        return { partyId: "", partyName: "", openingBalance: 0, closingBalance: 0, entries: [] };
      }
      return db.getCustomerLedgerWithCash(partyId, {
        fromDate: typeof query?.fromDate === "string" ? query.fromDate : undefined,
        toDate: typeof query?.toDate === "string" ? query.toDate : undefined,
      });
    } catch (error) {
      logger.log({
        module: "cash-voucher",
        severity: "ERROR",
        operation: "get-customer-ledger-with-cash",
        deviceId,
        message: error instanceof Error ? error.message : "Failed to get customer ledger with cash",
      });
      return { partyId: "", partyName: "", openingBalance: 0, closingBalance: 0, entries: [] };
    }
  });
}
