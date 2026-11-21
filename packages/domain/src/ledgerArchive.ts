// HISTORICAL LEDGER ARCHIVE (docs/50): a customer's ledger from the previous accounting software, kept as it was
// printed, and shown beside the live ERP ledger on the one Customer Ledger screen.
//
//   30/09/2026   0       ·   ·      Opening Balance                                    -        -   202,200
//   09/10/2026   11802   SL  14302  4 Dzn HR-1 7/10 EVR Gents@7920 Discount 1440   4   30,240   -   232,440
//   17/10/2026   3181    CV  ·      received khawaja talal hassan meezan            0   -  300,000      480
//
// AN ARCHIVE IS NOT ACCOUNTING. An archived row is a record of what the old software printed: its date, numbers,
// words and figures, and the running balance THAT software worked out. It never becomes a sale voucher, a cash
// voucher, a journal, a stock movement or a party balance, and nothing here adds it to one. The live balance is still
// worked out only from the ERP's own documents (database/cash.ts).
//
// EVERY ROW IS CHECKED, NOT JUST THE TOTALS. A statement's rows must follow one another: each running balance is the
// one before it plus its debit less its credit. A row that does not is refused with the figures, so a mistyped amount
// is caught where it is, rather than imported and noticed later.
//
// SUPPLIERS TOO (docs/50, phase 2). A supplier's old ledger is archived the same way. Which way its balance runs is
// what the old software printed, never assumed: a supplier statement is read as credit less debit (what we owe,
// the ERP's supplier convention) and, if its rows do not follow that way, as debit less credit. The rule its rows
// actually follow is stored with it. A customer statement is always debit less credit, as before.
//
// Pure: the import screen and the data layer read a file's rows with the same rules.

import { PAISA_PER_RUPEE } from "./money.js";

/** Which ledger an archived statement belongs to: the party type it is imported for. */
export const LEDGER_ARCHIVE_SIDE = { CUSTOMER: "CUSTOMER", SUPPLIER: "SUPPLIER" } as const;
export type LedgerArchiveSide = (typeof LEDGER_ARCHIVE_SIDE)[keyof typeof LEDGER_ARCHIVE_SIDE];

/**
 * How a statement's running balance moves. DEBIT_LESS_CREDIT: each balance is the one before plus debit less credit
 * (a customer's receivable). CREDIT_LESS_DEBIT: plus credit less debit (a supplier's payable).
 */
export const ARCHIVE_BALANCE_RULE = { DEBIT_LESS_CREDIT: "DEBIT_LESS_CREDIT", CREDIT_LESS_DEBIT: "CREDIT_LESS_DEBIT" } as const;
export type ArchiveBalanceRule = (typeof ARCHIVE_BALANCE_RULE)[keyof typeof ARCHIVE_BALANCE_RULE];

/** The rules a side's statements may follow, the expected one first. */
const SIDE_RULES: Readonly<Record<LedgerArchiveSide, readonly ArchiveBalanceRule[]>> = {
  CUSTOMER: [ARCHIVE_BALANCE_RULE.DEBIT_LESS_CREDIT],
  SUPPLIER: [ARCHIVE_BALANCE_RULE.CREDIT_LESS_DEBIT, ARCHIVE_BALANCE_RULE.DEBIT_LESS_CREDIT],
};

export const isLedgerArchiveSide = (value: unknown): value is LedgerArchiveSide => value === LEDGER_ARCHIVE_SIDE.CUSTOMER || value === LEDGER_ARCHIVE_SIDE.SUPPLIER;

/** How much one row moves the balance under a rule. */
export const archiveRowMovement = (row: { debitPaisa: number; creditPaisa: number }, rule: ArchiveBalanceRule): number =>
  rule === ARCHIVE_BALANCE_RULE.DEBIT_LESS_CREDIT ? row.debitPaisa - row.creditPaisa : row.creditPaisa - row.debitPaisa;

/**
 * A printed balance as the side reads it: positive is what the customer owes us, or what we owe the supplier. A
 * supplier statement printed debit less credit has the opposite sign.
 */
