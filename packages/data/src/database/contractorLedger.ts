// Contractor Ledger: what a contractor earned for the cartons machine programs produced, and
// what the cash vouchers paid them. Read-only — nothing is stored; see @erp/domain
// contractorLedger.ts for the rules and the arithmetic.
//
//   "who can have a ledger, and as what?"                listContractorLedgerAccounts
//   "this contractor's work and payments for a period"   getContractorLedger
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").

import type { SqliteDatabase } from "../sqliteDatabase.js";
import { formatMachineProgramCodeNumber } from "@erp/application";
import {
  CONTRACTOR_PAYMENT_KIND,
  CONTRACTOR_ROLE,
  PRINTING_CONTRACTOR_ACCOUNT_ID,
  RATE_SOURCE,
  buildContractorLedger,
  groupContractorWork,
  type ContractorLedger,
  type ContractorPayment,
  type ContractorRole,
  type ContractorWorkCarton,
  type RateSource,
} from "@erp/domain";

const text = (value: unknown): string => (value == null ? "" : String(value));

/** A contractor a ledger can be opened for, and the work they are on record for. */
export interface ContractorLedgerAccount {
  id: string;
  name: string;
  city: string | null;
  active: boolean;
  /** MACHINE and/or PACKING — from the programs and machines they were assigned to. */
  roles: ContractorRole[];
}

export interface ContractorLedgerReport extends ContractorLedger {
  account: ContractorLedgerAccount;
  fromDate: string;
  toDate: string;
}

