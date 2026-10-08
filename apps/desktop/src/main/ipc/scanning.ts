// Production / dispatch / return scan stations and dispatch sessions.
//
// IPC handlers are registered per feature; every write is authorised through ctx.authorizer
// (see ../authorize.ts) and every channel name comes from shared/ipcChannels.ts.

import { ipcMain } from "electron";
import { IPC } from "../../shared/ipcChannels";
import type { IpcContext } from "./context";
import { PERMISSION, QR_STATUS } from "@erp/domain";
import { historyQuery } from "./context";
import { rejection } from "../authorize";

export function registerScanningHandlers(ctx: IpcContext): void {
  const { db, logger, authorizer, scanContext, deviceId, useCases } = ctx;
  const { processScanUseCase, dispatchScanUseCase, returnScanUseCase } = useCases;

  // Scanner stations: the operator's permission is checked here, at the process boundary,
  // and the answer keeps the `{ accepted, reason }` shape the scan screens display.
  const scanOperator = (event: Electron.IpcMainInvokeEvent, permission: typeof PERMISSION.LIVE_PRODUCTION | typeof PERMISSION.LIVE_DISPATCH | typeof PERMISSION.LIVE_RETURN) => {
    try {
      return { ok: true as const, user: authorizer.requirePermission(event,permission) };
    } catch (error) {
      return { ok: false as const, ...rejection(error, "Not authorised to scan") };
    }
  };

  ipcMain.handle(IPC.processScan, async (event, rawScan?: string) => {
    const operator = scanOperator(event, PERMISSION.LIVE_PRODUCTION);
    if (!operator.ok) return { accepted: false, reason: operator.reason };

    const normalized = typeof rawScan === "string" ? rawScan.trim().toUpperCase() : "";
    if (!normalized) {
      logger.log({
        module: "scanner",
        severity: "WARNING",
        operation: "scan-empty",
        deviceId,
        message: "Scan value is empty"
      });
      return { accepted: false, reason: "Scan value is empty." };
    }

    // NOTE: the signed-in user is not passed as operatorId — production_events.operator_id
    // references the `operators` table, which app users are not part of (pre-existing).
    const result = await processScanUseCase.execute({
      rawScan: normalized,
      context: scanContext,
    });

    logger.log({
      module: "scanner",
      severity: (result as { accepted?: boolean }).accepted ? "INFO" : "WARNING",
      operation: "scan-processed",
      deviceId,
      message: JSON.stringify(result)
    });

    return result;
  });

  ipcMain.handle(IPC.dispatchScan, async (event, rawScan?: string, sessionId?: string, gatepassId?: string) => {
    const operator = scanOperator(event, PERMISSION.LIVE_DISPATCH);
    if (!operator.ok) return { accepted: false, reason: operator.reason };

    const normalized = typeof rawScan === "string" ? rawScan.trim().toUpperCase() : "";
    if (!normalized) {
      logger.log({
        module: "dispatch",
        severity: "WARNING",
        operation: "dispatch-empty",
        deviceId,
        message: "Dispatch scan value is empty",
      });
      return { accepted: false, reason: "Scan value is empty." };
    }

    const activeSessionId = typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : undefined;

    // Re-dispatch after a return is decided by the use case from qr_master.current_status
    // (RETURNED is dispatchable); no in-memory return list is consulted.
    const result = await dispatchScanUseCase.execute({
      rawScan: normalized,
      sessionId: activeSessionId,
      // Given, the Gatepass is the allow-list and the carton is held to its colour too.
      gatepassId: typeof gatepassId === "string" && gatepassId.trim() ? gatepassId.trim() : undefined,
      context: scanContext,
    });

    logger.log({
      module: "dispatch",
      severity: (result as { accepted?: boolean }).accepted ? "INFO" : "WARNING",
      operation: "dispatch-processed",
      deviceId,
      message: JSON.stringify(result),
    });

    return result;
  });

  // Read-only preview: what the Return screen shows before the operator confirms. It writes
  // nothing, so a mis-scan costs nothing — the party and bill come from the carton's own
  // dispatch, never from anything the operator picks.
  ipcMain.handle(IPC.returnLookup, async (event, rawScan?: string) => {
    const operator = scanOperator(event, PERMISSION.LIVE_RETURN);
    if (!operator.ok) return { accepted: false, outcome: "INVALID_FORMAT", reason: operator.reason };

    const normalized = typeof rawScan === "string" ? rawScan.trim().toUpperCase() : "";
    if (!normalized) {
      return { accepted: false, outcome: "INVALID_FORMAT", reason: "Scan value is empty." };
    }

    try {
      return await returnScanUseCase.lookup({ rawScan: normalized });
    } catch (error) {
      logger.log({
        module: "return",
        severity: "ERROR",
        operation: "return-lookup-error",
        deviceId,
        message: `Return lookup error: ${error instanceof Error ? error.message : String(error)}`,
        errorCode: error instanceof Error ? error.constructor.name : "UNKNOWN",
        errorDetails: error instanceof Error ? error.stack : undefined,
      });
      return {
        accepted: false,
        outcome: "INVALID_FORMAT",
        reason: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  ipcMain.handle(IPC.returnScan, async (event, rawScan?: string) => {
    const operator = scanOperator(event, PERMISSION.LIVE_RETURN);
    if (!operator.ok) return { accepted: false, reason: operator.reason };

    const normalized = typeof rawScan === "string" ? rawScan.trim().toUpperCase() : "";
    if (!normalized) {
      logger.log({
        module: "return",
        severity: "WARNING",
        operation: "return-empty",
        deviceId,
        message: "Return scan value is empty",
      });
      return { accepted: false, reason: "Scan value is empty." };
    }

    try {
      const result = await returnScanUseCase.execute({
        rawScan: normalized,
        context: scanContext,
        actor: operator.user.username,
      });

      logger.log({
        module: "return",
        severity: (result as { accepted?: boolean }).accepted ? "INFO" : "WARNING",
        operation: "return-processed",
        deviceId,
        message: JSON.stringify(result),
      });

      return result;
    } catch (error) {
      logger.log({
        module: "return",
        severity: "ERROR",
        operation: "return-error",
        deviceId,
        message: `Return scan error: ${error instanceof Error ? error.message : String(error)}`,
        errorCode: error instanceof Error ? error.constructor.name : "UNKNOWN",
        errorDetails: error instanceof Error ? error.stack : undefined,
      });

      // Return a generic error response
      return {
        accepted: false,
        reason: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  ipcMain.handle(IPC.listDispatchHistory, (_event, query?: Record<string, unknown>) =>
    db.listDispatchHistory(historyQuery(query))
  );

  ipcMain.handle(IPC.listDispatchSessions, (_event, filter?: Record<string, unknown>) => {
    try {
      return db.listDispatchSessions({
        status: typeof filter?.status === "string" ? filter.status : "PENDING",
      });
    } catch (error) {
      logger.log({
        module: "dispatch",
        severity: "ERROR",
        operation: "list-dispatch-sessions",
        deviceId,
        message: error instanceof Error ? error.message : "Failed to list dispatch sessions",
      });
      return [];
    }
  });

  ipcMain.handle(IPC.getDispatchSession, (_event, sessionId?: string) => {
    const id = typeof sessionId === "string" ? sessionId.trim() : "";
    if (!id) return null;
    try {
      return db.getDispatchSession(id);
    } catch (error) {
      logger.log({
        module: "dispatch",
        severity: "ERROR",
        operation: "get-dispatch-session",
        deviceId,
        message: error instanceof Error ? error.message : "Failed to get dispatch session",
      });
      return null;
    }
  });

  // Current lifecycle position of one unit, read from the QR registry (indexed lookup) —
  // never by scanning the whole dispatch history.
  ipcMain.handle(IPC.getItemStatus, (_event, qrId?: string) => {
    const normalized = typeof qrId === "string" ? qrId.trim().toUpperCase() : "";
    if (!normalized) {
      return { qrId: normalized, wasDispatched: false, wasReturned: false };
    }
    const detail = db.getQrDetail(normalized);
    return {
      qrId: normalized,
      wasDispatched: detail?.stage === QR_STATUS.DISPATCHED,
      wasReturned: detail?.stage === QR_STATUS.RETURNED,
    };
  });
}
