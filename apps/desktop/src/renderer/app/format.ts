import { APP_TIMEZONE, cartonsToDozens, roundMoney } from "@erp/domain";

export { formatDate, formatDateTime, formatRelative, formatDateRange, formatTime } from "../utils/dates";

// Money display. Amounts are rupees (see @erp/domain money.ts for the arithmetic rules);
// this is the ONE formatter for currency on screen and in print-outs.
const moneyFormatter = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const formatMoney = (value: number): string => moneyFormatter.format(roundMoney(value));

// Ledgers, balances and voucher lists show whole rupees (the books never carry paisa on
// these pages). Identical output to the per-page `fmtNum` helpers it replaces.
const wholeMoneyFormatter = new Intl.NumberFormat("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });

export const formatWholeMoney = (value: number): string => wholeMoneyFormatter.format(value);

// Stock is stored in cartons; product and stock screens show it in dozens (whole when
// exact, otherwise one decimal). The conversion itself lives in @erp/domain.
export const formatDozens = (cartons: number): string => {
  const dozens = cartonsToDozens(cartons);
  return Number.isInteger(dozens)
    ? dozens.toLocaleString()
    : dozens.toLocaleString(undefined, { maximumFractionDigits: 1 });
};

/** @deprecated Use `formatMoney`. Kept so existing call sites keep working. */
export const money = formatMoney;

/**
 * @deprecated Use `formatDateTime` from utils/dates. Kept for existing call sites; it
 * now formats in the business timezone like everything else.
 */
export const toLocal = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${new Intl.DateTimeFormat("en-GB", { dateStyle: "short", timeZone: APP_TIMEZONE }).format(date)} ${new Intl.DateTimeFormat("en-GB", { timeStyle: "medium", timeZone: APP_TIMEZONE }).format(date)}`;
};