const PRINTING_ACCOUNT: ContractorLedgerAccount = {
  id: PRINTING_CONTRACTOR_ACCOUNT_ID,
  name: "Printing Contractor",
  city: null,
  active: true,
  roles: [CONTRACTOR_ROLE.PRINTING],
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// A role is on record when a program was made with the contractor in it, or a machine has them
// assigned now (the next program will be made with them).
const ROLE_SQL = {
  machine: `(EXISTS (SELECT 1 FROM machine_programs mp WHERE mp.contractor_party_id = p.id)
             OR EXISTS (SELECT 1 FROM machines m WHERE m.contractor_party_id = p.id))`,
  packing: `(EXISTS (SELECT 1 FROM machine_programs mp WHERE mp.packing_contractor_party_id = p.id)
             OR EXISTS (SELECT 1 FROM machines m WHERE m.packing_contractor_party_id = p.id))`,
};

// Active contractors, plus any inactive one who is on a program — their ledger still matters.
const ACCOUNTS_SQL = `
  SELECT p.id, p.party_name, p.city, p.status,
         ${ROLE_SQL.machine} AS machine_role, ${ROLE_SQL.packing} AS packing_role
  FROM parties p
  WHERE p.deleted_at IS NULL AND p.party_type = 'CONTRACTOR'
    AND (p.status = 'ACTIVE' OR EXISTS (SELECT 1 FROM machine_programs mp
          WHERE mp.contractor_party_id = p.id OR mp.packing_contractor_party_id = p.id))`;

// Every carton printed for a machine program that Store In has received, with the program's
// contractors and both rates its jobs could be paid at. "Received" is the same fact the program
// screen counts as "back" (machineProgramCartons.ts): a STORE_ENTRY for the carton. The FIRST one
// dates it — a carton later returned from the gate and stored in again is not new work.
// `?1` is the contractor's party id, or the printing account (every program's printing work).
// B CARTONS ARE LEFT OUT: no contractor is paid for a B carton (owner, 2026-10-12), so a B label
// stored in is production for the program's counts but never work on a contractor's ledger.
//
// MANUAL PRODUCTION (migration 080) is work too: an entry is cartons produced on a machine's program
// and stocked the moment it is saved, so it is dated by when it was saved and paid at the same program
// or product rate. It is one row standing for its `cartons` — a carton QR row stands for 1.
//
// WHICH PROGRAM A CARTON RUN BELONGS TO — three sources, and a run is only ever in ONE of them:
//
//   qr_batches.machine_program_id      the QR Generator and the B Carton tab (migration 078). The
//                                      machine's first run of the day opens its program and every
//                                      later run joins it, stamped on the run itself.
//   machine_program_carton_labels      the retired planning workflow's issued upper packets (068)
//   machine_program_fix_carton_labels  the same workflow's FIX runs (071)
//
// The two label tables were the only sources until now, so a carton the QR Generator made was in
// no program here and earned nobody anything — the defect this third branch closes. It cannot
// double-charge: the three label prints all call reserveQrBatchInTransaction WITHOUT a
// machineProgramId, so their runs carry NULL there and no run can match two branches. UNION
// (never UNION ALL) is the second guard, and a carton is still one row per qr_codes row dated by
// its FIRST STORE_ENTRY, so neither a re-scan nor a retry can pay for it twice.
//
// A run with neither a machine_program_id nor a label row is in no program and is paid by nobody:
// a SCAN_ADOPTED code Live Production took in from outside the system, and every run generated
// before Phase 1.1 asked which machine it was for.
const CARTONS_SQL = `
  WITH program_batches AS (
    SELECT program_id, qr_batch_id FROM machine_program_carton_labels
    UNION
    SELECT program_id, qr_batch_id FROM machine_program_fix_carton_labels
    UNION
    SELECT machine_program_id AS program_id, id AS qr_batch_id FROM qr_batches
      WHERE machine_program_id IS NOT NULL
  )
  SELECT * FROM (
    SELECT mp.id AS program_id, mp.program_number, COALESCE(m.name, '') AS machine_name,
           mp.contractor_party_id, mp.packing_contractor_party_id,
           COALESCE(qb.article_size_id, '') AS article_size_id, qb.article, qb.size,
           (SELECT MIN(pe.event_ts_local) FROM production_events pe
             WHERE pe.qr_id = qc.id AND pe.event_type = 'MOVED'
               AND json_extract(pe.metadata_json, '$.eventType') = 'STORE_ENTRY') AS received_at,
           r.id AS program_rate_id,
           r.machine_rate_paisa AS program_machine, r.packing_rate_paisa AS program_packing, r.printing_rate_paisa AS program_printing,
           asz.machine_rate_paisa AS standard_machine, asz.packing_rate_paisa AS standard_packing, asz.printing_rate_paisa AS standard_printing,
           1 AS cartons
    FROM program_batches pb
    JOIN machine_programs mp ON mp.id = pb.program_id
    JOIN qr_batches qb ON qb.id = pb.qr_batch_id
    JOIN qr_codes qc ON qc.batch_id = qb.id
    LEFT JOIN machines m ON m.id = mp.machine_id
    LEFT JOIN machine_program_article_rates r ON r.program_id = mp.id AND r.article_size_id = qb.article_size_id
    LEFT JOIN article_sizes asz ON asz.id = qb.article_size_id
    -- B cartons (qr_batches.grade = 'B', migration 074) are NOT paid to any contractor (owner, 2026-10-12).
    WHERE qb.grade IS NULL
      AND (?1 = '${PRINTING_CONTRACTOR_ACCOUNT_ID}' OR mp.contractor_party_id = ?1 OR mp.packing_contractor_party_id = ?1)
    UNION ALL
    SELECT mp.id, mp.program_number, COALESCE(m.name, ''), mp.contractor_party_id, mp.packing_contractor_party_id,
           me.article_size_id, me.article, me.size, me.entry_ts,
           r.id, r.machine_rate_paisa, r.packing_rate_paisa, r.printing_rate_paisa,
           asz.machine_rate_paisa, asz.packing_rate_paisa, asz.printing_rate_paisa,
           me.cartons
    FROM manual_production_entries me
    JOIN machine_programs mp ON mp.id = me.machine_program_id
    LEFT JOIN machines m ON m.id = mp.machine_id
    LEFT JOIN machine_program_article_rates r ON r.program_id = mp.id AND r.article_size_id = me.article_size_id
    LEFT JOIN article_sizes asz ON asz.id = me.article_size_id
    WHERE (?1 = '${PRINTING_CONTRACTOR_ACCOUNT_ID}' OR mp.contractor_party_id = ?1 OR mp.packing_contractor_party_id = ?1)
  ) WHERE received_at IS NOT NULL`;

// Every active cash voucher that names the contractor, on its header or on one of its lines.
const VOUCHERS_SQL = `
  SELECT cv.id, cv.voucher_number, cv.voucher_date, COALESCE(cv.description, '') AS description, cv.mode_of_transfer,
         cv.party_id, cv.receipt_amount_paisa, cv.payment_amount_paisa,
         (SELECT COUNT(*) FROM cash_voucher_lines l WHERE l.voucher_id = cv.id) AS line_count,
         (SELECT COALESCE(SUM(l.receipt_amount_paisa), 0) FROM cash_voucher_lines l WHERE l.voucher_id = cv.id AND l.party_id = ?1) AS line_receipts,
         (SELECT COALESCE(SUM(l.payment_amount_paisa), 0) FROM cash_voucher_lines l WHERE l.voucher_id = cv.id AND l.party_id = ?1) AS line_payments
  FROM cash_vouchers cv
  WHERE cv.status = 'ACTIVE' AND cv.deleted_at IS NULL
    AND (cv.party_id = ?1 OR EXISTS (SELECT 1 FROM cash_voucher_lines l WHERE l.voucher_id = cv.id AND l.party_id = ?1))
  ORDER BY cv.voucher_date, cv.created_at`;

const accountOf = (row: Record<string, unknown>): ContractorLedgerAccount => {
  const roles: ContractorRole[] = [];
  if (Number(row.machine_role)) roles.push(CONTRACTOR_ROLE.MACHINE);
  if (Number(row.packing_role)) roles.push(CONTRACTOR_ROLE.PACKING);
  return { id: text(row.id), name: text(row.party_name), city: row.city ? text(row.city) : null, active: text(row.status) === "ACTIVE", roles };
};

const JOB_COLUMN: Record<ContractorRole, string> = {
  [CONTRACTOR_ROLE.MACHINE]: "machine",
  [CONTRACTOR_ROLE.PACKING]: "packing",
  [CONTRACTOR_ROLE.PRINTING]: "printing",
};

/**
 * The rate one job on this carton is paid at: what the program agreed for the article, or the
 * product's standard when the program was never priced for it — or none at all.
 */
const rateFor = (row: Record<string, unknown>, role: ContractorRole): { ratePaisa: number | null; rateSource: RateSource | null } => {
  const job = JOB_COLUMN[role];
  if (row.program_rate_id) return { ratePaisa: Number(row[`program_${job}`] ?? 0), rateSource: RATE_SOURCE.PROGRAM };
  const standard = row[`standard_${job}`];
  if (standard != null) return { ratePaisa: Number(standard), rateSource: RATE_SOURCE.PRODUCT };
  return { ratePaisa: null, rateSource: null };
};

/** The jobs on this carton the account is paid for. One contractor can hold both on a program. */
const rolesOn = (row: Record<string, unknown>, accountId: string): ContractorRole[] => {
  if (accountId === PRINTING_CONTRACTOR_ACCOUNT_ID) return [CONTRACTOR_ROLE.PRINTING];
  const roles: ContractorRole[] = [];
  if (text(row.contractor_party_id) === accountId) roles.push(CONTRACTOR_ROLE.MACHINE);
  if (text(row.packing_contractor_party_id) === accountId) roles.push(CONTRACTOR_ROLE.PACKING);
  return roles;
};

const workCartonsOf = (rows: Array<Record<string, unknown>>, accountId: string): ContractorWorkCarton[] =>
  rows.flatMap((row) =>
    rolesOn(row, accountId).map((role) => ({
      receivedAt: text(row.received_at),
      programId: text(row.program_id),
      programCode: formatMachineProgramCodeNumber(Number(row.program_number)),
      machineName: text(row.machine_name),
      role,
      articleSizeId: text(row.article_size_id),
      article: text(row.article),
      size: text(row.size),
      cartons: Number(row.cartons ?? 1),
      ...rateFor(row, role),
    }))
  );

/** A voucher's payment and/or receipt for this contractor: its own lines if it has any, else its header. */
const paymentsOf = (row: Record<string, unknown>): ContractorPayment[] => {
  const hasLines = Number(row.line_count) > 0;
  const paid = hasLines ? Number(row.line_payments) : Number(row.payment_amount_paisa ?? 0);
  const received = hasLines ? Number(row.line_receipts) : Number(row.receipt_amount_paisa ?? 0);
  const base = {
    date: text(row.voucher_date).slice(0, 10),
    voucherId: text(row.id),
    voucherNumber: text(row.voucher_number),
    description: text(row.description),
    modeOfTransfer: row.mode_of_transfer ? text(row.mode_of_transfer) : null,
  };
  const out: ContractorPayment[] = [];
  if (paid > 0) out.push({ ...base, kind: CONTRACTOR_PAYMENT_KIND.PAYMENT, amountPaisa: paid });
  if (received > 0) out.push({ ...base, kind: CONTRACTOR_PAYMENT_KIND.RECEIPT, amountPaisa: received });
  return out;
};

export const contractorLedgerMethods = {
  /** Every contractor a ledger can be opened for, by name. The printing ledger is not a party. */
  listContractorLedgerAccounts(this: SqliteDatabase): ContractorLedgerAccount[] {
    const rows = this.db.prepare(`${ACCOUNTS_SQL} ORDER BY p.party_name COLLATE NOCASE`).all() as Array<Record<string, unknown>>;
    return rows.map(accountOf);
  },

  /**
   * One contractor's ledger for `fromDate`…`toDate` (inclusive, `YYYY-MM-DD`), or the printing
   * ledger for PRINTING_CONTRACTOR_ACCOUNT_ID. Everything before the period is its opening balance.
   */
  getContractorLedger(this: SqliteDatabase, accountId: string, period: { fromDate: string; toDate: string }): ContractorLedgerReport {
    const id = text(accountId).trim();
    if (!ISO_DATE.test(period.fromDate) || !ISO_DATE.test(period.toDate)) throw new Error("Choose a valid date range.");
    if (period.fromDate > period.toDate) throw new Error("The start date must be on or before the end date.");

    const account = this.findContractorLedgerAccount(id);
    if (!account) throw new Error("This contractor was not found. Choose another from the list.");

    const cartonRows = this.db.prepare(CARTONS_SQL).all(id) as Array<Record<string, unknown>>;
    const work = groupContractorWork(workCartonsOf(cartonRows, id));
    // The printing ledger is not a party, so no voucher or claim can name it yet.
    const payments =
      id === PRINTING_CONTRACTOR_ACCOUNT_ID
        ? []
        : [
            ...(this.db.prepare(VOUCHERS_SQL).all(id) as Array<Record<string, unknown>>).flatMap(paymentsOf),
            ...this.contractorClaimsOf(id),
          ];

    return { account, ...period, ...buildContractorLedger({ work, payments, ...period }) };
  },

  /** @internal Claims for uppers damaged or lost in a contractor's work, deducted on their ledger. */
  contractorClaimsOf(this: SqliteDatabase, partyId: string): ContractorPayment[] {
    return this.listPartyClaims(partyId).map((claim) => ({
      date: claim.claimDate,
      voucherId: claim.claimId,
      voucherNumber: claim.claimNumber,
      description: claim.description,
      modeOfTransfer: null,
      kind: CONTRACTOR_PAYMENT_KIND.CLAIM,
      amountPaisa: claim.amountPaisa,
    }));
  },

  /** @internal The account behind an id: a contractor party, or the printing ledger. */
  findContractorLedgerAccount(this: SqliteDatabase, id: string): ContractorLedgerAccount | null {
    if (id === PRINTING_CONTRACTOR_ACCOUNT_ID) return PRINTING_ACCOUNT;
    const row = this.db.prepare(`${ACCOUNTS_SQL} AND p.id = ? LIMIT 1`).get(id) as Record<string, unknown> | undefined;
    return row ? accountOf(row) : null;
  },
};

export type ContractorLedgerMethods = typeof contractorLedgerMethods;
