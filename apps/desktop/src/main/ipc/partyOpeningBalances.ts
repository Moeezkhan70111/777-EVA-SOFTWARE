// Opening balances and the ledger reconciliation: Customer Ledger and Supplier Ledger > Opening balance (docs/53;
// data layer, database/partyOpeningBalances.ts and partyLedgerReconciliation.ts).
//
//   getPartyOpeningBalance      a party's opening position and its history. Its own ledger's permission.
//   postPartyOpeningBalance     the first one, or a new one after a reversal
//   reversePartyOpeningBalance  takes it out of the live balance, with a reason
//   correctPartyOpeningBalance  a reversal and a new posting, together
//   getLedgerReconciliation     every customer's or supplier's archive against its opening balance
//
// WHO. Posting, reversing and correcting change a party's live balance with no document behind them, so they are an
// ADMINISTRATOR's, on the computer holding the ACCOUNTS lease (leaseChannels.ts), where cash vouchers are written.
// Who did it comes from the session, never the screen. Every figure is checked again by the data layer.

import type { IpcMainInvokeEvent } from "electron";
import { ipcMain } from "../leaseGuard";
import { IPC } from "../../shared/ipcChannels";
import type { IpcContext } from "./context";
import { LEDGER_SIDE, asRecord, asString, isLedgerArchiveSide, type LedgerSide } from "@erp/domain";
import { rejection, type SessionUser } from "../authorize";
import { refusalReason } from "../writeRefusal";
import { LEDGER_PERMISSION } from "./ledgerArchive";

/** What an operator is told. One place, for translation later (R21). */
export const OPENING_BALANCE_MESSAGES = {
  BUSY: "The opening balance was not saved because another write is in progress. Nothing was changed. Please try again.",
  NOT_SAVED: "The opening balance could not be saved. Nothing was changed.",
  NOT_LOADED: "The opening balance could not be loaded. Try again.",
  NOT_A_PARTY: "An opening balance is for a customer or a supplier.",
  NOT_ALLOWED_VIEW: "Your account does not have access to this ledger.",
  ADMIN_ONLY: "Only an administrator can post, correct or reverse an opening balance.",
  REPORT_NOT_LOADED: "The reconciliation could not be loaded. Try again.",
} as const;

/** Exactly what these handlers need. */
export interface OpeningBalanceContext {
  // The whole database: its methods are bound to it (this: SqliteDatabase), so a Pick of them cannot be called.
  db: IpcContext["db"];
  logger: Pick<IpcContext["logger"], "log">;
  authorizer: Pick<IpcContext["authorizer"], "requireAdmin" | "requirePermission">;
  deviceId: string;
}

/** The posted figures as sent. Their meaning is checked by the data layer, not here. */
const postingOf = (fields: Record<string, unknown>) => ({
  direction: fields.direction,
  amountPaisa: fields.amountPaisa,
  effectiveDate: fields.effectiveDate,
  sourceReference: fields.sourceReference,
  archiveStatementId: asString(fields.archiveStatementId) || undefined,
  note: asString(fields.note) || undefined,
});

const versionOf = (value: unknown): number => (typeof value === "number" && Number.isSafeInteger(value) ? value : -1);

