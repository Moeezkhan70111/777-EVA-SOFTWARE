import React, { useEffect, useRef, useState } from "react";
import { formatShiftRange, slotFromClocks, soleSlotOf, type MachineShift } from "@erp/domain";
import type { MachineProgramRunRecord } from "../../types/desktopApi";
import { copy } from "../../config/copy";
import { ClockRange } from "./ClockRange";
import { ClockIcon } from "./MachineProgramIcons";
import type { ProgramWrites } from "./useProgramWrites";

// How long this sole is on the injector, on the sole card's own header:
//
//   ● Black Sole                    ◷ 06:00 AM – 10:00 AM    🗑
//                                   ┌──────────────────────────────┐
//                                   │ START ──▸ FINISH  4 hours    │
//                                   │ [ Set time ]      [ Clear ]  │
//                                   └──────────────────────────────┘
//
// The shift says how long the MACHINE runs. This says which sole is on it when — the answer a
// minder standing at the machine needs when an injector changes colour halfway through the day.
//
// Untimed reads "Full shift", because that is what one sole on an injector has always meant and
// what the sheet has always printed. Clearing a time puts it back to that.
//
// The times are saved against the sole COLOUR, not the article: every run of this colour on this
// injector is written together (SetMachineProgramSoleSlotUseCase), so the card the floor reads
// has one answer. The backend refuses hours outside the shift, and its sentence is shown here
// rather than guessed at.

interface SoleTimeProps {
  colour: string;
  /** Every run of this colour on this injector — they all carry the same slot. */
  runs: MachineProgramRunRecord[];
  /** The shift the program runs, which the sole's hours have to sit inside. */
  shift: MachineShift;
  injectorNo: number;
  writes: ProgramWrites;
}

export const SoleTime: React.FC<SoleTimeProps> = ({ colour, runs, shift, injectorNo, writes }) => {
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  const programId = runs[0]?.programId ?? null;
  const slot = runs[0] ? soleSlotOf(runs[0]) : null;
  const soleName = copy.machineProgram.soleLine(colour);

  const close = () => {
    setProblem(null);
    setOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  const save = async (next: MachineShift | null) => {
    if (!programId) return;
    const answer = await writes.setSoleSlot(programId, injectorNo, colour, next);
    if (answer.ok) {
      close();
      return;
    }
    setProblem(answer.reason);
  };

  const setTyped = (startValue: string, endValue: string) => {
    const typed = slotFromClocks(startValue, endValue, shift);
    if (!typed) {
      setProblem(copy.machineProgram.shiftInvalid);
      return;
    }
    void save(typed);
  };

  return (
    <div className="mpx-sole-time" ref={box}>
      <button
        type="button"
        className={`mpx-sole-time-btn${slot ? " is-timed" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${copy.machineProgram.soleTimeOf(soleName)} — ${slot ? formatShiftRange(slot) : copy.machineProgram.fullShift}`}
        disabled={!programId}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <ClockIcon className="mpx-sole-time-icon" />
        <span>{slot ? formatShiftRange(slot) : copy.machineProgram.fullShift}</span>
      </button>

      {open ? (
        <div className="mpx-popover mpx-sole-time-pop" role="dialog" aria-label={copy.machineProgram.soleTimeOf(soleName)}>
          <ClockRange
            value={slot ?? shift}
            setLabel={copy.machineProgram.setTime}
            onSet={setTyped}
            onClear={slot ? () => void save(null) : undefined}
          />
          {problem ? (
            <p className="mpx-clock-problem" role="alert">
              {problem}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};
