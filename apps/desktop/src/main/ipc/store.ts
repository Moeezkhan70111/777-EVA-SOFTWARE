// Store station: Move In (receiving) and Move Out (to gate) scans and sessions.
//
// IPC handlers are registered per feature; every write is authorised through ctx.authorizer
// (see ../authorize.ts) and every channel name comes from shared/ipcChannels.ts.

import { ipcMain } from "electron";
import { IPC } from "../../shared/ipcChannels";
import type { IpcContext } from "./context";
import { ACCESS_STATUS, USER_ROLE, asOptionalNumber, asOptionalString, isRecord, optionalOneOf } from "@erp/domain";

export function registerStoreHandlers(ctx: IpcContext): void {
  const { db, logger, scanContext, deviceId, useCases } = ctx;
  const { storeEntryScanUseCase, storeExitScanUseCase, receiveRawMaterialScanUseCase, issueRawMaterialScanUseCase } = useCases;

  // Store entry is authorised at the process boundary, not just in the navbar: the
  // renderer passes its session token and the handler resolves the user from it.
  const STORE_SCANNING_PERMISSION = "store-scanning";

  const resolveStoreOperator = (token?: string): { ok: true; username: string } | { ok: false; reason: string } => {
    const sessionToken = typeof token === "string" ? token.trim() : "";
    const user = sessionToken ? db.getUserBySessionToken(sessionToken) : null;
    if (!user || user.accessStatus !== ACCESS_STATUS.APPROVED) {
      return { ok: false, reason: "Sign in again to use Store Scanning." };
    }
    if (user.role !== USER_ROLE.ADMIN && !user.permissions.includes(STORE_SCANNING_PERMISSION)) {
      return { ok: false, reason: "Your account does not have Store Scanning access." };
    }
    return { ok: true, username: user.username };
  };

  // ─── Raw Material Input ───────────────────────────────────────────────────────
  // A receiving session belongs to one supplier. Every scan is checked against it, so a
  // packet from another supplier cannot be credited to this delivery.

  ipcMain.handle(IPC.startRawMaterialReceivingSession, (_event, partyId?: string, opts?: { token?: string }) => {
    const auth = resolveStoreOperator(opts?.token);
    if (!auth.ok) return { accepted: false, reason: auth.reason };
    try {
      const session = db.startRawMaterialReceivingSession({
        partyId: String(partyId ?? ""),
        deviceId,
        startedBy: auth.username,
      });
      logger.log({
        module: "raw-material-input", severity: "INFO", operation: "session-started", deviceId,
        message: JSON.stringify({ sessionId: session.id, partyId: session.partyId }),
      });
      return { accepted: true, session };
    } catch (error) {
      return { accepted: false, reason: error instanceof Error ? error.message : "The session could not be started." };
    }
  });

  ipcMain.handle(IPC.getOpenRawMaterialReceivingSession, () => db.getOpenRawMaterialReceivingSession(deviceId));

  ipcMain.handle(IPC.closeRawMaterialReceivingSession, (_event, sessionId?: string) => {
    const session = db.closeRawMaterialReceivingSession(String(sessionId ?? ""));
    logger.log({
      module: "raw-material-input", severity: "INFO", operation: "session-closed", deviceId,
      message: JSON.stringify({ sessionId: sessionId ?? null }),
    });
    return session;
  });

  ipcMain.handle(IPC.getRawMaterialReceivingSessionSummary, (_event, sessionId?: string) =>
    db.getRawMaterialReceivingSessionSummary(String(sessionId ?? ""))
  );

  ipcMain.handle(IPC.listRawMaterialReceivingSessions, (_event, filters?: unknown) => {
    const input = isRecord(filters) ? filters : {};
    return db.listRawMaterialReceivingSessions({
      status: optionalOneOf(input.status, ["OPEN", "CLOSED"] as const),
      partyId: asOptionalString(input.partyId),
      dateFrom: asOptionalString(input.dateFrom),
      dateTo: asOptionalString(input.dateTo),
      limit: asOptionalNumber(input.limit),
    });
  });

  ipcMain.handle(
    IPC.rawMaterialReceiptScan,
    async (_event, rawScan?: string, opts?: { token?: string; sessionId?: string; partyId?: string }) => {
      const auth = resolveStoreOperator(opts?.token);
      if (!auth.ok) {
        logger.log({ module: "raw-material-input", severity: "WARNING", operation: "scan-denied", deviceId, message: auth.reason });
        return { accepted: false, outcome: "NOT_AUTHORIZED", reason: auth.reason };
      }

      const normalized = typeof rawScan === "string" ? rawScan.trim().toUpperCase() : "";
      if (!normalized) {
        return { accepted: false, outcome: "INVALID_FORMAT", reason: "Scan value is empty." };
      }

      // The session is the authority on which supplier is being received, not the
      // renderer: the party is read from the stored session, never taken from the call.
      const session = opts?.sessionId ? db.getRawMaterialReceivingSession(String(opts.sessionId)) : null;
      if (!session || session.status !== "OPEN") {
        return { accepted: false, outcome: "INVALID_FORMAT", reason: "Start a receiving session for a supplier first." };
      }

      try {
        const result = await receiveRawMaterialScanUseCase.execute({
          rawScan: normalized,
          partyId: session.partyId,
          sessionId: session.id,
          actor: auth.username,
          context: scanContext,
        });
        logger.log({
          module: "raw-material-input",
          severity: result.accepted ? "INFO" : "WARNING",
          operation: "scan-processed",
          deviceId,
          message: JSON.stringify({ outcome: result.outcome, qrId: result.qrId ?? normalized, sessionId: session.id }),
        });
        return result;
      } catch (error) {
        logger.log({
          module: "raw-material-input", severity: "ERROR", operation: "scan-error", deviceId,
          message: `Raw material receipt error: ${error instanceof Error ? error.message : String(error)}`,
        });
        return { accepted: false, outcome: "ERROR", reason: "The scan could not be saved. Nothing was changed." };
      }
    }
  );

  // ─── Raw Material Output ──────────────────────────────────────────────────────

  ipcMain.handle(IPC.startRawMaterialIssueSession, (_event, opts?: { token?: string; startNew?: boolean }) => {
    const auth = resolveStoreOperator(opts?.token);
    if (!auth.ok) return { accepted: false, reason: auth.reason };
    try {
      const session = db.startOrResumeRawMaterialIssueSession({
        deviceId,
        startedBy: auth.username,
        startNew: Boolean(opts?.startNew),
      });
      return { accepted: true, session };
    } catch (error) {
      return { accepted: false, reason: error instanceof Error ? error.message : "The session could not be started." };
    }
  });

  ipcMain.handle(IPC.closeRawMaterialIssueSession, (_event, sessionId?: string) =>
    db.closeRawMaterialIssueSession(String(sessionId ?? ""))
  );

  ipcMain.handle(IPC.getRawMaterialIssueSessionSummary, (_event, sessionId?: string) =>
    db.getRawMaterialIssueSessionSummary(String(sessionId ?? ""))
  );

  ipcMain.handle(IPC.rawMaterialIssueScan, async (_event, rawScan?: string, opts?: { token?: string; sessionId?: string }) => {
    const auth = resolveStoreOperator(opts?.token);
    if (!auth.ok) {
      logger.log({ module: "raw-material-output", severity: "WARNING", operation: "scan-denied", deviceId, message: auth.reason });
      return { accepted: false, outcome: "NOT_AUTHORIZED", reason: auth.reason };
    }

    const normalized = typeof rawScan === "string" ? rawScan.trim().toUpperCase() : "";
    if (!normalized) return { accepted: false, outcome: "INVALID_FORMAT", reason: "Scan value is empty." };

    const session = opts?.sessionId ? db.getRawMaterialIssueSession(String(opts.sessionId)) : null;
    if (!session || session.status !== "OPEN") {
      return { accepted: false, outcome: "INVALID_FORMAT", reason: "Start an issue session first." };
    }

    try {
      const result = await issueRawMaterialScanUseCase.execute({
        rawScan: normalized,
        sessionId: session.id,
        actor: auth.username,
        context: scanContext,
      });
      logger.log({
        module: "raw-material-output",
        severity: result.accepted ? "INFO" : "WARNING",
        operation: "scan-processed",
        deviceId,
        message: JSON.stringify({ outcome: result.outcome, qrId: result.qrId ?? normalized, sessionId: session.id }),
      });
      return result;
    } catch (error) {
      logger.log({
        module: "raw-material-output", severity: "ERROR", operation: "scan-error", deviceId,
        message: `Raw material issue error: ${error instanceof Error ? error.message : String(error)}`,
      });
      return { accepted: false, outcome: "ERROR", reason: "The scan could not be saved. Nothing was changed." };
    }
  });

  ipcMain.handle(IPC.storeEntryScan, async (_event, rawScan?: string, opts?: { token?: string; sessionId?: string }) => {
    const auth = resolveStoreOperator(opts?.token);
    if (!auth.ok) {
      logger.log({ module: "store-scanning", severity: "WARNING", operation: "store-entry-denied", deviceId, message: auth.reason });
      return { accepted: false, outcome: "NOT_AUTHORIZED", reason: auth.reason };
    }

    const normalized = typeof rawScan === "string" ? rawScan.trim().toUpperCase() : "";
    if (!normalized) {
      logger.log({ module: "store-scanning", severity: "WARNING", operation: "store-entry-empty", deviceId, message: "Scan value is empty" });
      return { accepted: false, outcome: "INVALID_FORMAT", reason: "Scan value is empty." };
    }

    const sessionId = typeof opts?.sessionId === "string" && opts.sessionId.trim() ? opts.sessionId.trim() : undefined;

    try {
      const result = await storeEntryScanUseCase.execute({
        rawScan: normalized,
        sessionId,
        actor: auth.username,
        context: scanContext,
      });

      logger.log({
        module: "store-scanning",
        severity: result.accepted ? "INFO" : "WARNING",
        operation: "store-entry-processed",
        deviceId,
        message: JSON.stringify({ outcome: result.outcome, qrId: result.qrId ?? normalized, sessionId: sessionId ?? null }),
      });

      return result;
    } catch (error) {
      logger.log({
        module: "store-scanning",
        severity: "ERROR",
        operation: "store-entry-error",
        deviceId,
        message: `Store entry error: ${error instanceof Error ? error.message : String(error)}`,
        errorCode: error instanceof Error ? error.constructor.name : "UNKNOWN",
        errorDetails: error instanceof Error ? error.stack : undefined,
      });
      return {
        accepted: false,
        outcome: "ERROR",
        qrId: normalized,
        reason: "The scan could not be saved. Nothing was changed — scan the carton again.",
      };
    }
  });

  ipcMain.handle(IPC.storeReceivingSession, (_event, opts?: { token?: string; startNew?: boolean }) => {
    const auth = resolveStoreOperator(opts?.token);
    if (!auth.ok) return { accepted: false, reason: auth.reason };
    try {
      const session = opts?.startNew
        ? db.startNewStoreReceivingSession({ deviceId, startedBy: auth.username })
        : db.startOrResumeStoreReceivingSession({ deviceId, startedBy: auth.username });
      return { accepted: true, session };
    } catch (error) {
      logger.log({ module: "store-scanning", severity: "ERROR", operation: "store-session", deviceId, message: error instanceof Error ? error.message : String(error) });
      return { accepted: false, reason: error instanceof Error ? error.message : "Could not start a receiving session" };
    }
  });

  ipcMain.handle(IPC.storeReceivingSessionSummary, (_event, sessionId?: string, opts?: { token?: string; recentLimit?: number }) => {
    const auth = resolveStoreOperator(opts?.token);
    if (!auth.ok) return null;
    const id = typeof sessionId === "string" ? sessionId.trim() : "";
    if (!id) return null;
    return db.getStoreReceivingSessionSummary(id, {
      recentLimit: Number.isFinite(opts?.recentLimit) ? Number(opts?.recentLimit) : undefined,
    });
  });

  // Same permission and the same shape as store entry: the token authorises the call, the
  // use case owns the In Store → To Gate transition and, behind it, the reconciliation with
  // whichever open gatepass line the carton's variant is owed to. The station never asks.
  ipcMain.handle(IPC.storeExitScan, async (_event, rawScan?: string, opts?: { token?: string; sessionId?: string; gatepassId?: string }) => {
    const auth = resolveStoreOperator(opts?.token);
    if (!auth.ok) {
      logger.log({ module: "store-scanning", severity: "WARNING", operation: "store-exit-denied", deviceId, message: auth.reason });
      return { accepted: false, outcome: "NOT_AUTHORIZED", reason: auth.reason };
    }

    const normalized = typeof rawScan === "string" ? rawScan.trim().toUpperCase() : "";
    if (!normalized) {
      logger.log({ module: "store-scanning", severity: "WARNING", operation: "store-exit-empty", deviceId, message: "Scan value is empty" });
      return { accepted: false, outcome: "INVALID_FORMAT", reason: "Scan value is empty." };
    }

    const sessionId = typeof opts?.sessionId === "string" && opts.sessionId.trim() ? opts.sessionId.trim() : undefined;
    // Given, the scan is held to that document; omitted, the scanner stays generic.
    const gatepassId = typeof opts?.gatepassId === "string" && opts.gatepassId.trim() ? opts.gatepassId.trim() : undefined;

    try {
      const result = await storeExitScanUseCase.execute({
        rawScan: normalized,
        sessionId,
        gatepassId,
        actor: auth.username,
        context: scanContext,
      });

      logger.log({
        module: "store-scanning",
        severity: result.accepted ? "INFO" : "WARNING",
        operation: "store-exit-processed",
        deviceId,
        message: JSON.stringify({
          outcome: result.outcome,
          qrId: result.qrId ?? normalized,
          sessionId: sessionId ?? null,
          // Which reservation the move-out was counted against, if any — the audit trail of the reconciliation.
          gatepass: result.gatepass ? { code: result.gatepass.code, dispatchedFromStore: result.gatepass.dispatchedFromStore, outstanding: result.gatepass.outstanding } : null,
        }),
      });

      return result;
    } catch (error) {
      logger.log({
        module: "store-scanning",
        severity: "ERROR",
        operation: "store-exit-error",
        deviceId,
        message: `Store exit error: ${error instanceof Error ? error.message : String(error)}`,
        errorCode: error instanceof Error ? error.constructor.name : "UNKNOWN",
        errorDetails: error instanceof Error ? error.stack : undefined,
      });
      return {
        accepted: false,
        outcome: "ERROR",
        qrId: normalized,
        reason: "The scan could not be saved. Nothing was changed — scan the carton again.",
      };
    }
  });

  ipcMain.handle(IPC.storeMoveOutSession, (_event, opts?: { token?: string; startNew?: boolean }) => {
    const auth = resolveStoreOperator(opts?.token);
    if (!auth.ok) return { accepted: false, reason: auth.reason };
    try {
      const session = opts?.startNew
        ? db.startNewStoreMoveOutSession({ deviceId, startedBy: auth.username })
        : db.startOrResumeStoreMoveOutSession({ deviceId, startedBy: auth.username });
      return { accepted: true, session };
    } catch (error) {
      logger.log({ module: "store-scanning", severity: "ERROR", operation: "store-move-out-session", deviceId, message: error instanceof Error ? error.message : String(error) });
      return { accepted: false, reason: error instanceof Error ? error.message : "Could not start a move-out session" };
    }
  });

  ipcMain.handle(IPC.storeMoveOutSessionSummary, (_event, sessionId?: string, opts?: { token?: string; recentLimit?: number }) => {
    const auth = resolveStoreOperator(opts?.token);
    if (!auth.ok) return null;
    const id = typeof sessionId === "string" ? sessionId.trim() : "";
    if (!id) return null;
    return db.getStoreMoveOutSessionSummary(id, {
      recentLimit: Number.isFinite(opts?.recentLimit) ? Number(opts?.recentLimit) : undefined,
    });
  });
}