export function registerPartyOpeningBalanceHandlers(ctx: OpeningBalanceContext): void {
  const { db, logger, authorizer, deviceId } = ctx;
  const log = (severity: "INFO" | "WARNING" | "ERROR", operation: string, message: string, userId?: string) =>
    logger.log({ module: "opening-balance", severity, operation, deviceId, userId, message });

  /** The side's own ledger permission, for a party of that side. */
  const reader = (event: IpcMainInvokeEvent, side: LedgerSide, opts: unknown): { ok: true } | { ok: false; reason: string } => {
    try {
      authorizer.requirePermission(event, LEDGER_PERMISSION[side], asRecord(opts).token);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: rejection(error, OPENING_BALANCE_MESSAGES.NOT_ALLOWED_VIEW).reason };
    }
  };

  const admin = (event: IpcMainInvokeEvent, opts: unknown): { ok: true; user: SessionUser } | { ok: false; reason: string } => {
    try {
      return { ok: true, user: authorizer.requireAdmin(event, asRecord(opts).token) };
    } catch (error) {
      return { ok: false, reason: rejection(error, OPENING_BALANCE_MESSAGES.ADMIN_ONLY).reason };
    }
  };

  /** One write, answered with the party's position after it, or the refusal as it is. */
  const write = (event: IpcMainInvokeEvent, opts: unknown, operation: string, run: (actor: string) => ReturnType<typeof db.postPartyOpeningBalance>) => {
    const user = admin(event, opts);
    if (!user.ok) return { accepted: false, reason: user.reason };
    try {
      const view = run(user.user.username);
      log("INFO", operation, JSON.stringify({ partyId: view.partyId, version: view.version, status: view.status }), user.user.id);
      return { accepted: true, view };
    } catch (error) {
      const reason = refusalReason(error, OPENING_BALANCE_MESSAGES.BUSY, OPENING_BALANCE_MESSAGES.NOT_SAVED);
      log("WARNING", operation, reason, user.user.id);
      return { accepted: false, reason };
    }
  };

  ipcMain.handle(IPC.getPartyOpeningBalance, (event, partyId?: unknown, opts?: unknown) => {
    const party = db.getParty(asString(partyId));
    if (!party || !isLedgerArchiveSide(party.partyType)) return { accepted: false, reason: OPENING_BALANCE_MESSAGES.NOT_A_PARTY };
    const allowed = reader(event, party.partyType, opts);
    if (!allowed.ok) return { accepted: false, reason: allowed.reason };
    try {
      return { accepted: true, view: db.getPartyOpeningBalance(party.id) };
    } catch (error) {
      log("ERROR", "read", error instanceof Error ? error.message : String(error));
      return { accepted: false, reason: OPENING_BALANCE_MESSAGES.NOT_LOADED };
    }
  });

  ipcMain.handle(IPC.postPartyOpeningBalance, (event, input?: unknown, opts?: unknown) => {
    const fields = asRecord(input);
    return write(event, opts, "post", (actor) =>
      db.postPartyOpeningBalance({ requestId: asString(fields.requestId), partyId: asString(fields.partyId), ...postingOf(fields), actor })
    );
  });

  ipcMain.handle(IPC.reversePartyOpeningBalance, (event, input?: unknown, opts?: unknown) => {
    const fields = asRecord(input);
    return write(event, opts, "reverse", (actor) =>
      db.reversePartyOpeningBalance({ requestId: asString(fields.requestId), partyId: asString(fields.partyId), expectedVersion: versionOf(fields.expectedVersion), reason: fields.reason, actor })
    );
  });

  ipcMain.handle(IPC.correctPartyOpeningBalance, (event, input?: unknown, opts?: unknown) => {
    const fields = asRecord(input);
    return write(event, opts, "correct", (actor) =>
      db.correctPartyOpeningBalance({
        requestId: asString(fields.requestId), partyId: asString(fields.partyId), expectedVersion: versionOf(fields.expectedVersion), reason: fields.reason, ...postingOf(fields), actor,
      })
    );
  });

  ipcMain.handle(IPC.getLedgerReconciliation, (event, side?: unknown, opts?: unknown) => {
    const ledger = isLedgerArchiveSide(side) ? side : LEDGER_SIDE.CUSTOMER;
    const allowed = reader(event, ledger, opts);
    if (!allowed.ok) return { accepted: false, reason: allowed.reason };
    try {
      return { accepted: true, report: db.partyLedgerReconciliation(ledger) };
    } catch (error) {
      log("ERROR", "reconciliation", error instanceof Error ? error.message : String(error));
      return { accepted: false, reason: OPENING_BALANCE_MESSAGES.REPORT_NOT_LOADED };
    }
  });
}
