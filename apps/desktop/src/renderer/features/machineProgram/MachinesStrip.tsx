import React from "react";
import type { MachineProgramBoardRow, MachineRecord } from "../../types/desktopApi";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import { AddMachineField } from "./AddMachineField";
import { MachineIcon } from "./MachineProgramIcons";
import { hasContent, needsContractors, statusLabel, statusTone } from "./machineProgram";
import type { Loaded } from "./useMachineProgramData";

// The machines, across the top of the workspace, for the date the header is showing.
//
//   MACHINES  [ ▤ MACHINE 1 ]  [ ▤ MACHINE 2 ]  [ ▤ MACHINE 3 ]
//               ● Ready          ● Idle           ● Idle
//
// This was a dropdown and then a rail down the left. It is a row now, at the owner's request:
// a floor has a handful of machines, and every one of them should say how its day stands without
// anybody opening anything. The left of the screen went to the navigation rail.
//
// What a machine's state is, is always said in words; the dot only echoes it (R18). A machine
// nobody has been assigned to says so, and choosing it asks who works on it before anything else.
//
// + Add Machine sits at the end of the row for whoever may add one (machines are master data,
// gated on Stock like the rest of raw material setup); everyone else simply does not get it.

interface MachinesStripProps {
  board: Loaded<MachineProgramBoardRow[]>;
  selectedId: string | null;
  onSelect: (row: MachineProgramBoardRow) => void;
  /** Called with a machine just added from the row. Left out for a user who may not add machines. */
  onMachineAdded?: (machine: MachineRecord) => void;
}

/** What one machine says about its day, and the tone the dot takes. */
const machineState = (row: MachineProgramBoardRow): { tone: string; words: string } => {
  const program = hasContent(row.program) ? row.program : null;
  // Until BOTH contractors are set the machine cannot be programmed, so the state line says
  // what to do about it rather than what the day holds.
  if (needsContractors(row.machine)) return { tone: "none", words: copy.machineProgram.noContractorYet };
  if (!program) return { tone: "none", words: copy.machineProgram.machineIdle };
  if (program.displayStatus === "PROGRAMMED") return { tone: "ok", words: copy.machineProgram.machineReady };
  return { tone: statusTone(program.displayStatus), words: statusLabel(program.displayStatus) };
};

export const MachinesStrip: React.FC<MachinesStripProps> = ({ board, selectedId, onSelect, onMachineAdded }) => (
  <nav className="mpx-machines-bar" aria-label={copy.machineProgram.machines}>
    <h2 className="mpx-machines-bar-title">{copy.machineProgram.machines}</h2>

    {board.loading && board.value.length === 0 ? (
      <StateView kind="loading" compact />
    ) : board.error ? (
      <StateView kind="error" compact message={board.error} onRetry={() => void board.reload()} />
    ) : board.value.length === 0 ? (
      <StateView
        kind="empty"
        compact
        title={copy.machineProgram.noMachinesTitle}
        hint={onMachineAdded ? copy.machineProgram.noMachinesHintCanAdd : copy.machineProgram.noMachinesHint}
      />
    ) : (
      <ul className="mpx-machines">
        {board.value.map((row) => {
          const selected = row.machine.id === selectedId;
          const state = machineState(row);
          return (
            <li key={row.machine.id}>
              <button
                type="button"
                className={`mpx-machine${selected ? " is-selected" : ""}`}
                aria-pressed={selected}
                onClick={() => onSelect(row)}
              >
                <span className="mpx-machine-mark" aria-hidden="true">
                  <MachineIcon />
                </span>
                <span className="mpx-machine-text">
                  <span className="mpx-machine-name">{row.machine.name}</span>
                  <span className={`mpx-machine-state mpx-machine-state--${state.tone}`}>
                    <span className="mpx-dot" aria-hidden="true" />
                    {state.words}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    )}

    {onMachineAdded ? <AddMachineField onAdded={onMachineAdded} /> : null}
  </nav>
);
