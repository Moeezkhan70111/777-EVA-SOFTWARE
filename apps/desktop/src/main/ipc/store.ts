// Store station: Move In (receiving) and Move Out (to gate) scans and sessions.
//
// IPC handlers are registered per feature; every write is authorised through ctx.authorizer
// (see ../authorize.ts) and every channel name comes from shared/ipcChannels.ts.

// Leased channels pass the write gate first (leaseGuard.ts, leaseChannels.ts).
import { ipcMain } from "../leaseGuard";
import { IPC } from "../../shared/ipcChannels";
import type { IpcContext } from "./context";
import { rejection } from "../authorize";
import { parseReconciliationEntries } from "./reconciliationInput";
import { ACCESS_STATUS, PERMISSION, QR_GENERATOR_ACCESS, STORE_DIRECTION, USER_ROLE, asOptionalNumber, asOptionalString, asString, asStringArray, isRecord, optionalOneOf } from "@erp/domain";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function registerStoreHandlers(ctx: IpcContext): void {
  const { db, logger, authorizer, scanContext, deviceId, useCases } = ctx;
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

  // Finds this terminal's open session without starting one: Move Out starts a session only when
  // the operator presses New session for a chosen party (0.3.8).
  ipcMain.handle(IPC.getOpenRawMaterialIssueSession, () => db.getOpenRawMaterialIssueSession(deviceId));

  // Issued today (every computer, as Receipts) and the last session this computer closed. The
  // screen never names a computer: "this computer" is resolved here.
  ipcMain.handle(IPC.listRawMaterialIssueSessions, (_event, filters?: unknown) => {
    const input = isRecord(filters) ? filters : {};
    return db.listRawMaterialIssueSessions({
      status: optionalOneOf(input.status, ["OPEN", "CLOSED"] as const),
      deviceId: input.thisComputerOnly === true ? deviceId : undefined,
      dateFrom: asOptionalString(input.dateFrom),
      dateTo: asOptionalString(input.dateTo),
      limit: asOptionalNumber(input.limit),
    });
  });

  ipcMain.handle(IPC.closeRawMaterialIssueSession, (_event, sessionId?: string) =>
    db.closeRawMaterialIssueSession(String(sessionId ?? ""))
  );

  ipcMain.handle(IPC.getRawMaterialIssueSessionSummary, (_event, sessionId?: string) =>
    db.getRawMaterialIssueSessionSummary(String(sessionId ?? ""))
  );

  ipcMain.handle(IPC.rawMaterialIssueScan, async (_event, rawScan?: string, opts?: { token?: string; sessionId?: string; issuedToPartyId?: string }) => {
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

    // ONE SESSION, ONE PARTY (0.3.8). The screen locks the party once the session starts; this is
    // what holds it, whatever the screen sends. A different party needs a new session.
    const issuedToPartyId = typeof opts?.issuedToPartyId === "string" ? opts.issuedToPartyId : "";
    const sessionPartyId = db.rawMaterialIssueSessionPartyId(session.id);
    if (sessionPartyId !== null && issuedToPartyId !== "" && issuedToPartyId !== sessionPartyId) {
      const party = db.getParty(sessionPartyId);
      return {
        accepted: false,
        outcome: "NO_PARTY",
        reason: `This session's packets go to ${party?.partyName ?? "another party"}. End the session and start a new one to move packets out to someone else. Nothing was moved.`,
      };
    }

    try {
      const result = await issueRawMaterialScanUseCase.execute({
        rawScan: normalized,
        sessionId: session.id,
        // Judged by the use case, never trusted from the screen.
        issuedToPartyId,
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

  // ─── Store Out through an open Machine Program ────────────────────────────────
  // The other way a machine program is consumed, beside the generic scanner above: the
  // storekeeper OPENS MP-000012 and issues against it. Three calls, and not one of them trusts
  // the screen — the lookup is resolved here, every scan is judged here, and Save Batch
  // re-validates the whole batch inside the write lock before anything leaves the store.
  //
  // Authorised exactly as the scans above are: the renderer passes its session token and the
  // handler resolves a Store Scanning operator from it. Hiding a button is not authorisation.

  ipcMain.handle(IPC.openMachineProgramStoreOut, async (_event, lookup?: string, opts?: { token?: string }) => {
    const auth = resolveStoreOperator(opts?.token);
    if (!auth.ok) return { accepted: false, outcome: "NOT_AUTHORIZED", reason: auth.reason };
    try {
      const result = await useCases.machineProgramStoreOut.open.execute({ lookup: String(lookup ?? "") });
      // The program itself is the existing read the Machine Program screens use, so Store Out
      // shows the same authorised quantities, issued and remaining, from one source of truth.
      // It is returned for ANY program that exists — fully issued, deleted or not yet planned —
      // so the store can always see it and print the cartons it is owed. `accepted` still says
      // whether it may be issued against, and every scan and save re-checks that on its own.
      const program = result.programId ? db.getMachineProgram(result.programId) : null;
      logger.log({
        module: "machine-program-store-out", severity: result.accepted ? "INFO" : "WARNING", operation: "open", deviceId,
        message: JSON.stringify({ outcome: result.outcome, programId: result.programId ?? null }),
      });
      return { ...result, program };
    } catch (error) {
      logger.log({
        module: "machine-program-store-out", severity: "ERROR", operation: "open-error", deviceId,
        message: error instanceof Error ? error.message : String(error),
      });
      return { accepted: false, outcome: "ERROR", reason: "The machine program could not be opened. Try again." };
    }
  });

  ipcMain.handle(IPC.machineProgramStoreOutCheckScan, async (_event, input?: unknown, opts?: { token?: string }) => {
    const auth = resolveStoreOperator(opts?.token);
    if (!auth.ok) return { accepted: false, verdict: "NOT_AUTHORIZED", reason: auth.reason };
    const payload = isRecord(input) ? input : {};
    try {
      return await useCases.machineProgramStoreOut.checkScan.execute({
        programId: asString(payload.programId),
        rawScan: asString(payload.rawScan),
        batchQrIds: asStringArray(payload.batchQrIds),
      });
    } catch (error) {
      logger.log({
        module: "machine-program-store-out", severity: "ERROR", operation: "check-scan-error", deviceId,
        message: error instanceof Error ? error.message : String(error),
      });
      return { accepted: false, verdict: "INVALID_FORMAT", reason: "The scan could not be checked. Scan it again." };
    }
  });

  ipcMain.handle(IPC.machineProgramStoreOutSaveBatch, async (_event, input?: unknown, opts?: { token?: string }) => {
    const auth = resolveStoreOperator(opts?.token);
    if (!auth.ok) return { accepted: false, outcome: "NOT_AUTHORIZED", reason: auth.reason };
    const payload = isRecord(input) ? input : {};

    // The batch prints on this terminal's issue slip, so the session is resolved here rather
    // than taken on trust. A closed or unknown session simply leaves the packets unsessioned —
    // it must never stop the stock movement the operator is committing.
    const sessionId = asOptionalString(payload.sessionId);
    const session = sessionId ? db.getRawMaterialIssueSession(sessionId) : null;

    try {
      const result = await useCases.machineProgramStoreOut.saveBatch.execute({
        programId: asString(payload.programId),
        batchKey: asString(payload.batchKey),
        sessionId: session?.status === "OPEN" ? session.id : null,
        qrIds: asStringArray(payload.qrIds),
        context: scanContext,
        actor: auth.username,
        deviceId,
      });
      logger.log({
        module: "machine-program-store-out", severity: result.accepted ? "INFO" : "WARNING", operation: "save-batch", deviceId,
        message: JSON.stringify({
          outcome: result.outcome, programId: result.programId ?? null, batchId: result.batchId ?? null,
          packetCount: result.packetCount ?? 0, refusedQrId: result.refusedQrId ?? null,
        }),
      });
      // The program is re-read after the write, never patched on screen: issued and remaining
      // come back from the event log the batch just added to.
      const program = result.programId ? db.getMachineProgram(result.programId) : null;
      return { ...result, program };
    } catch (error) {
      logger.log({
        module: "machine-program-store-out", severity: "ERROR", operation: "save-batch-error", deviceId,
        message: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error),
      });
      return { accepted: false, outcome: "ERROR", reason: "The batch could not be saved. Nothing was issued — try again." };
    }
  });

  ipcMain.handle(IPC.listMachineProgramIssueBatches, (_event, programId?: string, opts?: { token?: string }) => {
    const auth = resolveStoreOperator(opts?.token);
    if (!auth.ok) return { accepted: false, rows: [] };
    try {
      return { accepted: true, rows: db.listMachineProgramIssueBatches(String(programId ?? "")) };
    } catch (error) {
      logger.log({
        module: "machine-program-store-out", severity: "WARNING", operation: "list-batches", deviceId,
        message: error instanceof Error ? error.message : String(error),
      });
      return { accepted: false, rows: [] };
    }
  });

  // ─── Carton QR labels for the uppers a program has taken out ──────────────────
  // 1 DOZEN of uppers out is 2 cartons coming back. The list is read from the STORE_EXIT events,
  // so it survives closing the program, and the print is recorded against each packet in the
  // same transaction as the carton identities, so the same uppers can never be labelled twice.
  //
  // Printing creates permanent carton identities, so it needs QR Generator on top of Store
  // Scanning — the same permission the QR Generator screen itself demands.

  ipcMain.handle(IPC.listMachineProgramCartonPackets, (_event, programId?: string, opts?: { token?: string }) => {
    const auth = resolveStoreOperator(opts?.token);
    if (!auth.ok) return { accepted: false, reason: auth.reason, rows: [], progress: [], fixRuns: [] };
    try {
      const id = String(programId ?? "");
      // The packets owed labels, per upper line the cartons due back and how many are back, and
      // the FIX runs, whose cartons are owed by the plan because no packet ever leaves for them.
      return {
        accepted: true,
        rows: db.listMachineProgramCartonPackets(id),
        progress: db.listMachineProgramCartonProgress(id),
        fixRuns: db.listMachineProgramFixCartonRuns(id),
      };
    } catch (error) {
      logger.log({
        module: "machine-program-store-out", severity: "WARNING", operation: "list-carton-packets", deviceId,
        message: error instanceof Error ? error.message : String(error),
      });
      return { accepted: false, reason: "The cartons to label could not be loaded. Try again.", rows: [], progress: [], fixRuns: [] };
    }
  });

  ipcMain.handle(IPC.printMachineProgramCartons, (event, input?: unknown, opts?: { token?: string }) => {
    const auth = resolveStoreOperator(opts?.token);
    if (!auth.ok) return { accepted: false, reason: auth.reason };
    const payload = isRecord(input) ? input : {};
    try {
      authorizer.requireAnyPermission(event, QR_GENERATOR_ACCESS, opts?.token);
    } catch {
      return { accepted: false, reason: "Your account does not have QR Generator access, so it cannot print carton QR labels." };
    }
    try {
      // One print button, two kinds of carton: an upper's are owed to the packets that left the
      // store, a FIX article's to the run itself, which never issues anything.
      const runId = asOptionalString(payload.runId) ?? "";
      const printed = runId
        ? db.printMachineProgramFixCartons({ programId: asString(payload.programId), runId, printedBy: auth.username, deviceId })
        : db.printMachineProgramCartons({
            programId: asString(payload.programId),
            eventIds: asStringArray(payload.eventIds),
            printedBy: auth.username,
            deviceId,
          });
      logger.log({
        module: "machine-program-store-out", severity: "INFO", operation: "print-cartons", deviceId,
        message: JSON.stringify({ programId: asString(payload.programId), qrBatchId: printed.batch.id, cartons: printed.qrCodes.length }),
      });
      return { accepted: true, batch: printed.batch, qrCodes: printed.qrCodes };
    } catch (error) {
      // The refusals are written for the operator (already printed, no colour, mixed products).
      return { accepted: false, reason: error instanceof Error ? error.message : "The carton QR labels could not be generated." };
    }
  });

  // Reconciliation for EVR FIX: the labels of a FIX run that did not come back become B cartons.
  // Generating labels needs QR Generator access, exactly as printing them does; which labels are
  // voided is chosen by the data layer inside its write lock, never sent from the screen.
  ipcMain.handle(IPC.convertMachineProgramCartonsToB, (event, input?: unknown, opts?: { token?: string }) => {
    const auth = resolveStoreOperator(opts?.token);
    if (!auth.ok) return { accepted: false, reason: auth.reason };
    const payload = isRecord(input) ? input : {};
    try {
      authorizer.requireAnyPermission(event, QR_GENERATOR_ACCESS, opts?.token);
    } catch {
      return { accepted: false, reason: "Your account does not have QR Generator access, so it cannot generate B carton labels." };
    }
    try {
      const converted = db.convertFixCartonsToB({
        programId: asString(payload.programId),
        runId: asString(payload.runId),
        count: asOptionalNumber(payload.count) ?? Number.NaN,
        convertedBy: auth.username,
        deviceId,
      });
      logger.log({
        module: "machine-program-store-out", severity: "WARNING", operation: "convert-b-cartons", deviceId,
        message: JSON.stringify({ programId: asString(payload.programId), runId: asString(payload.runId), qrBatchId: converted.batch.id, voided: converted.voidedQrIds }),
      });
      return { accepted: true, batch: converted.batch, qrCodes: converted.qrCodes, voidedQrIds: converted.voidedQrIds };
    } catch (error) {
      return { accepted: false, reason: error instanceof Error ? error.message : "The B carton labels could not be generated." };
    }
  });

  // Store In: one carton label of the open program scanned back. The use case refuses a carton
  // printed for another program (or none) and otherwise produces and stores it in, in one
  // transaction — authorised as every other store scan is, from the session token.
  ipcMain.handle(IPC.machineProgramCartonIn, async (_event, input?: unknown, opts?: { token?: string }) => {
    const auth = resolveStoreOperator(opts?.token);
    if (!auth.ok) return { accepted: false, outcome: "NOT_AUTHORIZED", reason: auth.reason };
    const payload = isRecord(input) ? input : {};
    try {
      const result = await useCases.machineProgramCartonIn.execute({
        programId: asString(payload.programId),
        rawScan: asString(payload.rawScan),
        context: scanContext,
        actor: auth.username,
      });
      logger.log({
        module: "machine-program-store-in", severity: result.accepted ? "INFO" : "WARNING", operation: "carton-in", deviceId,
        message: JSON.stringify({ outcome: result.outcome, qrId: result.qrId ?? null, producedNow: result.producedNow ?? false }),
      });
      return result;
    } catch (error) {
      logger.log({
        module: "machine-program-store-in", severity: "ERROR", operation: "carton-in-error", deviceId,
        message: error instanceof Error ? error.message : String(error),
      });
      return { accepted: false, outcome: "ERROR", reason: "The carton could not be received. Nothing was changed — scan it again." };
    }
  });

  // ─── Completing a program: complete, or reconciled ───────────────────────────
  // Store In closes a program against the cartons that came back. All back: COMPLETE. Short: every
  // missing upper is accounted for as cut size, wastage (claimed to the supplier) or lost (claimed
  // to a contractor), each claim with its reason. The shortfall is worked out in the data layer;
  // the screen only says what became of it. Authorised as every store action is, from the token.

  ipcMain.handle(IPC.getMachineProgramReconciliation, (_event, programId?: string, opts?: { token?: string }) => {
    const auth = resolveStoreOperator(opts?.token);
    if (!auth.ok) return { accepted: false, reason: auth.reason };
    try {
      const reconciliation = db.getMachineProgramReconciliation(String(programId ?? ""));
      return reconciliation ? { accepted: true, reconciliation } : { accepted: false, reason: "This machine program no longer exists." };
    } catch (error) {
      logger.log({
        module: "machine-program-store-in", severity: "WARNING", operation: "reconciliation", deviceId,
        message: error instanceof Error ? error.message : String(error),
      });
      return { accepted: false, reason: "The program's cartons could not be counted. Try again." };
    }
  });

  ipcMain.handle(IPC.completeMachineProgramProduction, (_event, input?: unknown, opts?: { token?: string }) => {
    const auth = resolveStoreOperator(opts?.token);
    if (!auth.ok) return { accepted: false, reason: auth.reason };
    const payload = isRecord(input) ? input : {};
    const entries = parseReconciliationEntries(payload.entries);
    if (typeof entries === "string") return { accepted: false, reason: entries };
    try {
      const closure = db.completeMachineProgramProduction({
        programId: asString(payload.programId), entries, closedBy: auth.username, deviceId,
      });
      logger.log({
        module: "machine-program-store-in", severity: "INFO", operation: "complete-program", deviceId,
        message: JSON.stringify({ programId: asString(payload.programId), outcome: closure.outcome, due: closure.cartonsDue, back: closure.cartonsBack }),
      });
      return { accepted: true, closure };
    } catch (error) {
      // The refusals are written for the operator: what is still unaccounted for, a missing reason.
      return { accepted: false, reason: error instanceof Error ? error.message : "The program could not be completed." };
    }
  });

  // RETURN UPPER — a sealed packet scanned back in a program's reconciliation. The program and
  // the packet's eligibility are judged by the use case, inside its transaction.
  ipcMain.handle(IPC.returnMachineProgramUpper, async (_event, input?: unknown, opts?: { token?: string }) => {
    const auth = resolveStoreOperator(opts?.token);
    if (!auth.ok) return { accepted: false, outcome: "NOT_ELIGIBLE", reason: auth.reason };
    const payload = isRecord(input) ? input : {};
    try {
      const result = await useCases.machineProgramUpperReturn.execute({
        programId: asString(payload.programId), rawScan: asString(payload.rawScan), context: scanContext, actor: auth.username,
      });
      logger.log({
        module: "machine-program-store-in", severity: result.accepted ? "INFO" : "WARNING", operation: "return-upper", deviceId,
        message: JSON.stringify({ programId: asString(payload.programId), outcome: result.outcome, qrId: result.qrId }),
      });
      return result;
    } catch (error) {
      logger.log({ module: "machine-program-store-in", severity: "ERROR", operation: "return-upper", deviceId, message: error instanceof Error ? error.message : String(error) });
      return { accepted: false, outcome: "ERROR", reason: "The packet could not be returned. Nothing was changed." };
    }
  });

  // B cartons of an UPPER line: generating labels needs QR Generator access, as printing them does.
  // Which labels are voided is chosen by the data layer inside its write lock.
  ipcMain.handle(IPC.convertMachineProgramUpperCartonsToB, (event, input?: unknown, opts?: { token?: string }) => {
    const auth = resolveStoreOperator(opts?.token);
    if (!auth.ok) return { accepted: false, reason: auth.reason };
    const payload = isRecord(input) ? input : {};
    try {
      authorizer.requireAnyPermission(event, QR_GENERATOR_ACCESS, opts?.token);
    } catch {
      return { accepted: false, reason: "Your account does not have QR Generator access, so it cannot generate B carton labels." };
    }
    try {
      const converted = db.convertUpperCartonsToB({
        programId: asString(payload.programId), lineId: asString(payload.lineId), count: asOptionalNumber(payload.count) ?? Number.NaN,
        convertedBy: auth.username, deviceId,
      });
      logger.log({
        module: "machine-program-store-in", severity: "WARNING", operation: "convert-upper-b-cartons", deviceId,
        message: JSON.stringify({ programId: asString(payload.programId), lineId: asString(payload.lineId), qrBatchId: converted.batch.id, voided: converted.voidedQrIds }),
      });
      return { accepted: true, batch: converted.batch, qrCodes: converted.qrCodes, voidedQrIds: converted.voidedQrIds };
    } catch (error) {
      return { accepted: false, reason: error instanceof Error ? error.message : "The B carton labels could not be generated." };
    }
  });

  // ─── Dana issued FOR a machine program ────────────────────────────────────────
  // The sole's own material. A program never reserved it, so there is no allocation to consume
  // here — only "this program runs these sole colours, and these bags went out for it today".
  //
  // The movement itself is moveRawMaterialByHand, the one path a typed quantity leaves the raw
  // material store by, so Dana Issue inherits its rules: a Dana with LABELLED PACKETS in the
  // store is refused here and must be scanned out instead.

  ipcMain.handle(IPC.listMachineProgramDanaOptions, (_event, programId?: string, opts?: { token?: string }) => {
    const auth = resolveStoreOperator(opts?.token);
    if (!auth.ok) return { accepted: false, rows: [] };
    try {
      return { accepted: true, rows: db.listMachineProgramDanaOptions(String(programId ?? "")) };
    } catch (error) {
      logger.log({
        module: "machine-program-dana", severity: "WARNING", operation: "list-options", deviceId,
        message: error instanceof Error ? error.message : String(error),
      });
      return { accepted: false, rows: [] };
    }
  });

  ipcMain.handle(IPC.issueMachineProgramDana, (_event, input?: unknown, opts?: { token?: string }) => {
    const auth = resolveStoreOperator(opts?.token);
    if (!auth.ok) return { accepted: false, outcome: "NOT_AUTHORIZED", reason: auth.reason };
    const payload = isRecord(input) ? input : {};
    try {
      const result = db.issueMachineProgramDana({
        programId: asString(payload.programId),
        itemId: asString(payload.itemId),
        // Deliberately NOT coerced: an empty box must reach the rule as something it refuses,
        // never silently become 0.
        quantity: typeof payload.quantity === "number" ? payload.quantity : Number.NaN,
        unitCode: asString(payload.unitCode),
        actor: auth.username,
      });
      logger.log({
        module: "machine-program-dana", severity: result.accepted ? "INFO" : "WARNING", operation: "issue", deviceId,
        message: JSON.stringify({
          outcome: result.outcome, programId: asString(payload.programId), itemId: asString(payload.itemId),
          reason: result.reason ?? null,
        }),
      });
      return result;
    } catch (error) {
      logger.log({
        module: "machine-program-dana", severity: "ERROR", operation: "issue-error", deviceId,
        message: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error),
      });
      return { accepted: false, outcome: "ERROR", reason: "The Dana could not be issued. Nothing was changed — try again." };
    }
  });

  ipcMain.handle(IPC.listMachineProgramDanaIssues, (_event, programId?: string, opts?: { token?: string }) => {
    const auth = resolveStoreOperator(opts?.token);
    if (!auth.ok) return { accepted: false, rows: [] };
    try {
      return { accepted: true, rows: db.listMachineProgramDanaIssues(String(programId ?? "")) };
    } catch {
      return { accepted: false, rows: [] };
    }
  });

  // ─── Moving raw material out BY HAND ──────────────────────────────────────────
  // Loose stock — nawaar off a roll — carries no label, so the only way out is to say what
  // went. The quantity may be typed on any rung of the material's own ladder; the data layer
  // converts it, refuses a material that still has labelled packets, and refuses a figure the
  // shelf cannot cover. The screen checks the same things, but this is what enforces them.

  ipcMain.handle(IPC.getRawMaterialHandMoveOptions, (_event, itemId?: string, direction?: string, opts?: { token?: string }) => {
    const auth = resolveStoreOperator(opts?.token);
    if (!auth.ok) return null;
    return db.getRawMaterialHandMoveOptions(String(itemId ?? ""), direction === "IN" ? "IN" : "OUT");
  });

  ipcMain.handle(IPC.moveRawMaterialByHand, (_event, input?: Record<string, unknown>, opts?: { token?: string }) => {
    const auth = resolveStoreOperator(opts?.token);
    if (!auth.ok) return { accepted: false, outcome: "NOT_AUTHORIZED", reason: auth.reason };
    if (!isRecord(input)) return { accepted: false, outcome: "INVALID_QUANTITY", reason: "Nothing to move." };

    try {
      const result = db.moveRawMaterialByHand({
        itemId: asOptionalString(input.itemId) ?? "",
        direction: asOptionalString(input.direction) === "IN" ? "IN" : "OUT",
        quantity: Number(input.quantity),
        unitCode: asOptionalString(input.unitCode) ?? "",
        partyId: asOptionalString(input.partyId) ?? null,
        note: asOptionalString(input.note) ?? null,
        actor: auth.username,
      });
      logger.log({
        module: "raw-material-output",
        severity: result.accepted ? "INFO" : "WARNING",
        operation: "hand-move",
        deviceId,
        message: JSON.stringify({ outcome: result.outcome, itemId: asOptionalString(input.itemId) ?? "", quantity: result.quantity }),
      });
      return result;
    } catch (error) {
      logger.log({
        module: "raw-material-output", severity: "ERROR", operation: "hand-move-error", deviceId,
        message: error instanceof Error ? error.message : String(error),
      });
      return { accepted: false, outcome: "NOT_ENOUGH_STOCK", reason: "The move could not be saved. Nothing was changed." };
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

  // ─── Daily Report ─────────────────────────────────────────────────────────────
  // One business day of Store In or Store Out: every packet scanned, every quantity typed, every
  // carton. Read-only, and open to whoever works the store — the same permission as the station.

  ipcMain.handle(IPC.getStoreDailyReport, (event, query?: unknown) => {
    try {
      const input = isRecord(query) ? query : {};
      authorizer.requirePermission(event, PERMISSION.STORE_SCANNING, input.token);
      const date = typeof input.date === "string" && ISO_DATE.test(input.date) ? input.date : null;
      const direction = optionalOneOf(input.direction, Object.values(STORE_DIRECTION));
      if (!date || !direction) return { accepted: false, reason: "Choose a valid date." };
      const report = db.getStoreDailyReport(date, direction);
      return report ? { accepted: true, report } : { accepted: false, reason: "Choose a valid date." };
    } catch (error) {
      return rejection(error, "Could not load the daily report");
    }
  });
}
