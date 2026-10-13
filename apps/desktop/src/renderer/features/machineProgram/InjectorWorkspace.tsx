import React, { useState } from "react";
import { MACHINE_INJECTORS, type MachineShift } from "@erp/domain";
import type { MachineProgramRecord, MachineRecord } from "../../types/desktopApi";
import { TabStrip } from "../../components/shared/TabStrip";
import { copy } from "../../config/copy";
import { FixArticlesPanel } from "./FixArticlesPanel";
import { InjectorPanel } from "./InjectorPanel";
import { injectorRuns, programFixRuns } from "./machineProgram";
import type { ProgramWrites } from "./useProgramWrites";

// The middle column: the machine's injectors, one card under the other, then its FIX articles,
// with the tabs across the top to jump between them.
//
//   [ Injector 1 ][ Injector 2 ][ Fix Articles ]
//   ┌ Injector 1 ─────────────────────── Configured ┐
//   │  ● Black Sole          ● Brown Sole           │
//   └───────────────────────────────────────────────┘
//   ┌ Injector 2 ─────────────────── Not configured ┐
//   │  No program added yet                         │
//   └───────────────────────────────────────────────┘
//   ┌ Fix Articles ── EVR FIX, no injector ─────────┐
//   │  EVR9 7/10  ● White / ● Black   32 DOZEN      │
//   └───────────────────────────────────────────────┘
//
// Everything stays on screen, because what a machine is making is all of it together. The tabs
// scroll to one and mark it, which is what they are for on a long program — they never hide the
// rest. EVR FIX is not moulded on the injectors (migration 073), so it is its own section rather
// than a sole under one of them.

interface InjectorWorkspaceProps {
  machine: MachineRecord;
  programDate: string;
  shift: MachineShift;
  program: MachineProgramRecord | null;
  writes: ProgramWrites;
}

/** The tab id of the Fix Articles section — the injectors use their number. */
const FIX_TAB = "fix";

/** The id the tab scrolls to. */
const panelId = (tab: string): string => `mpx-injector-${tab}`;

export const InjectorWorkspace: React.FC<InjectorWorkspaceProps> = ({ machine, programDate, shift, program, writes }) => {
  const [active, setActive] = useState<string>(String(MACHINE_INJECTORS[0]));
  const fixRuns = programFixRuns(program);

  const tabs = [
    ...MACHINE_INJECTORS.map((no) => ({
      id: String(no),
      label: copy.machineProgram.injector(no),
      badge: injectorRuns(program, no).length > 0 ? copy.machineProgram.configured : undefined,
    })),
    { id: FIX_TAB, label: copy.machineProgram.fixSection, badge: fixRuns.length > 0 ? String(fixRuns.length) : undefined },
  ];

  const jump = (id: string) => {
    setActive(id);
    document.getElementById(panelId(id))?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  };

  return (
    <div className="mpx-work">
      <div className="mpx-work-tabs">
        <TabStrip items={tabs} active={active} onSelect={jump} label={copy.machineProgram.chooseInjector} />
      </div>

      {MACHINE_INJECTORS.map((injectorNo) => (
        <InjectorPanel
          key={injectorNo}
          id={panelId(String(injectorNo))}
          machine={machine}
          programDate={programDate}
          shift={shift}
          injectorNo={injectorNo}
          runs={injectorRuns(program, injectorNo)}
          articleRates={program?.articleRates ?? []}
          isActive={String(injectorNo) === active}
          writes={writes}
        />
      ))}

      <FixArticlesPanel
        id={panelId(FIX_TAB)}
        machine={machine}
        programDate={programDate}
        shift={shift}
        runs={fixRuns}
        articleRates={program?.articleRates ?? []}
        isActive={active === FIX_TAB}
        writes={writes}
      />
    </div>
  );
};
