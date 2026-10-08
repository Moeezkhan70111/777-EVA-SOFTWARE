// Dashboard, stock list, production history and reports.
//
// IPC handlers are registered per feature; every write is authorised through ctx.authorizer
// (see ../authorize.ts) and every channel name comes from shared/ipcChannels.ts.

import { ipcMain } from "electron";
import { IPC } from "../../shared/ipcChannels";
import type { IpcContext } from "./context";
import { REPORT_RANGE, asOptionalString, asString, oneOf } from "@erp/domain";
import type { ReportRange } from "@erp/domain";
import { historyQuery } from "./context";

export function registerReportsHandlers(ctx: IpcContext): void {
  const { db, deviceId, useCases } = ctx;
  const { processScanUseCase, dispatchScanUseCase, returnScanUseCase, storeEntryScanUseCase, storeExitScanUseCase, createGatepassUseCase, cancelGatepassUseCase } = useCases;

  ipcMain.handle(IPC.getDashboard, () => {
    db.updateDeviceHeartbeat(deviceId);
    return db.getDashboardSnapshot();
  });

  ipcMain.handle(IPC.listInventory, (_event, search?: string) => db.listInventory(search ?? ""));

  ipcMain.handle(IPC.listHistory, (_event, query?: Record<string, unknown>) => db.listHistory(historyQuery(query)));

  ipcMain.handle(IPC.getReport, (_event, query?: Record<string, unknown>) => {
    const range: ReportRange = oneOf(query?.range, Object.values(REPORT_RANGE), REPORT_RANGE.DAILY);
    const fromDate = asOptionalString(query?.fromDate);
    const toDate = asOptionalString(query?.toDate);
    const eventType = asString(query?.eventType, "PRODUCED") || "PRODUCED";
    return db.getReport(range, fromDate, toDate, eventType);
  });
}
