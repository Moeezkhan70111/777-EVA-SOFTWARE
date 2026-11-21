// Claims against a party, as their ledgers read them.
//
//   CL-000001 · MP-000012 · 1 pair of SK6 7/10 BLACK RED — torn upper      Rs 50.00 Dr
//
// A claim is a deduction from what we owe the party (migration 076): the supplier ledger and the
// contractor ledger both show it as a debit. Only POSTED claims count; a reversed claim stays in
// the table with who reversed it, and leaves every ledger. Posted and reversed by Accounts from the
// store's claim requests (partyClaimPosting.ts, docs/55). Claims the store posted itself before that
// release keep their rows and read the same.
//
// A claim names its program and material by the text it carries (program_code, material_name),
// because machine programs do not travel: on the accounts and boss computers there is no program to
// join. An older claim has no such text and is read through its program, on the computer that has it.
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").

import type { SqliteDatabase } from "../sqliteDatabase.js";
import { formatMachineProgramCodeNumber } from "@erp/application";
import { PARTY_CLAIM_STATUS } from "@erp/domain";
import { orderByCode } from "./numberRange.js";

const text = (value: unknown): string => (value == null ? "" : String(value));

/** One posted claim against a party, worded for a ledger row. */
export interface PartyClaimEntry {
  claimId: string;
  claimNumber: string;
  /** The business day it was posted, `YYYY-MM-DD`. */
  claimDate: string;
  description: string;
  amountPaisa: number;
}

const CLAIMS_SQL = `
  SELECT c.id, c.claim_number, c.claim_date, c.amount_paisa, c.quantity_pairs, c.reason,
         c.program_code, mp.program_number, COALESCE(c.material_name, ii.display_name) AS display_name
    FROM party_claims c
    LEFT JOIN machine_programs mp ON mp.id = c.program_id
    LEFT JOIN inventory_items ii ON ii.id = c.item_id
   WHERE c.party_id = ? AND c.status = '${PARTY_CLAIM_STATUS.POSTED}'
   ORDER BY c.claim_date, ${orderByCode("partyClaim", "c.claim_number")}`;

const describe = (row: Record<string, unknown>): string => {
  const pairs = Number(row.quantity_pairs ?? 0);
  const code = row.program_code != null ? text(row.program_code) : formatMachineProgramCodeNumber(Number(row.program_number ?? 0));
  return `Claim · ${code} · ${pairs} pair${pairs === 1 ? "" : "s"} of ${text(row.display_name)} — ${text(row.reason)}`;
};

export const partyClaimsMethods = {
  /** Every posted claim against a party, oldest first. */
  listPartyClaims(this: SqliteDatabase, partyId: string): PartyClaimEntry[] {
    return (this.db.prepare(CLAIMS_SQL).all(text(partyId).trim()) as Array<Record<string, unknown>>).map((row) => ({
      claimId: text(row.id),
      claimNumber: text(row.claim_number),
      claimDate: text(row.claim_date),
      description: describe(row),
      amountPaisa: Number(row.amount_paisa ?? 0),
    }));
  },
};

export type PartyClaimsMethods = typeof partyClaimsMethods;