export const archiveBalanceForSide = (balancePaisa: number, side: LedgerArchiveSide, rule: ArchiveBalanceRule): number => {
  const natural = side === LEDGER_ARCHIVE_SIDE.CUSTOMER ? ARCHIVE_BALANCE_RULE.DEBIT_LESS_CREDIT : ARCHIVE_BALANCE_RULE.CREDIT_LESS_DEBIT;
  return rule === natural ? balancePaisa : -balancePaisa;
};

/** How much one import may hold. A customer's ledger is a few hundred rows; this is far above that. */
export const LEDGER_ARCHIVE_LIMITS = {
  MAX_ROWS: 20_000,
  MAX_STATEMENT_ROWS: 5_000,
  DESCRIPTION_MAX: 1_000,
  SHORT_TEXT_MAX: 64,
  NAME_MAX: 160,
} as const;

/** What the old software's type codes mean, for the screen. A code not here is shown as it is. */
export const LEDGER_ARCHIVE_TYPE_LABEL: Readonly<Record<string, string>> = {
  SL: "Sale",
  CV: "Cash Voucher",
  JV: "Journal Voucher",
};

/** The columns of an import file. Headings are matched without case, spaces or underscores. */
export const LEDGER_ARCHIVE_COLUMNS = [
  "party_code",
  "customer_name",
  "transaction_date",
  "voucher_number",
  "transaction_type",
  "bill_number",
  "description",
  "quantity",
  "debit",
  "credit",
  "running_balance",
  "sequence",
] as const;

export type LedgerArchiveColumn = (typeof LEDGER_ARCHIVE_COLUMNS)[number];

/** Columns a file must have. The rest may be missing or blank. */
export const LEDGER_ARCHIVE_REQUIRED_COLUMNS: readonly LedgerArchiveColumn[] = [
  "transaction_date",
  "description",
  "debit",
  "credit",
  "running_balance",
];

/** Other headings each column is known by. */
const COLUMN_ALIASES: Readonly<Record<LedgerArchiveColumn, readonly string[]>> = {
  party_code: ["partycode", "code", "customercode", "suppliercode", "accountcode"],
  customer_name: ["customername", "customer", "suppliername", "supplier", "name", "partyname"],
  transaction_date: ["transactiondate", "date"],
  voucher_number: ["vouchernumber", "voucherno", "no", "number"],
  transaction_type: ["transactiontype", "type"],
  bill_number: ["billnumber", "billno", "bill"],
  description: ["description", "particulars", "narration"],
  quantity: ["quantity", "qty"],
  debit: ["debit", "dr"],
  credit: ["credit", "cr"],
  running_balance: ["runningbalance", "balance"],
  sequence: ["sequence", "seq", "sr", "srno", "serial"],
};

const headingKey = (heading: string): string => heading.toLowerCase().replace(/[\s_.\-()]/g, "");

/** Which of the file's headings is each column, or null when it has none. */
export function ledgerArchiveHeadings(headers: readonly string[]): Record<LedgerArchiveColumn, string | null> {
  const found = {} as Record<LedgerArchiveColumn, string | null>;
  for (const column of LEDGER_ARCHIVE_COLUMNS) {
    const aliases = COLUMN_ALIASES[column];
    found[column] = headers.find((header) => aliases.includes(headingKey(header))) ?? null;
  }
  return found;
}

/** One row as the file gave it: every cell is text, nothing is trusted yet. */
export interface LedgerArchiveRowInput {
  /** The line of the file it came from, for messages. */
  readonly rowNumber: number;
  readonly partyCode: string;
  readonly customerName: string;
  readonly transactionDate: string;
  readonly voucherNumber: string;
  readonly transactionType: string;
  readonly billNumber: string;
  readonly description: string;
  readonly quantity: string;
  readonly debit: string;
  readonly credit: string;
  readonly runningBalance: string;
  readonly sequence: string;
}

