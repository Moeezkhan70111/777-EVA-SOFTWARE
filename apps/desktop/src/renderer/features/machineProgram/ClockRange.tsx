import React, { useEffect, useState } from "react";
import { MINUTES_IN_DAY, clockText, formatDuration, minuteFromClock, shiftMinutes, type MachineShift } from "@erp/domain";
import { copy } from "../../config/copy";

// Two clock faces and the figure they add up to — the one control for setting a stretch of time
// on the Machine Program screens:
//
//   START              FINISH
//   ┌──────────┐       ┌──────────┐
//   │ 06:00 AM │  ──▸  │ 10:00 AM │   4 hours   [ Set time ]  [ Clear ]
//   └──────────┘       └──────────┘
//
// The shift uses it to run a machine for hours nobody typed before (06:00 to 18:00 were the only
// two choices), and a sole card uses it to say how long that colour is on the injector. One
// component for both, so the floor types a time the same way wherever it is asked (R1).
//
// The duration is the sanity check: two clock faces cannot tell you that you have planned
// twenty-three hours, and the figure can.
//
// `onSet` is given the two values as the controls hold them — "06:00", "10:00" — because what
// they mean depends on what is being timed: a finish before the start is the next morning for a
// shift, and the small hours of a night shift for a sole. @erp/domain shiftFromClocks and
// slotFromClocks make that judgement, and the caller picks the right one.

interface ClockRangeProps {
  /** The stretch the controls open on, or null to open them empty. */
  value: MachineShift | null;
  /** What the confirm button says. */
  setLabel: string;
  /** Shown when there is a saved value to take away — the sole slot has one, the shift does not. */
  onClear?: () => void;
  onSet: (startValue: string, endValue: string) => void;
}

export const ClockRange: React.FC<ClockRangeProps> = ({ value, setLabel, onClear, onSet }) => {
  const [startValue, setStartValue] = useState(value ? clockText(value.startMinute) : "");
  const [endValue, setEndValue] = useState(value ? clockText(value.endMinute) : "");

  // The controls follow the saved value: another terminal can change this program while the
  // popover is open, and the operator must not then set a time against figures that have moved.
  useEffect(() => {
    setStartValue(value ? clockText(value.startMinute) : "");
    setEndValue(value ? clockText(value.endMinute) : "");
  }, [value?.startMinute, value?.endMinute]);

  const typed = startValue !== "" && endValue !== "";
  const length = typed ? lengthOf(startValue, endValue) : null;

  return (
    <div className="mpx-clock">
      <div className="mpx-clock-fields">
        <label className="mpx-clock-field">
          <span className="mpx-clock-label">{copy.machineProgram.shiftStart}</span>
          <input type="time" className="mpx-clock-input" value={startValue} onChange={(event) => setStartValue(event.target.value)} />
        </label>
        <label className="mpx-clock-field">
          <span className="mpx-clock-label">{copy.machineProgram.shiftEnd}</span>
          <input type="time" className="mpx-clock-input" value={endValue} onChange={(event) => setEndValue(event.target.value)} />
        </label>
        {length == null ? null : <span className="mpx-clock-span">{formatDuration(length)}</span>}
      </div>
      <div className="mpx-clock-actions">
        <button type="button" className="mpx-clock-set" disabled={!typed} onClick={() => onSet(startValue, endValue)}>
          {setLabel}
        </button>
        {onClear ? (
          <button type="button" className="mpx-clock-clear" onClick={onClear}>
            {copy.machineProgram.clearTime}
          </button>
        ) : null}
      </div>
    </div>
  );
};

/**
 * How long the two clock faces are apart, reading a finish at or before the start as the next
 * morning — which is the one thing both callers agree on, and all the figure needs to know.
 */
const lengthOf = (startValue: string, endValue: string): number | null => {
  const start = minuteFromClock(startValue);
  const end = minuteFromClock(endValue);
  if (start == null || end == null) return null;
  return shiftMinutes({ startMinute: start, endMinute: end <= start ? end + MINUTES_IN_DAY : end });
};
