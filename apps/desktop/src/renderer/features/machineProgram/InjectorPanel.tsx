import React, { useState } from "react";
import type { MachineShift } from "@erp/domain";
import type { MachineProgramRunRecord, MachineRecord } from "../../types/desktopApi";
import { copy } from "../../config/copy";
import { AddSoleColourDialog } from "./SoleEditors";
import { SoleGroup } from "./SoleGroup";
import { InjectorIcon, PlusIcon } from "./MachineProgramIcons";
import { colourRuns, runColours } from "./machineProgram";
import type { ProgramWrites } from "./useProgramWrites";

// One injector, and every sole colour running in it:
//
//   ◉ Injector 1                                              Configured
//   ┌ ● Black Sole        🗑 ┐  ┌ ● Brown Sole        🗑 ┐
//   │ + Add Article          │  │ + Add Article          │
//   │ SK6  7/10  ● Black  …  │  │ SK12 1/6   ● Blue  …   │
//   │ Total (Black Sole) 40  │  │ Total (Brown Sole) 30  │
//   └────────────────────────┘  └────────────────────────┘
//                      + Add Sole Color
//
// A sole colour is not a thing of its own on this screen: it is however many sole runs of that
// colour the injector has. Adding one asks the colour, the article, the size, the upper and how
// many, all in one dialog, because none of those is a program on its own — the first upper is
// what saves it (R12: nothing half-made is left behind).

interface InjectorPanelProps {
  id: string;
  machine: MachineRecord;
  programDate: string;
  shift: MachineShift;
  injectorNo: number;
  /** The sole runs already saved on this injector. */
  runs: MachineProgramRunRecord[];
  /** The injector the tabs are pointing at. */
  isActive: boolean;
  writes: ProgramWrites;
}

export const InjectorPanel: React.FC<InjectorPanelProps> = ({
  id,
  machine,
  programDate,
  shift,
  injectorNo,
  runs,
  isActive,
  writes,
}) => {
  const [adding, setAdding] = useState(false);
  const colours = runColours(runs);
  const configured = colours.length > 0;

  return (
    <section
      id={id}
      className={`mpx-injector${isActive ? " is-active" : ""}`}
      aria-label={copy.machineProgram.injector(injectorNo)}
    >
      <header className="mpx-injector-head">
        <span className="mpx-injector-mark" aria-hidden="true">
          <InjectorIcon />
        </span>
        <h3 className="mpx-injector-title">{copy.machineProgram.injector(injectorNo)}</h3>
        <span className={`mp-badge mp-badge--${configured ? "ok" : "muted"}`}>
          {configured ? copy.machineProgram.configured : copy.machineProgram.notConfigured}
        </span>
        {/* An injector that already has soles keeps its add beside the title: the big blue one
            belongs to the empty state, where it is the only thing to do. */}
        {configured ? <AddSoleButton compact onClick={() => setAdding(true)} /> : null}
      </header>

      {!configured ? (
        <div className="mpx-injector-empty">
          <span className="mpx-injector-empty-mark" aria-hidden="true">
            <PlusIcon />
          </span>
          <p className="mpx-injector-empty-title">{copy.machineProgram.injectorEmptyTitle}</p>
          <p className="mpx-injector-empty-hint">{copy.machineProgram.injectorEmptyHint(injectorNo)}</p>
          <AddSoleButton onClick={() => setAdding(true)} />
        </div>
      ) : (
        <div className="mpx-soles">
            {colours.map((colour) => (
              <SoleGroup
                key={colour}
                colour={colour}
                runs={colourRuns(runs, colour)}
                machineId={machine.id}
                programDate={programDate}
                shift={shift}
                injectorNo={injectorNo}
                writes={writes}
              />
            ))}
        </div>
      )}

      {adding ? (
        <AddSoleColourDialog
          machineId={machine.id}
          programDate={programDate}
          shift={shift}
          injectorNo={injectorNo}
          runs={runs}
          writes={writes}
          onClose={() => setAdding(false)}
        />
      ) : null}
    </section>
  );
};

const AddSoleButton: React.FC<{ onClick: () => void; compact?: boolean }> = ({ onClick, compact }) => (
  <button type="button" className={`mpx-add-sole${compact ? " mpx-add-sole--compact" : ""}`} onClick={onClick}>
    <PlusIcon className="mpx-btn-icon" />
    {copy.machineProgram.addSoleColour}
  </button>
);
