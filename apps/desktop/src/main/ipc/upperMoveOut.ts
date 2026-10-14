// Upper Move Out (Phase 3): issuing upper packets out of the store to a named machine, the issues
// per machine and day, and the upper stock in the store.
//
// IPC handlers are registered per feature; every call is authorised through ctx.authorizer
// (see ../authorize.ts) and every channel name comes from shared/ipcChannels.ts.
//
// Issuing is a store movement, so it sits behind the same permissions as Raw Material Output — the
// store operator's, or Raw Material Output's own. Hiding the tab is not authorisation: each call
// checks again. The machine and the scan arrive here from the screen, and nothing about either is
// trusted — the use case reads both from the database inside the write lock.

import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { IPC } from "../../shared/ipcChannels";
import type { IpcContext } from "./context";
import { PERMISSION, UPPER_ISSUE_OUTCOME, asRecord, asString } from "@erp/domain";
import { rejection } from "../authorize";

const ISSUE_PERMISSIONS = [PERMISSION.STORE_SCANNING, PERMISSION.RAW_MATERIAL_OUTPUT] as const;

export function registerUpperMoveOutHandlers(ctx: IpcContext): void {
  const { db, logger, authorizer, scanContext, deviceId, useCases } = ctx;
  const { upperMoveOutUseCase } = useCases;

  const log = (severity: "INFO" | "WARNING" | "ERROR", operation: string, message: string, userId?: string) =>
    logger.log({ module: "upper-move-out", severity, operation, deviceId, userId, message });

  const operator = (event: IpcMainInvokeEvent) => {
    try {
      return { ok: true as const, user: authorizer.requireAnyPermission(event, ISSUE_PERMISSIONS) };
    } catch (error) {
      return { ok: false as const, ...rejection(error, "Your account cannot issue uppers.") };
    }
  };

  ipcMain.handle(IPC.issueUpperToMachine, async (event, rawScan?: unknown, machineId?: unknown) => {
    const who = operator(event);
    if (!who.ok) return { accepted: false, outcome: UPPER_ISSUE_OUTCOME.ERROR, reason: who.reason };
    try {
      // The device's Raw Material Output issue session — the existing session, reused, not a new kind.
      const session = db.startOrResumeRawMaterialIssueSession({ deviceId, startedBy: who.user.username });
      const result = await upperMoveOutUseCase.execute({
        rawScan: typeof rawScan === "string" ? rawScan : "",
        machineId: asString(machineId),
        sessionId: session.id,
        context: scanContext,
        actor: who.user.username,
      });
      log(result.accepted ? "INFO" : "WARNING", "issue", JSON.stringify({ outcome: result.outcome, qrId: result.qrId ?? null, machineId: asString(machineId) }), who.user.id);
      // The issue as the database now holds it — for ALREADY_ISSUED, the earlier one.
      return { ...result, issue: result.qrId ? db.findUpperIssue(result.qrId) : null };
    } catch (error) {
      log("ERROR", "issue-error", error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error), who.user.id);
      return { accepted: false, outcome: UPPER_ISSUE_OUTCOME.ERROR, reason: "The upper could not be issued. Nothing was saved — scan it again." };
    }
  });

  /** A read behind the same permissions. A failure comes back as a refusal, never a throw. */
  const read = <T>(channel: string, fallback: T, work: (input: Record<string, unknown>) => T | null) => {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, query?: unknown) => {
      const who = operator(event);
      if (!who.ok) return { accepted: false, reason: who.reason, ...fallback };
      try {
        const value = work(asRecord(query));
        return value === null ? { accepted: false, reason: "Choose a valid machine and day.", ...fallback } : { accepted: true, ...value };
      } catch (error) {
        log("WARNING", channel, error instanceof Error ? error.message : String(error));
        return { accepted: false, reason: "This could not be loaded. Try again.", ...fallback };
      }
    });
  };

  read<{ page: ReturnType<typeof db.listUpperIssues> }>(IPC.listUpperIssues, { page: null }, (input) => {
    const page = db.listUpperIssues({ machineId: asString(input.machineId), date: asString(input.date), page: Number(input.page), pageSize: Number(input.pageSize) });
    return page ? { page } : null;
  });

  read<{ summary: ReturnType<typeof db.getUpperIssueSummary> }>(IPC.getUpperIssueSummary, { summary: null }, (input) => {
    const summary = db.getUpperIssueSummary({
      machineId: asString(input.machineId),
      sessionId: db.currentUpperIssueSessionId(deviceId),
      date: asString(input.date),
    });
    return summary ? { summary } : null;
  });

  read(IPC.listUpperStock, { rows: [] }, (input) => ({ rows: db.listUpperStock({ search: asString(input.search) }) }));

  // Settles a scan whose answer never arrived: was this packet issued to a machine, by the database?
  read<{ issue: ReturnType<typeof db.findUpperIssue> }>(IPC.findUpperIssue, { issue: null }, (input) => ({ issue: db.findUpperIssue(asString(input.qrId)) }));
}