/** The file's rows as text inputs, by their headings. */
export function ledgerArchiveRowsOf(headers: readonly string[], rows: ReadonlyArray<Readonly<Record<string, string>>>): LedgerArchiveRowInput[] {
  const at = ledgerArchiveHeadings(headers);
  const cell = (row: Readonly<Record<string, string>>, column: LedgerArchiveColumn): string => {
    const heading = at[column];
    return heading === null ? "" : row[heading] ?? "";
  };
  return rows.map((row, index) => ({
    // Row 1 is the heading line, so the first data row is line 2.
    rowNumber: index + 2,
    partyCode: cell(row, "party_code"),
    customerName: cell(row, "customer_name"),
    transactionDate: cell(row, "transaction_date"),
    voucherNumber: cell(row, "voucher_number"),
    transactionType: cell(row, "transaction_type"),
    billNumber: cell(row, "bill_number"),
    description: cell(row, "description"),
    quantity: cell(row, "quantity"),
    debit: cell(row, "debit"),
    credit: cell(row, "credit"),
    runningBalance: cell(row, "running_balance"),
    sequence: cell(row, "sequence"),
  }));
}

// ─── Reading one value ──────────────────────────────────────────────────────

/** A blank or a dash: the old software's way of printing nothing. */
const isNothing = (text: string): boolean => text === "" || /^[-–—]$/.test(text);

const AMOUNT = /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/;

/**
 * An amount as printed, in exact paisa: "30,240", "300,000.50", "-" (nothing). A negative is "-480", "(480)" or
 * "480 Cr"; "480 Dr" is positive. Null when it is not an amount at all. Never parsed through a float.
 */
export function parseArchiveAmount(raw: string): number | null {
  let text = raw.trim();
  if (isNothing(text)) return 0;
  let negative = false;
  const suffix = /\s*(Cr|Dr)\.?$/i.exec(text);
  if (suffix) {
    negative = suffix[1].toLowerCase() === "cr";
    text = text.slice(0, suffix.index).trim();
  }
  if (/^\(.*\)$/.test(text)) {
    negative = !negative;
    text = text.slice(1, -1).trim();
  } else if (text.startsWith("-")) {
    negative = !negative;
    text = text.slice(1).trim();
  }
  const match = AMOUNT.exec(text);
  if (!match) return null;
  const [whole, fraction = ""] = text.replace(/,/g, "").split(".");
  const paisa = Number(whole) * PAISA_PER_RUPEE + Number(fraction.padEnd(2, "0") || "0");
  if (!Number.isSafeInteger(paisa)) return null;
  return negative && paisa !== 0 ? -paisa : paisa;
}

/** A quantity as printed: null when blank, a number when it is one, NaN when it is something else. */
export function parseArchiveQuantity(raw: string): number | null {
  const text = raw.trim();
  if (isNothing(text)) return null;
  return /^-?\d+(?:\.\d+)?$/.test(text) ? Number(text) : Number.NaN;
}

const pad = (value: number): string => String(value).padStart(2, "0");

