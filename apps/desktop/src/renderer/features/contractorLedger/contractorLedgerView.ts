import { RATE_SOURCE, fromPaisa, type ContractorRole, type ContractorWorkLine } from "@erp/domain";
import { formatMoney } from "../../app/format";
import { copy } from "../../config/copy";
import { toIsoDate } from "../../utils/dates";

// How the Contractor Ledger says things. Presentation only: every figure arrives worked out from
// the main process (@erp/domain contractorLedger.ts) and is only formatted here.

const text = copy.contractorLedger;

/** `Rs 700.00` from integer paisa. */
export const rupees = (paisa: number): string => `${copy.machineProgram.rupeePrefix} ${formatMoney(fromPaisa(paisa))}`;

/** `700.00` from integer paisa — for table columns that already say Rs in their heading. */
export const amount = (paisa: number): string => formatMoney(fromPaisa(paisa));

/** `10 DZN`, `2.5 DZN`. */
export const dozensText = (dozens: number): string =>
  `${Number.isInteger(dozens) ? dozens : dozens.toLocaleString(undefined, { maximumFractionDigits: 1 })} DZN`;

export const roleLabel = (role: ContractorRole): string => text.roles[role];

/** Where a line's rate came from, said in words. */
export const rateSourceLabel = (line: ContractorWorkLine): string => {
  if (line.ratePaisa == null) return text.notPriced;
  return line.rateSource === RATE_SOURCE.PROGRAM ? text.programRate : text.productRate;
};

/** `10 DZN × Rs 70.00 = Rs 700.00`, or "Not priced". */
export const calculationText = (line: ContractorWorkLine): string =>
  line.ratePaisa == null
    ? text.notPriced
    : `${dozensText(line.dozens)} × ${rupees(line.ratePaisa)} = ${rupees(line.amountPaisa)}`;

/** The first of this month to today, in Pakistan. */
export const thisMonth = (): { fromDate: string; toDate: string } => {
  const today = toIsoDate();
  return { fromDate: `${today.slice(0, 8)}01`, toDate: today };
};
