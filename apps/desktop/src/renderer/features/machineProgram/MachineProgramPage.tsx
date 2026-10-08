import React, { useState } from "react";
import { DEFAULT_MACHINE_SHIFT, type MachineShift } from "@erp/domain";
import type { MachineProgramBoardRow, MachineRecord } from "../../types/desktopApi";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import { toIsoDate } from "../../utils/dates";
import { ContractorDialog } from "./ContractorDialog";
import { InjectorWorkspace } from "./InjectorWorkspace";
import { MachinesStrip } from "./MachinesStrip";
import { ProgramSummaryRail } from "./ProgramSummaryRail";
import { WorkspaceHeader } from "./WorkspaceHeader";
import { hasContent, shiftOf } from "./machineProgram";
import { printMachineProgram } from "./machineProgramPrint";
import { useMachineBoard, useMachineProgram } from "./useMachineProgramData";
import { useProgramWrites } from "./useProgramWrites";
//
// MACHINE PROGRAM — one workspace rather than a sequence of screens:
//
//   ⚙ Machine Program               SHIFT TIME   PROGRAM DATE   [ Print Program ]
//   MACHINES  [▤ Machine 1] [▤ Machine 2] [▤ Machine 3]
//   ┌──────────────────────────────────┬──────────────────┐
//   │ INJECTOR 1 | INJECTOR 2          │ PROGRAM SUMMARY  │
//   │  ┌ Injector 1 ────────────────┐  │  Injector 1 …    │
//   │  │ ● Black Sole  ● Brown Sole │  │  Total Production│
//   │  └────────────────────────────┘  │  Quick View      │
//   │  ┌ Injector 2 ────────────────┐  │                  │
//   │  │ No program added yet       │  │                  │
//   └──┴────────────────────────────┴──┴──────────────────┘
//
// The shift and the date are the header, the machines are the strip under it, the left column is
// the machine's two injectors, and the right column is what the machine adds up to and what can
// be done with it. The left of the screen itself belongs to the application's navigation rail.
//
// Nothing here calculates a business figure. Stock, totals and status all arrive already
// computed from the data layer, every change is one saved transaction, and the program and the
// board are re-read after each one rather than patched on screen.

interface MachineProgramPageProps {
  /** The signed-in operator, printed on the program sheet. */
  username?: string;
}

export const MachineProgramPage: React.FC<MachineProgramPageProps> = ({ username }) => {
  const today = toIsoDate();
  const [date, setDate] = useState(today);
  const [machineId, setMachineId] = useState<string | null>(null);
  const [askingContractorFor, setAskingContractorFor] = useState<MachineRecord | null>(null);
  // The shift a program WOULD be made with. Once a program exists its own shift is what is
  // shown, so this only ever decides the next one.
  const [chosenShift, setChosenShift] = useState<MachineShift>(DEFAULT_MACHINE_SHIFT);

  const board = useMachineBoard(date);
  const program = useMachineProgram(machineId, date);
  const writes = useProgramWrites(() => {
    void program.reload();
    void board.reload();
  });

  const machine = board.value.find((row) => row.machine.id === machineId)?.machine ?? null;
  const saved = machineId && hasContent(program.value) ? program.value : null;
  // The shift belongs to the program ROW, which outlives its last upper line: removing every
  // upper leaves the program behind, and to the operator that is "no program" — but its shift is
  // still the one the next line will be made under, so it is read and written from the row.
  const shift = shiftOf(machineId ? program.value : null, chosenShift);

  /** A machine nobody has been assigned to is asked about before it can be programmed. */
  const openMachine = (row: MachineProgramBoardRow) => {
    if (row.machine.contractorPartyId) setMachineId(row.machine.id);
    else setAskingContractorFor(row.machine);
  };

  /** The board is the one source of the machine record, so it is re-read before the machine opens. */
  const contractorSaved = async (assignedTo: string) => {
    setAskingContractorFor(null);
    setMachineId(assignedTo);
    await board.reload();
  };

  /**
   * Changing the shift on a program that exists is a write; on a date with no program yet it is
   * only what the next one will be made with.
   */
  const changeShift = async (next: MachineShift) => {
    setChosenShift(next);
    if (machineId && program.value) await writes.setShift(program.value.id, next);
  };

  return (
    <div className="page mpx-page">
      <WorkspaceHeader
        date={date}
        today={today}
        shift={shift}
        program={saved}
        onShiftChange={(next) => void changeShift(next)}
        onDateChange={setDate}
        onPrint={() => saved && printMachineProgram(saved, username)}
      />

      <MachinesStrip board={board} selectedId={machineId} onSelect={openMachine} />

      <div className="mpx-grid">
        <main className="mpx-main" aria-label={copy.machineProgram.title}>
          {!machine ? (
            <StateView kind="empty" title={copy.machineProgram.chooseMachineTitle} hint={copy.machineProgram.chooseMachineHint} />
          ) : program.loading && program.value === null ? (
            <StateView kind="loading" />
          ) : program.error ? (
            <StateView kind="error" message={program.error} onRetry={() => void program.reload()} />
          ) : (
            <InjectorWorkspace
              key={`${machine.id}:${date}`}
              machine={machine}
              programDate={date}
              shift={shift}
              program={program.value}
              writes={writes}
            />
          )}
        </main>

        <ProgramSummaryRail
          program={saved}
          machine={machine}
          date={date}
          shift={shift}
          writes={writes}
          onChangeContractor={() => machine && setAskingContractorFor(machine)}
        />
      </div>

      {askingContractorFor ? (
        <ContractorDialog
          machine={askingContractorFor}
          onClose={() => setAskingContractorFor(null)}
          onSaved={() => void contractorSaved(askingContractorFor.id)}
        />
      ) : null}
    </div>
  );
};
