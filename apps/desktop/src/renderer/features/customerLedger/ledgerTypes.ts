// What the Customer Ledger reads from the main process (getCustomerLedgerWithCash). Amounts arrive in rupees,
// worked out there from paisa; the screen adds nothing that decides a balance.

export const LEDGER_TYPE = {
  SALE: "SALE",
  SALE_RETURN: "SALE_RETURN",
  CASH_RECEIPT: "CASH_RECEIPT",
  CASH_PAYMENT: "CASH_PAYMENT",
  /** The customer's opening balance carried in from the old software (docs/53). Not a voucher. */
  OPENING_BALANCE: "OPENING_BALANCE",
} as const;
export type LedgerType = (typeof LEDGER_TYPE)[keyof typeof LEDGER_TYPE];

export interface LedgerLineItem { id: string; article: string; color: string; size: string; groupName: string | null; quantity: number; unitPrice: number; discount: number; totalPrice: number }

export interface LedgerEntry {
  voucherId: string;
  voucherNumber: string;
  voucherDate: string;
  voucherType: LedgerType;
  description: string;
  modeOfTransfer?: string;
  onlineFrom?: string;
  onlineTo?: string;
  bankAccountTitle?: string;
  chequeNumber?: string;
  chequeDate?: string;
  referenceNo?: string;
  debitAmount: number;
  creditAmount: number;
  balance: number;
  lineItems?: LedgerLineItem[];
}

export interface CustomerLedgerData {
  partyName: string;
  balanceLimit: number | null;
  /** Brought forward: everything before the period: the old software's balance then, plus every ERP entry before it. */
  openingBalance: number;
  /** The balance at the end of the period. Positive: the customer owes us. */
  closingBalance: number;
  /** What of closingBalance is the old software's ledger, as of the period's end. 0 with no old ledger. */
  oldLedgerBalance: number;
  entries: LedgerEntry[];
}

/** Only sale vouchers and cash vouchers open a voucher; an opening balance or a return has none to show here. */
export const opensVoucher = (type: LedgerType): boolean =>
  type === LEDGER_TYPE.SALE || type === LEDGER_TYPE.CASH_RECEIPT || type === LEDGER_TYPE.CASH_PAYMENT;
