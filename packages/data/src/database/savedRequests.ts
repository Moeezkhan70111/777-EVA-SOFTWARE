// "Was my last Save recorded?" -- read-only, for a screen reopened after a restart (migration 105).
//
// A screen writes the id of a press of Save that has had no answer to the browser's local storage, and clears
// it on a definite answer. If the app closed before the answer came, the reopened screen asks here, and says
// "Your last Save was recorded as GP-000123" -- or that it was not. It never guesses from what was typed:
// two identical gatepasses can both be intended.
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").

import type { SqliteDatabase } from "../sqliteDatabase.js";
import { formatGatepassCode } from "@erp/application";
import { isRequestId } from "./requestFingerprint.js";

export const SAVED_REQUEST_KIND = {
  GATEPASS: "GATEPASS",
  SALE_VOUCHER: "SALE_VOUCHER",
  CASH_VOUCHER: "CASH_VOUCHER",
} as const;

export type SavedRequestKind = (typeof SAVED_REQUEST_KIND)[keyof typeof SAVED_REQUEST_KIND];

/** The document a request id made: its id and how a person names it. */
export interface SavedRequest {
  id: string;
  /** "GP-000123", "Sale Voucher #57", "Cash Voucher #12". */
  label: string;
}

const LOOKUP: Record<SavedRequestKind, { sql: string; label: (number: string | number) => string }> = {
  GATEPASS: { sql: "SELECT id, gatepass_number AS number FROM gatepasses WHERE request_id = ? LIMIT 1", label: (n) => formatGatepassCode(Number(n)) },
  SALE_VOUCHER: { sql: "SELECT id, voucher_number AS number FROM sale_vouchers WHERE request_id = ? LIMIT 1", label: (n) => `Sale Voucher #${n}` },
  // A cash voucher's id IS its request id (cash.ts).
  CASH_VOUCHER: { sql: "SELECT id, voucher_number AS number FROM cash_vouchers WHERE id = ? LIMIT 1", label: (n) => `Cash Voucher #${n}` },
};

export const savedRequestMethods = {
  /** The document a press of Save made, or null when it made none (or the id is not a request id). */
  findSavedRequest(this: SqliteDatabase, kind: SavedRequestKind, requestId: string): SavedRequest | null {
    const lookup = LOOKUP[kind];
    if (!lookup || !isRequestId(requestId)) return null;
    const row = this.db.prepare(lookup.sql).get(requestId.trim()) as { id: string; number: string | number } | undefined;
    return row ? { id: String(row.id), label: lookup.label(row.number) } : null;
  },
};

export type SavedRequestMethods = typeof savedRequestMethods;
