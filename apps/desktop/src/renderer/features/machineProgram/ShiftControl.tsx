import React, { useState } from "react";
import { formatShiftRange, sameMachineShift, shiftFromClocks, type MachineShift } from "@erp/domain";
import { copy } from "../../config/copy";
import { HeaderControl } from "./HeaderControl";
import { ClockRange } from "./ClockRange";
import { ClockIcon } from "./MachineProgramIcons";
import { shiftChoices, shiftId } from "./machineProgram";

// SHIFT TIME — the two shifts the floor works, and the clock for any other hours:
//
//   ┌───────────────────────────┐
//   │ 06:00 AM – 06:00 PM     ✓ │
//   │ 06:00 PM – 06:00 AM       │
//   ├───────────────────────────┤
//   │ START ──▸ FINISH  [ Set ] │
//   └───────────────────────────┘
//
// The presets stay first because they are what nearly every program runs. The clock is under
// them for the day a machine runs 08:00 to 14:00, which the backend has always accepted — any
// whole minutes, any length up to two days — and only this screen refused to offer.
//
// An hour typed here that is not a preset becomes the control's value, so the header shows the
// hours the program actually runs rather than the nearest standard shift.

interface ShiftControlProps {
  /** The shift being shown: the saved program's, or the one a new program would be made with. */
  shift: MachineShift;
  onChange: (shift: MachineShift) => void;
}

export const ShiftControl: React.FC<ShiftControlProps> = ({ shift, onChange }) => {
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const choices = shiftChoices(shift);

  const choose = (chosen: MachineShift) => {
    setProblem(null);
    setOpen(false);
    if (!sameMachineShift(chosen, shift)) onChange(chosen);
  };

  const setTyped = (startValue: string, endValue: string) => {
    const typed = shiftFromClocks(startValue, endValue);
    if (!typed) {
      setProblem(copy.machineProgram.shiftInvalid);
      return;
    }
    choose(typed);
  };

  return (
    <HeaderControl
      label={copy.machineProgram.shiftTime}
      icon={<ClockIcon />}
      value={formatShiftRange(shift)}
      ariaLabel={`${copy.machineProgram.shiftTime} — ${formatShiftRange(shift)}`}
      open={open}
      onToggle={() => setOpen(!open)}
      onClose={() => {
        setProblem(null);
        setOpen(false);
      }}
    >
      <ul className="mpx-options" role="listbox" aria-label={copy.machineProgram.shiftTime}>
        {choices.map((option) => (
          <li key={shiftId(option)}>
            <button
              type="button"
              role="option"
              aria-selected={sameMachineShift(option, shift)}
              className={`mpx-option${sameMachineShift(option, shift) ? " is-selected" : ""}`}
              onClick={() => choose(option)}
            >
              <span className="mpx-option-label">{formatShiftRange(option)}</span>
              {sameMachineShift(option, shift) ? (
                <span className="mpx-option-mark" aria-hidden="true">
                  ✓
                </span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>

      <div className="mpx-popover-foot">
        <span className="mpx-popover-head">{copy.machineProgram.customShift}</span>
        <ClockRange value={shift} setLabel={copy.machineProgram.setTime} onSet={setTyped} />
        {problem ? (
          <p className="mpx-clock-problem" role="alert">
            {problem}
          </p>
        ) : null}
      </div>
    </HeaderControl>
  );
};
