import React, { useMemo, useState } from "react";
import { copy } from "../../config/copy";
import { formatLongDate, formatMonthYear, mondayFirstWeekday, shiftIsoDate } from "../../utils/dates";

// A small month calendar for "choose another date". One month at a time, big enough to tap, the
// chosen day filled and today ringed. Days are plain YYYY-MM-DD calendar days — no timezone
// arithmetic happens here, every conversion is in utils/dates.

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const firstOfMonth = (ymd: string): string => `${ymd.slice(0, 7)}-01`;
const shiftMonth = (firstDay: string, months: number): string => {
  const year = Number(firstDay.slice(0, 4));
  const month = Number(firstDay.slice(5, 7)) - 1 + months;
  const shifted = new Date(Date.UTC(year, month, 1));
  return shifted.toISOString().slice(0, 10);
};

/** Every day of the month, padded with blanks so the 1st falls under its weekday. */
const monthCells = (firstDay: string): Array<string | null> => {
  const cells: Array<string | null> = Array.from({ length: mondayFirstWeekday(firstDay) }, () => null);
  for (let day = firstDay; day.slice(0, 7) === firstDay.slice(0, 7); day = shiftIsoDate(day, 1)) cells.push(day);
  return cells;
};

interface MiniCalendarProps {
  value: string;
  today: string;
  onChoose: (ymd: string) => void;
}

export const MiniCalendar: React.FC<MiniCalendarProps> = ({ value, today, onChoose }) => {
  const [month, setMonth] = useState(firstOfMonth(value));
  const cells = useMemo(() => monthCells(month), [month]);

  return (
    <div className="mp-calendar">
      <div className="mp-calendar-head">
        <button type="button" className="mp-calendar-nav" aria-label={copy.machineProgram.previousMonth} onClick={() => setMonth(shiftMonth(month, -1))}>
          ‹
        </button>
        <span className="mp-calendar-month">{formatMonthYear(month)}</span>
        <button type="button" className="mp-calendar-nav" aria-label={copy.machineProgram.nextMonth} onClick={() => setMonth(shiftMonth(month, 1))}>
          ›
        </button>
      </div>
      <div className="mp-calendar-grid" role="grid">
        {WEEKDAYS.map((weekday) => (
          <span key={weekday} className="mp-calendar-weekday" aria-hidden="true">
            {weekday}
          </span>
        ))}
        {cells.map((day, index) =>
          day ? (
            <button
              key={day}
              type="button"
              className={`mp-calendar-day${day === value ? " is-selected" : ""}${day === today ? " is-today" : ""}`}
              aria-pressed={day === value}
              aria-label={formatLongDate(day)}
              onClick={() => onChoose(day)}
            >
              {Number(day.slice(8))}
            </button>
          ) : (
            <span key={`blank-${index}`} />
          )
        )}
      </div>
    </div>
  );
};
