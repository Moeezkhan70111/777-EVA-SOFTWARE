import React from "react";
import { copy } from "../../config/copy";
import { toIsoDate } from "../../utils/dates";
import { LEDGER_PERIOD, periodOf, periodStart, type LedgerPeriod } from "./ledgerPeriods";

// The ledger's period: four ranges to pick (Hick's law: four, not a calendar), and the two dates for anything else.

const text = copy.customerLedger;
const PERIODS: readonly LedgerPeriod[] = [LEDGER_PERIOD.MONTH, LEDGER_PERIOD.QUARTER, LEDGER_PERIOD.YEAR, LEDGER_PERIOD.ALL];

interface PeriodBarProps {
  fromDate: string;
  toDate: string;
  onFrom: (date: string) => void;
  onTo: (date: string) => void;
}

export const PeriodBar: React.FC<PeriodBarProps> = ({ fromDate, toDate, onFrom, onTo }) => {
  const today = toIsoDate();
  const chosen = periodOf(fromDate, toDate, today);
  const pick = (period: LedgerPeriod) => { onFrom(periodStart(period, today)); onTo(today); };
  return (
    <div className="cl-period" role="group" aria-label={text.periodLabel}>
      <div className="sa-toggle cl-period-presets">
        {PERIODS.map((period) => (
          <button key={period} type="button" className={period === chosen ? "sa-toggle-btn is-on" : "sa-toggle-btn"} aria-pressed={period === chosen} onClick={() => pick(period)}>
            {text.periods[period]}
          </button>
        ))}
      </div>
      <div className="cl-period-dates">
        <input className="input" aria-label={copy.filters.fromDate} type="date" value={fromDate} max={toDate} onChange={(event) => onFrom(event.target.value)} />
        <span aria-hidden="true">{text.to}</span>
        <input className="input" aria-label={copy.filters.toDate} type="date" value={toDate} min={fromDate} onChange={(event) => onTo(event.target.value)} />
      </div>
    </div>
  );
};
