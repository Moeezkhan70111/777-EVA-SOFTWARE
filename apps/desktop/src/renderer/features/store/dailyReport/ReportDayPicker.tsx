import React from "react";
import { copy } from "../../../config/copy";
import { formatDate, shiftIsoDate, toIsoDate } from "../../../utils/dates";

// Which day the report is for:  [‹] [ 13/10/2026 ] [›]  Today  Refresh     Mon, 13 Oct 2026
//
// A report is for a day that has happened, so the picker never goes past today.

const text = copy.storeDailyReport;

interface ReportDayPickerProps {
  date: string;
  onChange: (date: string) => void;
  onRefresh: () => void;
  busy: boolean;
}

export const ReportDayPicker: React.FC<ReportDayPickerProps> = ({ date, onChange, onRefresh, busy }) => {
  const today = toIsoDate();
  return (
    <div className="sdr-day" role="group" aria-label={text.dayLabel}>
      <button type="button" className="btn btn-secondary sdr-day-step" aria-label={text.previousDay} onClick={() => onChange(shiftIsoDate(date, -1))}>
        <span aria-hidden="true">‹</span>
      </button>
      <input
        type="date"
        className="form-input sdr-day-input"
        aria-label={text.dayLabel}
        value={date}
        max={today}
        // An emptied field keeps the day shown rather than loading nothing.
        onChange={(event) => event.target.value && onChange(event.target.value)}
      />
      <button
        type="button"
        className="btn btn-secondary sdr-day-step"
        aria-label={text.nextDay}
        disabled={date >= today}
        onClick={() => onChange(shiftIsoDate(date, 1))}
      >
        <span aria-hidden="true">›</span>
      </button>
      <button type="button" className="btn btn-secondary" disabled={date === today} onClick={() => onChange(today)}>
        {text.today}
      </button>
      <button type="button" className="btn btn-secondary" disabled={busy} onClick={onRefresh}>
        {copy.common.refresh}
      </button>
      <span className="sdr-day-name">{formatDate(date)}</span>
    </div>
  );
};
