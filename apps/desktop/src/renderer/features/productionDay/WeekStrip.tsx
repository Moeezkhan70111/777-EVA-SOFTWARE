import React from "react";
import { copy } from "../../config/copy";
import { formatShortDayMonth, formatShortWeekday } from "../../utils/dates";
import { dozenFigure } from "../cartonStock/CartonMatrix";
import { barHeights, type WeekDay } from "./dayInsights";

// THE WEEK AROUND THE DAY SHOWN (owner, 25 Nov 2026: the page was "too boring"): seven days, each a button with its
// weekday, date, dozens and a bar against the week's best day. The day shown is the strong bar (one hue, two steps:
// the chart's own rule, never a second colour), a completed day carries a ✓ in words too, and a click opens that day.
// It doubles as the way between days, recognised rather than typed (the date box stays for anything older).
//
// Single series, so no legend: each bar is named by its own label and its button's accessible name; figures are in
// the ink colours, never the bar's.

const text = copy.productionDay;

interface WeekStripProps {
  days: readonly WeekDay[];
  loading: boolean;
  selected: string;
  onSelect: (date: string) => void;
}

export const WeekStrip: React.FC<WeekStripProps> = ({ days, loading, selected, onSelect }) => {
  const heights = barHeights(days);
  return (
    <section className="pd-week" aria-label={text.weekLabel} aria-busy={loading || undefined}>
      <h2 className="pd-week-title">{text.weekLabel}</h2>
      <div className="pd-week-days">
        {days.map((day, index) => {
          const dozens = day.cartons === null ? "–" : dozenFigure(day.cartons);
          const label = text.weekDay(formatShortDayMonth(day.date), dozens, day.complete);
          const isSelected = day.date === selected;
          return (
            <button key={day.date} type="button" className={isSelected ? "pd-week-day is-selected" : "pd-week-day"} aria-pressed={isSelected}
              aria-label={label} title={label} onClick={() => onSelect(day.date)}>
              <span className="pd-week-figure">{dozens}</span>
              <span className="pd-week-track" aria-hidden="true">
                <span className="pd-week-bar" style={{ blockSize: `${String(heights[index] ?? 0)}%` }} />
              </span>
              <span className="pd-week-name">{formatShortWeekday(day.date)}{day.complete ? " ✓" : ""}</span>
              <span className="pd-week-date">{formatShortDayMonth(day.date)}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
};
