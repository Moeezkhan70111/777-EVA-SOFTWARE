import React, { useState } from "react";
import { MACHINE_INJECTORS, type MachineShift } from "@erp/domain";
import type { MachineProgramRecord, MachineRecord } from "../../types/desktopApi";
import { TabStrip } from "../../components/shared/TabStrip";
import { copy } from "../../config/copy";
import { InjectorPanel } from "./InjectorPanel";
import { injectorRuns } from "./machineProgram";
import type { ProgramWrites } from "./useProgramWrites";

// The middle column: the machine's injectors, one card under the other, with the tabs across the
// top to jump between them.
//
//   [ Injector 1 ][ Injector 2 ]
//   ┌ Injector 1 ─────────────────────── Configured ┐
//   │  ● Black Sole          ● Brown Sole           │
//   └───────────────────────────────────────────────┘
//   ┌ Injector 2 ─────────────────── Not configured ┐
//   │  No program added yet                         │
//   └───────────────────────────────────────────────┘
//
// Both injectors stay on screen, because what a machine is making is the two of them together.
// The tabs scroll to one and mark it, which is what they are for on a long program — they never
// hide the other injector's work.

interface InjectorWorkspaceProps {
  machine: MachineRecord;
  programDate: string;
  shift: MachineShift;
  program: MachineProgramRecord | null;
  writes: ProgramWrites;
}

/** The id the tab scrolls to. */
const panelId = (injectorNo: number): string => `mpx-injector-${injectorNo}`;

export const InjectorWorkspace: React.FC<InjectorWorkspaceProps> = ({ machine, programDate, shift, program, writes }) => {
  const [active, setActive] = useState<number>(MACHINE_INJECTORS[0]);

  const tabs = MACHINE_INJECTORS.map((no) => ({
    id: String(no),
    label: copy.machineProgram.injector(no),
    badge: injectorRuns(program, no).length > 0 ? copy.machineProgram.configured : undefined,
  }));

  const jump = (id: string) => {
    const injectorNo = Number(id);
    setActive(injectorNo);
    document.getElementById(panelId(injectorNo))?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  };

  return (
    <div className="mpx-work">
      <div className="mpx-work-tabs">
        <TabStrip items={tabs} active={String(active)} onSelect={jump} label={copy.machineProgram.chooseInjector} />
      </div>

      {MACHINE_INJECTORS.map((injectorNo) => (
        <InjectorPanel
          key={injectorNo}
          id={panelId(injectorNo)}
          machine={machine}
          programDate={programDate}
          shift={shift}
          injectorNo={injectorNo}
          runs={injectorRuns(program, injectorNo)}
          isActive={injectorNo === active}
          writes={writes}
        />
      ))}
    </div>
  );
};