/** A real calendar day as YYYY-MM-DD, or null. */
const isoDay = (year: number, month: number, day: number): string | null => {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(year)}-${pad(month)}-${pad(day)}`;
};

/**
 * A date as printed, as YYYY-MM-DD. The old software prints DD/MM/YYYY (Pakistan); YYYY-MM-DD is accepted too. A
 * two-digit year, or a day that does not exist, is refused rather than guessed.
 */
export function parseArchiveDate(raw: string): string | null {
  const text = raw.trim();
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
  if (dmy) return isoDay(Number(dmy[3]), Number(dmy[2]), Number(dmy[1]));
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (ymd) return isoDay(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]));
  return null;
}

// ─── Reading one row ────────────────────────────────────────────────────────

/** A row every rule accepted, with its original text kept beside what it was read as. */
export interface LedgerArchiveRow {
  readonly rowNumber: number;
  readonly partyCode: string;
  readonly customerName: string;
  /** Its place in its statement, from the file's sequence column, or its order in the file. */
  readonly sequence: number;
  readonly entryDate: string;
  readonly dateText: string;
  readonly voucherNumber: string;
  readonly transactionType: string;
  readonly billNumber: string;
  readonly description: string;
  readonly quantityText: string;
  readonly quantity: number | null;
  readonly debitPaisa: number;
  readonly creditPaisa: number;
  readonly balancePaisa: number;
  readonly debitText: string;
  readonly creditText: string;
  readonly balanceText: string;
}

/** Something wrong with the file, said so the person can find and fix it. */
export interface LedgerArchiveProblem {
  /** The file's line, or null for something about a whole statement. */
  readonly rowNumber: number | null;
  readonly message: string;
}

const tooLong = (value: string, max: number): boolean => value.length > max;

/** The text fields' own rules: present where needed, not absurdly long. */
function textProblems(input: LedgerArchiveRowInput): string[] {
  const problems: string[] = [];
  const max = LEDGER_ARCHIVE_LIMITS.SHORT_TEXT_MAX;
  if (!input.partyCode.trim() && !input.customerName.trim()) problems.push("it names no party (party code or name).");
  if (!input.description.trim()) problems.push("its description is empty.");
  if (tooLong(input.description, LEDGER_ARCHIVE_LIMITS.DESCRIPTION_MAX)) problems.push(`its description is longer than ${String(LEDGER_ARCHIVE_LIMITS.DESCRIPTION_MAX)} characters.`);
  if (tooLong(input.customerName.trim(), LEDGER_ARCHIVE_LIMITS.NAME_MAX)) problems.push("its party name is too long.");
  for (const [label, value] of [["party code", input.partyCode], ["voucher number", input.voucherNumber], ["type", input.transactionType], ["bill number", input.billNumber]] as const) {
    if (tooLong(value.trim(), max)) problems.push(`its ${label} is longer than ${String(max)} characters.`);
  }
  return problems;
}

type Figures = Pick<LedgerArchiveRow, "debitPaisa" | "creditPaisa" | "balancePaisa" | "quantity">;

/** The figures' own rules: real amounts, never a negative debit or credit, never both on one row. */
function figureProblems(input: LedgerArchiveRowInput): { figures: Figures | null; problems: string[] } {
  const problems: string[] = [];
  const debit = parseArchiveAmount(input.debit);
  const credit = parseArchiveAmount(input.credit);
  const balance = isNothing(input.runningBalance.trim()) ? null : parseArchiveAmount(input.runningBalance);
  const quantity = parseArchiveQuantity(input.quantity);
  if (debit === null) problems.push(`its debit "${input.debit}" is not an amount.`);
  if (credit === null) problems.push(`its credit "${input.credit}" is not an amount.`);
  if (balance === null) problems.push(input.runningBalance.trim() ? `its balance "${input.runningBalance}" is not an amount.` : "its running balance is empty.");
  if (quantity !== null && Number.isNaN(quantity)) problems.push(`its quantity "${input.quantity}" is not a number.`);
  if (debit !== null && debit < 0) problems.push("its debit is negative.");
  if (credit !== null && credit < 0) problems.push("its credit is negative.");
  if (debit !== null && credit !== null && debit > 0 && credit > 0) problems.push("it has both a debit and a credit.");
  if (problems.length > 0 || debit === null || credit === null || balance === null) return { figures: null, problems };
  return { figures: { debitPaisa: debit, creditPaisa: credit, balancePaisa: balance, quantity }, problems };
}

/** One row read and checked on its own. `position` is its order in the file, used when it has no sequence. */
export function readArchiveRow(input: LedgerArchiveRowInput, position: number): { row: LedgerArchiveRow | null; problems: LedgerArchiveProblem[] } {
  const messages = textProblems(input);
  const entryDate = parseArchiveDate(input.transactionDate);
  if (entryDate === null) messages.push(input.transactionDate.trim() ? `its date "${input.transactionDate}" is not a day (use DD/MM/YYYY).` : "its date is empty.");
  const sequenceText = input.sequence.trim();
  const sequence = sequenceText === "" ? position : /^\d{1,7}$/.test(sequenceText) && Number(sequenceText) > 0 ? Number(sequenceText) : null;
  if (sequence === null) messages.push(`its sequence "${input.sequence}" is not a whole number from 1.`);
  const { figures, problems } = figureProblems(input);
  messages.push(...problems);
  if (messages.length > 0 || entryDate === null || sequence === null || figures === null) {
    return { row: null, problems: messages.map((message) => ({ rowNumber: input.rowNumber, message: `Row ${String(input.rowNumber)}: ${message}` })) };
  }
  return {
    row: {
      rowNumber: input.rowNumber,
      partyCode: input.partyCode.trim(),
      customerName: input.customerName.trim().replace(/\s+/g, " "),
      sequence,
      entryDate,
      dateText: input.transactionDate.trim(),
      voucherNumber: input.voucherNumber.trim(),
      transactionType: input.transactionType.trim().toUpperCase(),
      billNumber: input.billNumber.trim(),
      // Kept as written, line breaks included: only the ends are trimmed.
      description: input.description.replace(/\r\n?/g, "\n").trim(),
      quantityText: input.quantity.trim(),
      debitText: input.debit.trim(),
      creditText: input.credit.trim(),
      balanceText: input.runningBalance.trim(),
      ...figures,
    },
    problems: [],
  };
}

// ─── One customer's statement ───────────────────────────────────────────────

/** The figures a statement's rows add up to. Derived, never typed in. */
export interface LedgerArchiveTotals {
  readonly rowCount: number;
  readonly periodFrom: string;
  readonly periodTo: string;
  /** The balance before the first row moved it. */
  readonly openingBalancePaisa: number;
  /** The last row's balance, as printed. */
  readonly closingBalancePaisa: number;
  readonly totalDebitPaisa: number;
  readonly totalCreditPaisa: number;
  readonly totalQuantity: number;
}

/** One party's rows from one file, in their order, with what they add up to. */
export interface LedgerArchiveStatementDraft {
  readonly side: LedgerArchiveSide;
  /** The rule its running balances follow, as printed. */
  readonly balanceRule: ArchiveBalanceRule;
  /** The customer as the file names them: their code, or their name when there is no code. */
  readonly key: string;
  readonly partyCode: string;
  readonly customerName: string;
  readonly rows: readonly LedgerArchiveRow[];
  readonly totals: LedgerArchiveTotals;
  /** Mistakes: the statement is not imported while it has any. */
  readonly problems: readonly LedgerArchiveProblem[];
  /** Things worth a look that do not stop it: a repeated row, a date out of order. */
  readonly warnings: readonly LedgerArchiveProblem[];
}

export const formatArchivePaisa = (paisa: number): string => {
  const rupees = Math.trunc(Math.abs(paisa) / PAISA_PER_RUPEE);
  const rest = Math.abs(paisa) % PAISA_PER_RUPEE;
  const text = `${rupees.toLocaleString("en-US")}${rest === 0 ? "" : `.${String(rest).padStart(2, "0")}`}`;
  return paisa < 0 ? `-${text}` : text;
};

/** Every running balance follows from the one before it, by the rule. The first row's balance opens the statement. */
export function balanceProblems(rows: ReadonlyArray<Pick<LedgerArchiveRow, "rowNumber" | "debitPaisa" | "creditPaisa" | "balancePaisa">>, rule: ArchiveBalanceRule = ARCHIVE_BALANCE_RULE.DEBIT_LESS_CREDIT): LedgerArchiveProblem[] {
  const problems: LedgerArchiveProblem[] = [];
  const [plus, minus] = rule === ARCHIVE_BALANCE_RULE.DEBIT_LESS_CREDIT ? ["debitPaisa", "creditPaisa"] as const : ["creditPaisa", "debitPaisa"] as const;
  for (let index = 1; index < rows.length; index += 1) {
    const before = rows[index - 1];
    const row = rows[index];
    const expected = before.balancePaisa + archiveRowMovement(row, rule);
    if (row.balancePaisa !== expected) {
      problems.push({
        rowNumber: row.rowNumber,
        message: `Row ${String(row.rowNumber)}: the balance ${formatArchivePaisa(row.balancePaisa)} does not follow from the row before (${formatArchivePaisa(before.balancePaisa)} + ${formatArchivePaisa(row[plus])} − ${formatArchivePaisa(row[minus])} = ${formatArchivePaisa(expected)}).`,
      });
    }
  }
  return problems;
}

/** What makes two rows the same entry: everything printed on them. */
export const archiveRowIdentity = (row: LedgerArchiveRow): string =>
  [row.entryDate, row.voucherNumber, row.transactionType, row.billNumber, row.description, row.quantityText, row.debitPaisa, row.creditPaisa, row.balancePaisa].join("\u001f");

function orderWarnings(rows: readonly LedgerArchiveRow[]): LedgerArchiveProblem[] {
  const warnings: LedgerArchiveProblem[] = [];
  const seen = new Map<string, number>();
  rows.forEach((row, index) => {
    const identity = archiveRowIdentity(row);
    const first = seen.get(identity);
    if (first !== undefined) warnings.push({ rowNumber: row.rowNumber, message: `Row ${String(row.rowNumber)} repeats row ${String(first)} exactly. Check it is not a duplicate.` });
    else seen.set(identity, row.rowNumber);
    if (index > 0 && row.entryDate < rows[index - 1].entryDate) {
      warnings.push({ rowNumber: row.rowNumber, message: `Row ${String(row.rowNumber)} is dated before the row above it.` });
    }
  });
  return warnings;
}

/** What a statement's rows add up to. */
export function archiveTotals(rows: readonly LedgerArchiveRow[], rule: ArchiveBalanceRule = ARCHIVE_BALANCE_RULE.DEBIT_LESS_CREDIT): LedgerArchiveTotals {
  const first = rows[0];
  const last = rows[rows.length - 1];
  const dates = rows.map((row) => row.entryDate).sort();
  const sum = (pick: (row: LedgerArchiveRow) => number): number => rows.reduce((total, row) => total + pick(row), 0);
  return {
    rowCount: rows.length,
    periodFrom: dates[0] ?? "",
    periodTo: dates[dates.length - 1] ?? "",
    openingBalancePaisa: first ? first.balancePaisa - archiveRowMovement(first, rule) : 0,
    closingBalancePaisa: last ? last.balancePaisa : 0,
    totalDebitPaisa: sum((row) => row.debitPaisa),
    totalCreditPaisa: sum((row) => row.creditPaisa),
    // Quantities are dozens, and may be halves: summed in hundredths so 0.5 + 0.25 stays exact.
    totalQuantity: sum((row) => Math.round((row.quantity ?? 0) * 100)) / 100,
  };
}

/**
 * The rule a statement's rows follow: the side's expected one when they follow it, else the side's other allowed
 * rule when every row follows that instead. With neither, the expected rule and its problems.
 */
function chosenRule(rows: readonly LedgerArchiveRow[], side: LedgerArchiveSide): { rule: ArchiveBalanceRule; problems: LedgerArchiveProblem[]; warnings: LedgerArchiveProblem[] } {
  const [expected, ...others] = SIDE_RULES[side];
  const problems = balanceProblems(rows, expected);
  if (problems.length === 0) return { rule: expected, problems, warnings: [] };
  const fitting = others.find((rule) => balanceProblems(rows, rule).length === 0);
  if (fitting === undefined) return { rule: expected, problems, warnings: [] };
  return { rule: fitting, problems: [], warnings: [{ rowNumber: null, message: "Its balances run debit less credit (as a customer ledger does). They are kept as printed." }] };
}

/** One statement's rows, put in order and checked as a whole. */
export function checkArchiveStatement(
  key: string,
  rows: readonly LedgerArchiveRow[],
  side: LedgerArchiveSide = LEDGER_ARCHIVE_SIDE.CUSTOMER,
  /** The rule the source is KNOWN to print (a recognised report): used as it is, never detected. */
  knownRule?: ArchiveBalanceRule
): LedgerArchiveStatementDraft {
  const ordered = [...rows].sort((a, b) => a.sequence - b.sequence);
  const problems: LedgerArchiveProblem[] = [];
  const sequences = new Set<number>();
  for (const row of ordered) {
    if (sequences.has(row.sequence)) problems.push({ rowNumber: row.rowNumber, message: `Row ${String(row.rowNumber)}: sequence ${String(row.sequence)} is used twice for this party.` });
    sequences.add(row.sequence);
  }
  if (ordered.length > LEDGER_ARCHIVE_LIMITS.MAX_STATEMENT_ROWS) {
    problems.push({ rowNumber: null, message: `This party has more than ${String(LEDGER_ARCHIVE_LIMITS.MAX_STATEMENT_ROWS)} rows. Split the file by period.` });
  }
  const names = new Set(ordered.map((row) => row.customerName).filter(Boolean));
  if (names.size > 1) problems.push({ rowNumber: null, message: `The same party code is given different names: ${[...names].join(", ")}.` });
  const balances = knownRule ? { rule: knownRule, problems: balanceProblems(ordered, knownRule), warnings: [] } : chosenRule(ordered, side);
  problems.push(...balances.problems);
  return {
    side,
    balanceRule: balances.rule,
    key,
    partyCode: ordered[0]?.partyCode ?? "",
    customerName: ordered.find((row) => row.customerName)?.customerName ?? "",
    rows: ordered,
    totals: archiveTotals(ordered, balances.rule),
    problems,
    warnings: [...balances.warnings, ...orderWarnings(ordered)],
  };
}

/** The customer a row belongs to in its file: their code, or their name when the file has no code. */
export const archiveStatementKey = (row: Pick<LedgerArchiveRowInput, "partyCode" | "customerName">): string => {
  const code = row.partyCode.trim();
  return code ? `code:${code}` : `name:${row.customerName.trim().replace(/\s+/g, " ").toUpperCase()}`;
};

/** A file's rows, as read, by the customer they belong to, in the order each customer first appears. */
export function groupArchiveRows(inputs: readonly LedgerArchiveRowInput[]): LedgerArchiveRowInput[][] {
  const groups = new Map<string, LedgerArchiveRowInput[]>();
  for (const input of inputs) {
    const key = archiveStatementKey(input);
    groups.set(key, [...(groups.get(key) ?? []), input]);
  }
  return [...groups.values()];
}

/** A whole file read: each customer's statement, and the rows that could not be read at all. */
export interface LedgerArchiveFileDraft {
  readonly statements: readonly LedgerArchiveStatementDraft[];
  /** Rows refused on their own (no date, not an amount): they belong to no statement. */
  readonly rowProblems: readonly LedgerArchiveProblem[];
  readonly rowCount: number;
}

/**
 * Reads every row and groups them by customer. A row that cannot be read is listed, and the statement it would have
 * belonged to is held back too: a statement with a missing row would have a gap in its balances.
 */
export function readArchiveFile(inputs: readonly LedgerArchiveRowInput[], side: LedgerArchiveSide = LEDGER_ARCHIVE_SIDE.CUSTOMER, knownRule?: ArchiveBalanceRule): LedgerArchiveFileDraft {
  if (inputs.length > LEDGER_ARCHIVE_LIMITS.MAX_ROWS) {
    return { statements: [], rowProblems: [{ rowNumber: null, message: `The file has more than ${String(LEDGER_ARCHIVE_LIMITS.MAX_ROWS)} rows. Split it into smaller files.` }], rowCount: inputs.length };
  }
  const groups = new Map<string, LedgerArchiveRow[]>();
  const brokenKeys = new Map<string, LedgerArchiveProblem[]>();
  const rowProblems: LedgerArchiveProblem[] = [];
  inputs.forEach((input, index) => {
    const { row, problems } = readArchiveRow(input, index + 1);
    const key = archiveStatementKey(input);
    if (row === null) {
      rowProblems.push(...problems);
      brokenKeys.set(key, [...(brokenKeys.get(key) ?? []), ...problems]);
      return;
    }
    groups.set(key, [...(groups.get(key) ?? []), row]);
  });
  const statements = [...groups.entries()].map(([key, rows]) => {
    const draft = checkArchiveStatement(key, rows, side, knownRule);
    const broken = brokenKeys.get(key) ?? [];
    return broken.length === 0 ? draft : { ...draft, problems: [{ rowNumber: null, message: `${String(broken.length)} of this party's rows could not be read (listed above).` }, ...draft.problems] };
  });
  return { statements, rowProblems, rowCount: inputs.length };
}
