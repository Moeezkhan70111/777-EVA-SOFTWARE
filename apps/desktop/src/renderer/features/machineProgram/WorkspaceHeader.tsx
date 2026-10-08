import React from "react";
import { formatShiftRange, type MachineShift } from "@erp/domain";
import type { MachineProgramRecord } from "../../types/desktopApi";
import { copy } from "../../config/copy";
import { HeaderSelect, type HeaderOption } from "./HeaderControl";
import { ClockIcon, GearIcon } from "./MachineProgramIcons";
import { ProgramDate } from "./ProgramDate";
import { shiftChoices, shiftId } from "./machineProgram";

// The bar across the top: what this screen is, then the two things it is about — which shift and
// which day — and the one action that takes a finished program off the screen.
//
//   ⚙  Machine Program          SHIFT TIME        PROGRAM DATE        [ Print Program ]
//
// WHICH MACHINE is no longer here: it was a dropdown, and it is now the strip of machines under
// this bar (MachinesStrip), where every machine says how its day stands without being opened.
//
// Print is the end of the journey, not a save: every change is already saved the moment it is
// made, so there is no Save button to press and nothing to lose by walking away.

interface WorkspaceHeaderProps {
  date: string;
  today: string;
  /** The shift being shown: the saved program's, or the one a new program would be made with. */
  shift: MachineShift;
  /** The saved program for this machine and date, or null when there is nothing on it. */
  program: MachineProgramRecord | null;
  onShiftChange: (shift: MachineShift) => void;
  onDateChange: (ymd: string) => void;
  onPrint: () => void;
}

export const WorkspaceHeader: React.FC<WorkspaceHeaderProps> = ({
  date,
  today,
  shift,
  program,
  onShiftChange,
  onDateChange,
  onPrint,
}) => {
  const shiftOptions: HeaderOption[] = shiftChoices(shift).map((option) => ({
    id: shiftId(option),
    label: formatShiftRange(option),
  }));

  return (
    <header className="mpx-head">
      <div className="mpx-head-title">
        <span className="mpx-head-mark" aria-hidden="true">
          <GearIcon />
        </span>
        <h1 className="mpx-title">{copy.machineProgram.title}</h1>
      </div>

      <div className="mpx-head-controls">
        <HeaderSelect
          label={copy.machineProgram.shiftTime}
          icon={<ClockIcon />}
          options={shiftOptions}
          selectedId={shiftId(shift)}
          placeholder={copy.machineProgram.shiftTime}
          onChoose={(id) => {
            const chosen = shiftChoices(shift).find((option) => shiftId(option) === id);
            if (chosen) onShiftChange(chosen);
          }}
        />

        <ProgramDate variant="control" value={date} today={today} onChange={onDateChange} />

        <button type="button" className="mpx-head-action" disabled={!program} onClick={onPrint}>
          {copy.machineProgram.printProgram}
        </button>
      </div>
    </header>
  );
};
