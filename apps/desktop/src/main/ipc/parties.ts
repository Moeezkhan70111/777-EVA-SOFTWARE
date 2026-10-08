// Party master, customer ledger and customer balances.
//
// IPC handlers are registered per feature; every write is authorised through ctx.authorizer
// (see ../authorize.ts) and every channel name comes from shared/ipcChannels.ts.

import { ipcMain } from "electron";
import { IPC } from "../../shared/ipcChannels";
import type { IpcContext } from "./context";
import { PERMISSION } from "@erp/domain";

export function registerPartiesHandlers(ctx: IpcContext): void {
  const { db, logger, authorizer, deviceId, useCases } = ctx;
  const { processScanUseCase, dispatchScanUseCase, returnScanUseCase, storeEntryScanUseCase, storeExitScanUseCase, createGatepassUseCase, cancelGatepassUseCase } = useCases;

  ipcMain.handle(IPC.listPartyGroups, () => {
    try {
      return db.listPartyGroups();
    } catch (error) {
      logger.log({
        module: "party",
        severity: "ERROR",
        operation: "list-groups",
        deviceId,
        message: error instanceof Error ? error.message : "Failed to list party groups",
      });
      return [];
    }
  });

  ipcMain.handle(IPC.createPartyGroup, (event, input?: Record<string, unknown>) => {
    try {
      authorizer.requirePermission(event, PERMISSION.PARTY_FORM);
      const groupName = typeof input?.groupName === "string" ? input.groupName.trim() : "";
      if (!groupName) {
        return { accepted: false, reason: "Group name is required" };
      }

      const existing = db.getPartyGroupByName(groupName);
      if (existing) {
        return { accepted: false, reason: "Group with this name already exists" };
      }

      const groupId = db.createPartyGroup({
        groupName,
        description: typeof input?.description === "string" ? input.description : undefined,
      });

      logger.log({
        module: "party",
        severity: "INFO",
        operation: "create-group",
        deviceId,
        message: `Party group created: ${groupName}`,
      });

      return { accepted: true, groupId };
    } catch (error) {
      logger.log({
        module: "party",
        severity: "ERROR",
        operation: "create-group",
        deviceId,
        message: error instanceof Error ? error.message : "Failed to create party group",
      });
      return { accepted: false, reason: error instanceof Error ? error.message : "Failed to create group" };
    }
  });

  ipcMain.handle(IPC.listParties, (_event, query?: Record<string, unknown>) => {
    try {
      return db.listParties({
        search: typeof query?.search === "string" ? query.search : "",
        city: typeof query?.city === "string" ? query.city : undefined,
        groupId: typeof query?.groupId === "string" ? query.groupId : undefined,
        status: typeof query?.status === "string" ? query.status : undefined,
        partyType: typeof query?.partyType === "string" ? query.partyType : undefined,
        page: Number.isFinite(query?.page) ? Number(query?.page) : 1,
        pageSize: Number.isFinite(query?.pageSize) ? Number(query?.pageSize) : 20,
        sortBy: typeof query?.sortBy === "string" ? query.sortBy : "created_at",
        sortOrder: query?.sortOrder === "ASC" ? "ASC" : "DESC",
      });
    } catch (error) {
      logger.log({
        module: "party",
        severity: "ERROR",
        operation: "list-parties",
        deviceId,
        message: error instanceof Error ? error.message : "Failed to list parties",
      });
      return { rows: [], total: 0, page: 1, pageSize: 20 };
    }
  });

  ipcMain.handle(IPC.getParty, (_event, partyId?: string) => {
    try {
      if (typeof partyId !== "string" || !partyId.trim()) {
        return null;
      }
      return db.getParty(partyId);
    } catch (error) {
      logger.log({
        module: "party",
        severity: "ERROR",
        operation: "get-party",
        deviceId,
        message: error instanceof Error ? error.message : "Failed to get party",
      });
      return null;
    }
  });

  ipcMain.handle(IPC.getNextPartyCode, () => db.getNextPartyCode());

  ipcMain.handle(IPC.getNextProductCode, () => db.getNextProductCode());

  ipcMain.handle(IPC.getCurrentPartyBalance, (_event, partyId?: string) => {
    if (typeof partyId !== "string" || !partyId.trim()) return 0;
    return db.getCurrentPartyBalance(partyId);
  });

  ipcMain.handle(IPC.createParty, (event, input?: Record<string, unknown>) => {
    try {
      authorizer.requirePermission(event, PERMISSION.PARTY_FORM);
      const partyName = typeof input?.partyName === "string" ? input.partyName.trim() : "";
      if (!partyName) {
        return { accepted: false, reason: "Party name is required" };
      }

      const partyId = db.createParty({
        partyName,
        partyNameUrdu: typeof input?.partyNameUrdu === "string" ? input.partyNameUrdu : undefined,
        partyType: typeof input?.partyType === "string" ? input.partyType : "CUSTOMER",
        contactPerson: typeof input?.contactPerson === "string" ? input.contactPerson : undefined,
        mobileNumber: typeof input?.mobileNumber === "string" ? input.mobileNumber : undefined,
        whatsAppNumber: typeof input?.whatsAppNumber === "string" ? input.whatsAppNumber : undefined,
        phoneNumber: typeof input?.phoneNumber === "string" ? input.phoneNumber : undefined,
        email: typeof input?.email === "string" ? input.email : undefined,
        address: typeof input?.address === "string" ? input.address : undefined,
        city: typeof input?.city === "string" ? input.city : undefined,
        partyGroupId: typeof input?.partyGroupId === "string" && input.partyGroupId.trim() ? input.partyGroupId : undefined,
        remarks: typeof input?.remarks === "string" ? input.remarks : undefined,
        status: typeof input?.status === "string" ? input.status : "ACTIVE",
        balanceLimit: typeof input?.balanceLimit === "number" ? input.balanceLimit : (input?.balanceLimit == null ? null : undefined),
      });

      logger.log({
        module: "party",
        severity: "INFO",
        operation: "create-party",
        deviceId,
        message: `Party created: ${partyName} (ID: ${partyId})`,
      });

      const createdParty = db.getParty(partyId) as { partyCode?: string } | null;
      return { accepted: true, partyId, partyCode: createdParty?.partyCode };
    } catch (error) {
      logger.log({
        module: "party",
        severity: "ERROR",
        operation: "create-party",
        deviceId,
        message: error instanceof Error ? error.message : "Failed to create party",
      });
      return { accepted: false, reason: error instanceof Error ? error.message : "Failed to create party" };
    }
  });

  ipcMain.handle(IPC.updateParty, (event, input?: Record<string, unknown>) => {
    try {
      authorizer.requirePermission(event, PERMISSION.PARTY_FORM);
      const partyId = typeof input?.id === "string" ? input.id : "";
      if (!partyId) {
        return { accepted: false, reason: "Party ID is required" };
      }

      const existing = db.getParty(partyId);
      if (!existing) {
        return { accepted: false, reason: "Party not found" };
      }

      db.updateParty(partyId, {
        partyName: typeof input?.partyName === "string" ? input.partyName : undefined,
        partyNameUrdu: typeof input?.partyNameUrdu === "string" ? input.partyNameUrdu : undefined,
        contactPerson: typeof input?.contactPerson === "string" ? input.contactPerson : undefined,
        mobileNumber: typeof input?.mobileNumber === "string" ? input.mobileNumber : undefined,
        whatsAppNumber: typeof input?.whatsAppNumber === "string" ? input.whatsAppNumber : undefined,
        phoneNumber: typeof input?.phoneNumber === "string" ? input.phoneNumber : undefined,
        email: typeof input?.email === "string" ? input.email : undefined,
        address: typeof input?.address === "string" ? input.address : undefined,
        city: typeof input?.city === "string" ? input.city : undefined,
        partyGroupId: typeof input?.partyGroupId === "string" && input.partyGroupId.trim() ? input.partyGroupId : undefined,
        remarks: typeof input?.remarks === "string" ? input.remarks : undefined,
        status: typeof input?.status === "string" ? input.status : undefined,
        balanceLimit: "balanceLimit" in (input ?? {})
          ? (typeof input?.balanceLimit === "number" ? input.balanceLimit : null)
          : undefined,
      });

      logger.log({
        module: "party",
        severity: "INFO",
        operation: "update-party",
        deviceId,
        message: `Party updated: ${partyId}`,
      });

      return { accepted: true };
    } catch (error) {
      logger.log({
        module: "party",
        severity: "ERROR",
        operation: "update-party",
        deviceId,
        message: error instanceof Error ? error.message : "Failed to update party",
      });
      return { accepted: false, reason: error instanceof Error ? error.message : "Failed to update party" };
    }
  });

  ipcMain.handle(IPC.deleteParty, (event, partyId?: string) => {
    try {
      authorizer.requirePermission(event, PERMISSION.PARTY_FORM);
      if (typeof partyId !== "string" || !partyId.trim()) {
        return { accepted: false, reason: "Party ID is required" };
      }
      const existing = db.getParty(partyId);
      if (!existing) {
        return { accepted: false, reason: "Party not found" };
      }
      db.deleteParty(partyId);
      logger.log({
        module: "party",
        severity: "INFO",
        operation: "delete-party",
        deviceId,
        message: `Party deleted: ${partyId}`,
      });
      return { accepted: true };
    } catch (error) {
      logger.log({
        module: "party",
        severity: "ERROR",
        operation: "delete-party",
        deviceId,
        message: error instanceof Error ? error.message : "Failed to delete party",
      });
      return { accepted: false, reason: error instanceof Error ? error.message : "Failed to delete party" };
    }
  });

  ipcMain.handle(IPC.getCustomerLedger, (_event, partyId?: string, query?: Record<string, unknown>) => {
    try {
      if (typeof partyId !== "string" || !partyId.trim()) {
        return { partyId: "", partyName: "", entries: [] };
      }
      return db.getCustomerLedger(partyId, {
        fromDate: typeof query?.fromDate === "string" ? query.fromDate : undefined,
        toDate: typeof query?.toDate === "string" ? query.toDate : undefined,
      });
    } catch (error) {
      logger.log({
        module: "party",
        severity: "ERROR",
        operation: "get-customer-ledger",
        deviceId,
        message: error instanceof Error ? error.message : "Failed to get customer ledger",
      });
      return { partyId: "", partyName: "", entries: [] };
    }
  });

  ipcMain.handle(IPC.listCustomerBalances, (_event, query?: Record<string, unknown>) => {
    try {
      return db.listCustomerBalances({
        asOfDate: typeof query?.asOfDate === "string" ? query.asOfDate : undefined,
      });
    } catch (error) {
      logger.log({
        module: "party",
        severity: "ERROR",
        operation: "list-customer-balances",
        deviceId,
        message: error instanceof Error ? error.message : "Failed to list customer balances",
      });
      return { rows: [], total: 0 };
    }
  });

  ipcMain.handle(IPC.listCities, () => {
    try {
      return db.listCities();
    } catch (error) {
      logger.log({
        module: "party",
        severity: "ERROR",
        operation: "list-cities",
        deviceId,
        message: error instanceof Error ? error.message : "Failed to list cities",
      });
      return [];
    }
  });
}
