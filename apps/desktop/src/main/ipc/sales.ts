// Discount policy and sale vouchers.
//
// IPC handlers are registered per feature; every write is authorised through ctx.authorizer
// (see ../authorize.ts) and every channel name comes from shared/ipcChannels.ts.

import { ipcMain } from "electron";
import { businessToday } from "@erp/domain";
import { IPC } from "../../shared/ipcChannels";
import type { IpcContext } from "./context";
import { PERMISSION } from "@erp/domain";
import { isBillGatepassMismatchError, isDiscountExceedsAllowedError, isGatepassBillingError, isPartyBalanceLimitError } from "./context";

export function registerSalesHandlers(ctx: IpcContext): void {
  const { db, logger, authorizer, deviceId, useCases } = ctx;
  const { processScanUseCase, dispatchScanUseCase, returnScanUseCase, storeEntryScanUseCase, storeExitScanUseCase, createGatepassUseCase, cancelGatepassUseCase } = useCases;

  // Recorded carton returns — the credits the Return screen and Return History read back.
  ipcMain.handle(IPC.listSaleReturns, (event, query?: Record<string, unknown>) => {
    try {
      authorizer.requirePermission(event, PERMISSION.RETURN_HISTORY);
      return db.listSaleReturns({
        partyId: typeof query?.partyId === "string" ? query.partyId : undefined,
        fromDate: typeof query?.fromDate === "string" ? query.fromDate : undefined,
        toDate: typeof query?.toDate === "string" ? query.toDate : undefined,
        limit: typeof query?.limit === "number" ? query.limit : undefined,
      });
    } catch (error) {
      logger.log({
        module: "return",
        severity: "ERROR",
        operation: "list-sale-returns",
        deviceId,
        message: error instanceof Error ? error.message : "Failed to list returns",
      });
      return [];
    }
  });

  ipcMain.handle(IPC.createPartyProductGroupDiscount, (event, input?: Record<string, unknown>) => {
    try {
      authorizer.requirePermission(event, PERMISSION.DISCOUNT_POLICY);
      if (!input || typeof input.partyId !== "string" || typeof input.productGroupId !== "string") {
        return { accepted: false, reason: "Party and product group are required" };
      }
      const id = db.createPartyProductGroupDiscount({
        partyId: input.partyId,
        productGroupId: input.productGroupId,
        discountPerPair: Number(input.discountPerPair ?? 0),
      });
      return { accepted: true, id };
    } catch (error) {
      return { accepted: false, reason: error instanceof Error ? error.message : "Failed to save discount" };
    }
  });

  ipcMain.handle(IPC.createPartyArticleSeriesDiscount, (event, input?: Record<string, unknown>) => {
    try {
      authorizer.requirePermission(event, PERMISSION.DISCOUNT_POLICY);
      if (!input || typeof input.partyId !== "string" || typeof input.articleSeriesId !== "string") {
        return { accepted: false, reason: "Party and article series are required" };
      }
      const id = db.createPartyArticleSeriesDiscount({
        partyId: input.partyId,
        articleSeriesId: input.articleSeriesId,
        discountPerPair: Number(input.discountPerPair ?? 0),
      });
      return { accepted: true, id };
    } catch (error) {
      return { accepted: false, reason: error instanceof Error ? error.message : "Failed to save discount" };
    }
  });

  ipcMain.handle(IPC.createPartyArticleDiscount, (event, input?: Record<string, unknown>) => {
    try {
      authorizer.requirePermission(event, PERMISSION.DISCOUNT_POLICY);
      if (!input || typeof input.partyId !== "string" || typeof input.article !== "string" || !input.article.trim()) {
        return { accepted: false, reason: "Party and article are required" };
      }
      const id = db.createPartyArticleDiscount({
        partyId: input.partyId,
        article: input.article,
        sizeScope: input.sizeScope === "SEPARATE_SIZES" ? "SEPARATE_SIZES" : "ALL_SIZES",
        size: typeof input.size === "string" && input.size ? input.size : null,
        discountPerPair: Number(input.discountPerPair ?? 0),
      });
      return { accepted: true, id };
    } catch (error) {
      return { accepted: false, reason: error instanceof Error ? error.message : "Failed to save discount" };
    }
  });

  ipcMain.handle(IPC.createPartyPriceRangeDiscount, (event, input?: Record<string, unknown>) => {
    try {
      authorizer.requirePermission(event, PERMISSION.DISCOUNT_POLICY);
      if (!input || typeof input.partyId !== "string") {
        return { accepted: false, reason: "Party is required" };
      }
      const id = db.createPartyPriceRangeDiscount({
        partyId: input.partyId,
        startPrice: Number(input.startPrice ?? 0),
        endPrice: Number(input.endPrice ?? 0),
        discountPerPair: Number(input.discountPerPair ?? 0),
      });
      return { accepted: true, id };
    } catch (error) {
      return { accepted: false, reason: error instanceof Error ? error.message : "Failed to save discount" };
    }
  });

  ipcMain.handle(IPC.getPartyDiscountReport, (_event, partyId?: string) => {
    try {
      if (typeof partyId !== "string" || !partyId.trim()) {
        return [];
      }
      return db.getPartyDiscountReport(partyId);
    } catch (error) {
      logger.log({
        module: "party",
        severity: "ERROR",
        operation: "get-party-discount-report",
        deviceId,
        message: error instanceof Error ? error.message : "Failed to get party discount report",
      });
      return [];
    }
  });

  ipcMain.handle(IPC.resolveProductDiscount, (_event, partyId?: string, productVariantId?: string) => {
    try {
      if (typeof partyId !== "string" || !partyId.trim() || typeof productVariantId !== "string" || !productVariantId.trim()) {
        return { discountPerPair: 0, source: "NONE" };
      }
      return db.resolveProductDiscount(partyId, productVariantId);
    } catch (error) {
      logger.log({
        module: "party",
        severity: "ERROR",
        operation: "resolve-product-discount",
        deviceId,
        message: error instanceof Error ? error.message : "Failed to resolve product discount",
      });
      return { discountPerPair: 0, source: "NONE" };
    }
  });

  ipcMain.handle(IPC.resolveProductDiscountWithPrice, (_event, partyId?: string, productVariantId?: string, actualPrice?: number) => {
    try {
      if (typeof partyId !== "string" || !partyId.trim() || typeof productVariantId !== "string" || !productVariantId.trim() || typeof actualPrice !== "number" || actualPrice <= 0) {
        return { discountPerPair: 0, source: "NONE" };
      }
      return db.resolveProductDiscountWithPrice(partyId, productVariantId, actualPrice);
    } catch (error) {
      logger.log({
        module: "party",
        severity: "ERROR",
        operation: "resolve-product-discount-with-price",
        deviceId,
        message: error instanceof Error ? error.message : "Failed to resolve product discount with price",
      });
      return { discountPerPair: 0, source: "NONE" };
    }
  });

  ipcMain.handle(IPC.createSaleVoucher, (event, input?: Record<string, unknown>) => {
    try {
      authorizer.requirePermission(event, PERMISSION.SALE_VOUCHER_FORM);
      const partyId = typeof input?.partyId === "string" ? input.partyId : "";
      // THE STAMP -- see the purchase handler. A sale entered after midnight was dated the
      // previous day, and that date is what the customer ledger and the bill carry.
      const voucherDate = typeof input?.voucherDate === "string" ? input.voucherDate : businessToday();
      const bookNo = typeof input?.bookNo === "string" ? input.bookNo.trim() : "";

      if (!partyId) {
        return { accepted: false, reason: "Party is required" };
      }

      const result = db.createSaleVoucher({
        partyId,
        voucherDate,
        bookNo,
        voucherNumber: typeof input?.voucherNumber === "string" ? input.voucherNumber : undefined,
        subPartyName: typeof input?.subPartyName === "string" ? input.subPartyName : undefined,
        subPartyNameUrdu: typeof input?.subPartyNameUrdu === "string" ? input.subPartyNameUrdu : undefined,
        subPartyNumber: typeof input?.subPartyNumber === "string" ? input.subPartyNumber : undefined,
        remarks: typeof input?.remarks === "string" ? input.remarks : undefined,
        projectedTotal: typeof input?.projectedTotal === "number" ? input.projectedTotal : undefined,
        gatepassId: typeof input?.gatepassId === "string" ? input.gatepassId : null,
      });

      logger.log({
        module: "billing",
        severity: "INFO",
        operation: "create-voucher",
        deviceId,
        message: `Sale voucher created: ${result.voucherNumber}`,
      });

      return { accepted: true, ...result };
    } catch (error) {
      if (isPartyBalanceLimitError(error)) {
        logger.log({ module: "billing", severity: "INFO", operation: "create-voucher", deviceId, message: error.message });
        return {
          accepted: false,
          errorCode: error.code,
          reason: error.message,
          ...error.figures,
        };
      }
      if (isGatepassBillingError(error)) {
        logger.log({ module: "billing", severity: "WARNING", operation: "create-voucher", deviceId, message: error.message });
        return {
          accepted: false,
          errorCode: error.code,
          reason: error.message,
          existingVoucherId: error.existingVoucherId,
          existingVoucherNumber: error.existingVoucherNumber,
        };
      }
      logger.log({
        module: "billing",
        severity: "ERROR",
        operation: "create-voucher",
        deviceId,
        message: error instanceof Error ? error.message : "Failed to create sale voucher",
      });
      return { accepted: false, reason: error instanceof Error ? error.message : "Failed to create voucher" };
    }
  });

  // The live bill made from a gatepass, so the billing desk opens it instead of making a second one.
  ipcMain.handle(IPC.findSaleVoucherByGatepass, (_event, gatepassId?: string) => {
    try {
      if (typeof gatepassId !== "string" || !gatepassId.trim()) return null;
      return db.findSaleVoucherByGatepass(gatepassId);
    } catch (error) {
      logger.log({ module: "billing", severity: "ERROR", operation: "find-voucher-by-gatepass", deviceId, message: error instanceof Error ? error.message : String(error) });
      return null;
    }
  });

  ipcMain.handle(IPC.getSaleVoucher, (_event, voucherId?: string) => {
    try {
      if (typeof voucherId !== "string" || !voucherId.trim()) {
        return null;
      }
      return db.getSaleVoucher(voucherId);
    } catch (error) {
      logger.log({
        module: "billing",
        severity: "ERROR",
        operation: "get-voucher",
        deviceId,
        message: error instanceof Error ? error.message : "Failed to get sale voucher",
      });
      return null;
    }
  });

  ipcMain.handle(IPC.listSaleVouchers, (_event, query?: Record<string, unknown>) => {
    try {
      return db.listSaleVouchers({
        search: typeof query?.search === "string" ? query.search : "",
        page: Number.isFinite(query?.page) ? Number(query?.page) : 1,
        pageSize: Number.isFinite(query?.pageSize) ? Number(query?.pageSize) : 20,
        status: typeof query?.status === "string" ? query.status : undefined,
      });
    } catch (error) {
      logger.log({
        module: "billing",
        severity: "ERROR",
        operation: "list-vouchers",
        deviceId,
        message: error instanceof Error ? error.message : "Failed to list sale vouchers",
      });
      return { rows: [], total: 0, page: 1, pageSize: 20 };
    }
  });

  ipcMain.handle(IPC.updateSaleVoucher, (event, voucherId?: string, input?: Record<string, unknown>) => {
    try {
      authorizer.requirePermission(event, PERMISSION.SALE_VOUCHER_FORM);
      if (typeof voucherId !== "string" || !voucherId.trim()) {
        return { accepted: false, reason: "Voucher ID is required" };
      }

      db.updateSaleVoucher(voucherId, {
        bookNo: typeof input?.bookNo === "string" ? input.bookNo : undefined,
        subPartyName: typeof input?.subPartyName === "string" ? input.subPartyName : undefined,
        subPartyNameUrdu: typeof input?.subPartyNameUrdu === "string" ? input.subPartyNameUrdu : undefined,
        subPartyNumber: typeof input?.subPartyNumber === "string" ? input.subPartyNumber : undefined,
        remarks: typeof input?.remarks === "string" ? input.remarks : undefined,
      });

      logger.log({
        module: "billing",
        severity: "INFO",
        operation: "update-voucher",
        deviceId,
        message: `Sale voucher updated: ${voucherId}`,
      });

      return { accepted: true };
    } catch (error) {
      logger.log({
        module: "billing",
        severity: "ERROR",
        operation: "update-voucher",
        deviceId,
        message: error instanceof Error ? error.message : "Failed to update sale voucher",
      });
      return { accepted: false, reason: error instanceof Error ? error.message : "Failed to update voucher" };
    }
  });

  ipcMain.handle(IPC.addVoucherLineItem, (event, voucherId?: string, input?: Record<string, unknown>) => {
    try {
      authorizer.requirePermission(event, PERMISSION.SALE_VOUCHER_FORM);
      if (typeof voucherId !== "string" || !voucherId.trim()) {
        return { accepted: false, reason: "Voucher ID is required" };
      }

      const productVariantId = typeof input?.productVariantId === "string" ? input.productVariantId : "";
      const quantity = Number.isFinite(input?.quantity) ? Number(input?.quantity) : 0;
      const unitPrice = Number.isFinite(input?.unitPrice) ? Number(input?.unitPrice) : 0;
      const priceType = input?.priceType === "B_TYPE" ? "B_TYPE" : "NORMAL";

      if (!productVariantId || quantity <= 0) {
        return { accepted: false, reason: "Invalid product or quantity" };
      }

      const result = db.addVoucherLineItem(voucherId, {
        productVariantId,
        quantity,
        unitPrice,
        // B-TYPE always has zero discount — never trust a caller-supplied discount for it.
        discount: priceType === "B_TYPE" ? 0 : (Number.isFinite(input?.discount) ? Number(input?.discount) : 0),
        priceType,
      });

      logger.log({
        module: "billing",
        severity: "INFO",
        operation: "add-line-item",
        deviceId,
        message: `Line item added to voucher ${voucherId}`,
      });

      return { accepted: true, ...result };
    } catch (error) {
      if (isBillGatepassMismatchError(error)) {
        logger.log({ module: "billing", severity: "INFO", operation: "add-line-item", deviceId, message: error.message });
        return {
          accepted: false,
          errorCode: error.code,
          mismatch: error.mismatch,
          gatepassCode: error.gatepassCode,
          line: error.line,
          expectedDozens: error.expectedDozens,
          billedDozens: error.billedDozens,
          reason: error.message,
        };
      }
      if (isDiscountExceedsAllowedError(error)) {
        logger.log({ module: "billing", severity: "INFO", operation: "add-line-item", deviceId, message: error.message });
        return { accepted: false, errorCode: error.code, reason: error.message, ...error.figures };
      }
      logger.log({
        module: "billing",
        severity: "ERROR",
        operation: "add-line-item",
        deviceId,
        message: error instanceof Error ? error.message : "Failed to add line item",
      });
      return { accepted: false, reason: error instanceof Error ? error.message : "Failed to add line item" };
    }
  });

  ipcMain.handle(IPC.deleteVoucherLineItem, (event, itemId?: string) => {
    try {
      authorizer.requirePermission(event, PERMISSION.SALE_VOUCHER_FORM);
      if (typeof itemId !== "string" || !itemId.trim()) {
        return { accepted: false, reason: "Item ID is required" };
      }

      db.deleteVoucherLineItem(itemId);

      logger.log({
        module: "billing",
        severity: "INFO",
        operation: "delete-line-item",
        deviceId,
        message: `Line item deleted: ${itemId}`,
      });

      return { accepted: true };
    } catch (error) {
      if (isBillGatepassMismatchError(error)) {
        logger.log({ module: "billing", severity: "INFO", operation: "delete-line-item", deviceId, message: error.message });
        return {
          accepted: false,
          errorCode: error.code,
          mismatch: error.mismatch,
          gatepassCode: error.gatepassCode,
          line: error.line,
          expectedDozens: error.expectedDozens,
          billedDozens: error.billedDozens,
          reason: error.message,
        };
      }
      logger.log({
        module: "billing",
        severity: "ERROR",
        operation: "delete-line-item",
        deviceId,
        message: error instanceof Error ? error.message : "Failed to delete line item",
      });
      return { accepted: false, reason: error instanceof Error ? error.message : "Failed to delete line item" };
    }
  });

  ipcMain.handle(IPC.updateVoucherLineItem, (event, itemId?: string, input?: Record<string, unknown>) => {
    try {
      authorizer.requirePermission(event, PERMISSION.SALE_VOUCHER_FORM);
      if (typeof itemId !== "string" || !itemId.trim()) {
        return { accepted: false, reason: "Item ID is required" };
      }
      const quantity  = Number.isFinite(input?.quantity)  ? Number(input?.quantity)  : 0;
      const unitPrice = Number.isFinite(input?.unitPrice) ? Number(input?.unitPrice) : 0;
      const discount  = Number.isFinite(input?.discount)  ? Number(input?.discount)  : 0;
      const priceType = input?.priceType === "B_TYPE" ? "B_TYPE" : "NORMAL";
      if (quantity <= 0) {
        return { accepted: false, reason: "Quantity must be greater than 0" };
      }
      db.updateVoucherLineItem(itemId, { quantity, unitPrice, discount, priceType });
      logger.log({
        module: "billing",
        severity: "INFO",
        operation: "update-line-item",
        deviceId,
        message: `Line item updated: ${itemId}`,
      });
      return { accepted: true };
    } catch (error) {
      if (isBillGatepassMismatchError(error)) {
        logger.log({ module: "billing", severity: "INFO", operation: "update-line-item", deviceId, message: error.message });
        return {
          accepted: false,
          errorCode: error.code,
          mismatch: error.mismatch,
          gatepassCode: error.gatepassCode,
          line: error.line,
          expectedDozens: error.expectedDozens,
          billedDozens: error.billedDozens,
          reason: error.message,
        };
      }
      if (isDiscountExceedsAllowedError(error)) {
        logger.log({ module: "billing", severity: "INFO", operation: "update-line-item", deviceId, message: error.message });
        return { accepted: false, errorCode: error.code, reason: error.message, ...error.figures };
      }
      logger.log({
        module: "billing",
        severity: "ERROR",
        operation: "update-line-item",
        deviceId,
        message: error instanceof Error ? error.message : "Failed to update line item",
      });
      return { accepted: false, reason: error instanceof Error ? error.message : "Failed to update line item" };
    }
  });

  ipcMain.handle(IPC.deleteSaleVoucher, (event, voucherId?: string) => {
    try {
      authorizer.requirePermission(event, PERMISSION.SALE_VOUCHER_FORM);
      if (typeof voucherId !== "string" || !voucherId.trim()) {
        return { accepted: false, reason: "Voucher ID is required" };
      }

      const result = db.deleteSaleVoucher(voucherId);

      // The full ambiguous-event id list is logged here for investigation; the renderer only
      // needs the count (see SaleVoucherFormPage/SaleVoucherListPage) — raw internal event ids
      // aren't operationally useful to show an ordinary operator.
      logger.log({
        module: "billing",
        severity: "INFO",
        operation: "delete-voucher",
        deviceId,
        message: `Sale voucher deleted: ${voucherId} (reversed ${result.reversedEventCount}${
          result.ambiguousDispatchEventIds.length
            ? `, ambiguous: ${result.ambiguousDispatchEventIds.join(", ")}`
            : ""
        })`,
      });

      return { accepted: true, ...result };
    } catch (error) {
      logger.log({
        module: "billing",
        severity: "ERROR",
        operation: "delete-voucher",
        deviceId,
        message: error instanceof Error ? error.message : "Failed to delete sale voucher",
      });
      return { accepted: false, reason: error instanceof Error ? error.message : "Failed to delete voucher" };
    }
  });
}
