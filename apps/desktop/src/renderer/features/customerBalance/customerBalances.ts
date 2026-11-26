import { fromPaisa, toPaisa } from "@erp/domain";
import { copy } from "../../config/copy";
import { amountText, looseMatches } from "../customerLedger/looseSearch";

// CUSTOMER BALANCE's figures. Each balance is the main process's (listCustomerBalances: old ledger + ERP, worked in
// paisa). This file checks the reply (R25), narrows it to a group and a search, and adds up what is shown, in paisa,
// so a total never drifts by a rupee's fraction.

export interface CustomerBalanceRow {
  partyId: string;
  partyName: string;
  city: string | null;
  groupName: string | null;
  balance: number;
  lastVoucherDate: string | null;
  totalSales: number;
  totalReceipts: number;
}

export interface BalanceTotals {
  count: number;
  balance: number;
  sales: number;
  receipts: number;
}

export type BalancesReply = { ok: true; rows: CustomerBalanceRow[] } | { ok: false; reason: string };

/** Customers a page: long books are paged, never drawn whole (R20). */
export const BALANCES_PAGE_SIZE = 50;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isMoney = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isTextOrNull = (value: unknown): value is string | null => value === null || typeof value === "string";

const rowOf = (value: unknown): CustomerBalanceRow | null => {
  if (!isRecord(value)) return null;
  const { partyId, partyName, city, groupName, balance, lastVoucherDate, totalSales, totalReceipts } = value;
  if (typeof partyId !== "string" || typeof partyName !== "string") return null;
  if (!isTextOrNull(city) || !isTextOrNull(lastVoucherDate) || !isMoney(balance) || !isMoney(totalSales) || !isMoney(totalReceipts)) return null;
  return { partyId, partyName, city, groupName: typeof groupName === "string" ? groupName : null, balance, lastVoucherDate, totalSales, totalReceipts };
};

/** The main process's answer. One malformed row fails the whole read: a list with customers missing would be believed. */
export const parseBalancesReply = (reply: unknown): BalancesReply => {
  if (!isRecord(reply) || !Array.isArray(reply.rows)) return { ok: false, reason: copy.customerBalance.failed };
  const rows = reply.rows.map(rowOf);
  return rows.every((row): row is CustomerBalanceRow => row !== null) ? { ok: true, rows } : { ok: false, reason: copy.customerBalance.failed };
};

/** The customers in a group ("" for all) whose name, city, group or balance matches the search (loosely, Postel). */
export const filterBalances = (rows: readonly CustomerBalanceRow[], groupName: string, search: string): CustomerBalanceRow[] =>
  rows.filter((row) => (!groupName || row.groupName === groupName) && looseMatches([row.partyName, row.city ?? "", row.groupName ?? "", amountText(row.balance)], search));

const sumRupees = (values: readonly number[]): number => fromPaisa(values.reduce((sum, value) => sum + toPaisa(value), 0));

/** What the shown customers add up to. */
export const balanceTotals = (rows: readonly CustomerBalanceRow[]): BalanceTotals => ({
  count: rows.length,
  balance: sumRupees(rows.map((row) => row.balance)),
  sales: sumRupees(rows.map((row) => row.totalSales)),
  receipts: sumRupees(rows.map((row) => row.totalReceipts)),
});

/** The groups customers are in, A to Z: the group picker offers only these (owner, 26 Nov 2026), never a supplier's. */
export const customerGroups = (rows: readonly CustomerBalanceRow[]): string[] =>
  [...new Set(rows.map((row) => row.groupName).filter((name): name is string => Boolean(name)))].sort((a, b) => a.localeCompare(b));
