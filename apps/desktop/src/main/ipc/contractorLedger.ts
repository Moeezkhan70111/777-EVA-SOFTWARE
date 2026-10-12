// Contractor Ledger: what contractors earned for machine program production, and were paid.
//
// Read-only. Both reads are authorised through ctx.authorizer (see ../authorize.ts) — a ledger
// is financial data, so hiding the page is not what keeps it private — and every channel name
// comes from shared/ipcChannels.ts.

import { ipcMain } from "electron";
import { IPC } from "../../shared/ipcChannels";
import type { IpcContext } from "./context";
import { rejection } from "../authorize";
import { PERMISSION } from "@erp/domain";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A `YYYY-MM-DD` the renderer sent, or null for anything else. */
const isoDate = (value: unknown): string | null => (typeof value === "string" && ISO_DATE.test(value) ? value : null);

export function registerContractorLedgerHandlers(ctx: IpcContext): void {
  const { db, authorizer } = ctx;

  ipcMain.handle(IPC.listContractorLedgerAccounts, (event) => {
    try {
      authorizer.requirePermission(event, PERMISSION.CONTRACTOR_LEDGER);
      return { accepted: true, accounts: db.listContractorLedgerAccounts() };
    } catch (error) {
      return rejection(error, "Could not load the contractors");
    }
  });

  ipcMain.handle(IPC.getContractorLedger, (event, accountId?: unknown, query?: Record<string, unknown>) => {
    try {
      authorizer.requirePermission(event, PERMISSION.CONTRACTOR_LEDGER);
      if (typeof accountId !== "string" || !accountId.trim()) return { accepted: false, reason: "Choose a contractor." };
      const fromDate = isoDate(query?.fromDate);
      const toDate = isoDate(query?.toDate);
      if (!fromDate || !toDate) return { accepted: false, reason: "Choose a valid date range." };
      return { accepted: true, ledger: db.getContractorLedger(accountId.trim(), { fromDate, toDate }) };
    } catch (error) {
      return rejection(error, "Could not load the ledger");
    }
  });
}
