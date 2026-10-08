import React, { useState } from "react";
import { copy } from "../../config/copy";
import { formatLongDate, shiftIsoDate } from "../../utils/dates";
import { HeaderControl } from "./HeaderControl";
import { CalendarIcon } from "./MachineProgramIcons";
import { MiniCalendar } from "./MiniCalendar";
import { relativeDayLabel } from "./machineProgram";

// PROGRAM DATE — the day being planned, said the way a person says it, and changed the way the
// three days people actually mean are chosen: today, tomorrow, yesterday as big buttons, with a
// small calendar for anything else.
//
// Two shapes, one behaviour:
//
//   block    PROGRAM FOR / Today / Sunday, 4 October 2026     [ Change date ]
//   control  a labelled control in the workspace header, opening the same picker below it
//
// The chosen day is on screen the whole time either way, so nobody has to remember which day
// they are programming.

interface ProgramDateProps {
  value: string;
  today: string;
  onChange: (ymd: string) => void;
  /** A slimmer strip, where the surrounding cards carry most of the weight. */
  compact?: boolean;
  /** `control` draws it as one control in the workspace header rather than its own strip. */
  variant?: "block" | "control";
}

export const ProgramDate: React.FC<ProgramDateProps> = ({ value, today, onChange, compact = false, variant = "block" }) => {
  const [open, setOpen] = useState(false);
  const [calendar, setCalendar] = useState(false);
  const relative = relativeDayLabel(value, today);

  const choose = (ymd: string) => {
    onChange(ymd);
    setOpen(false);
    setCalendar(false);
  };

  const picker = (
    <div className={variant === "control" ? "mpx-date-panel" : "mp-date-picker"}>
      <div className="mp-date-quick">
        {quickDays(today).map((option) => (
          <button
            key={option.label}
            type="button"
            className={`mp-date-option${option.day === value ? " is-selected" : ""}`}
            aria-pressed={option.day === value}
            onClick={() => choose(option.day)}
          >
            {option.label}
          </button>
        ))}
        <button
          type="button"
          className={`mp-date-option${calendar ? " is-selected" : ""}`}
          aria-expanded={calendar}
          onClick={() => setCalendar(!calendar)}
        >
          {copy.machineProgram.chooseAnotherDate}
        </button>
      </div>
      {calendar ? <MiniCalendar value={value} today={today} onChoose={choose} /> : null}
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>
        {copy.machineProgram.closeDatePicker}
      </button>
    </div>
  );

  if (variant === "control") {
    const said = relative ? `${relative}, ${formatLongDate(value)}` : formatLongDate(value);
    return (
      <HeaderControl
        label={copy.machineProgram.programDate}
        icon={<CalendarIcon />}
        value={said}
        ariaLabel={`${copy.machineProgram.programDate} — ${said}`}
        open={open}
        onToggle={() => setOpen(!open)}
        onClose={() => {
          setOpen(false);
          setCalendar(false);
        }}
      >
        {picker}
      </HeaderControl>
    );
  }

  return (
    <section className={`mp-date${compact ? " mp-date--compact" : ""}`} aria-label={copy.machineProgram.programDate}>
      <div className="mp-date-now">
        <span className="mp-eyebrow">{copy.machineProgram.programFor}</span>
        {relative ? <span className="mp-date-relative">{relative}</span> : null}
        <span className="mp-date-long">{formatLongDate(value)}</span>
      </div>

      {!open ? (
        <button type="button" className="btn btn-secondary" onClick={() => setOpen(true)}>
          {copy.machineProgram.changeDate}
        </button>
      ) : (
        picker
      )}
    </section>
  );
};

/** The three days people actually mean, in the order they mean them. */
const quickDays = (today: string): Array<{ label: string; day: string }> => [
  { label: copy.machineProgram.today, day: today },
  { label: copy.machineProgram.tomorrow, day: shiftIsoDate(today, 1) },
  { label: copy.machineProgram.yesterday, day: shiftIsoDate(today, -1) },
];
