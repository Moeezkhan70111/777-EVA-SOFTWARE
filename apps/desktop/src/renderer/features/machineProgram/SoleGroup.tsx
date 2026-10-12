import React, { useState } from "react";
import { isFixRun, type MachineShift } from "@erp/domain";
import type { MachineProgramArticleRate, MachineProgramRunRecord, MachineProgramUpperLineRecord } from "../../types/desktopApi";
import { ColorSwatch } from "../../components/shared/ColorSwatch";
import { copy } from "../../config/copy";
import { RunChangeDialog } from "./RunChange";
import { AddArticleDialog, RemoveFixRunDialog, RemoveLineDialog, RemoveSoleColourDialog } from "./SoleEditors";
import { SoleRunRows } from "./SoleRunRows";
import { SoleTime } from "./SoleTime";
import { PlusIcon, TrashIcon } from "./MachineProgramIcons";
import { formatAmount, injectorTotal } from "./machineProgram";
import type { ProgramWrites } from "./useProgramWrites";

// One sole colour on one injector, and everything being made in it:
//
//   ● Black Sole                                       ◷ 06:00 AM – 10:00 AM  🗑
//   + Add Article
//   ┌ Article │ Size │ Upper Color │ Available Stock (Upper) │ Qty to Run │   ┐
//   │ SK6     │ 7/10 │ ● Black     │ 30 DOZEN                │ [ 10 ]     │ 🗑 │
//   │ SK6     │ 7/10 │ ● Blue      │ 25 DOZEN                │ [ 10 ]     │ 🗑 │
//   └ Total (Black Sole)                                        40 DOZEN     ┘
//
// A row is one upper reserved for one sole run. Removing the last upper of a run takes the run
// with it, which is the backend's rule, not this screen's — so an empty sole can never be left
// behind. Nothing destructive happens without being asked first.
//
// The quantity in the row is the one figure that is typed rather than chosen, and it is saved on
// its own (SoleRunRows → QuantityCell), checked against the store at that moment.

type Editing =
  | { kind: "none" }
  | { kind: "addArticle" }
  | { kind: "changeRun"; run: MachineProgramRunRecord }
  | { kind: "removeLine"; line: MachineProgramUpperLineRecord }
  | { kind: "removeRun"; run: MachineProgramRunRecord }
  | { kind: "removeColour" };

interface SoleGroupProps {
  colour: string;
  /** Every run of this colour on this injector. */
  runs: MachineProgramRunRecord[];
  machineId: string;
  programDate: string;
  shift: MachineShift;
  injectorNo: number;
  /** What the program already pays per article, for the pricing boxes in + Add Article. */
  articleRates: MachineProgramArticleRate[];
  writes: ProgramWrites;
}

export const SoleGroup: React.FC<SoleGroupProps> = ({
  colour,
  runs,
  machineId,
  programDate,
  shift,
  injectorNo,
  articleRates,
  writes,
}) => {
  const [editing, setEditing] = useState<Editing>({ kind: "none" });
  const done = () => setEditing({ kind: "none" });
  const total = injectorTotal(runs);
  const soleName = copy.machineProgram.soleLine(colour);
  // A FIX article is moulded from two soles and has no upper, so a card where every article is
  // one has nothing to say about upper colours or upper stock: those two columns are not there.
  // A card that mixes the two keeps them, because the uppers on it still need them.
  const fixOnly = runs.length > 0 && runs.every(isFixRun);

  return (
    <article className="mpx-sole" aria-label={soleName}>
      <header className="mpx-sole-head">
        <ColorSwatch color={colour} className="mpx-sole-swatch" />
        <h4 className="mpx-sole-name">{soleName}</h4>
        <SoleTime colour={colour} runs={runs} shift={shift} injectorNo={injectorNo} writes={writes} />
        <button
          type="button"
          className="mpx-icon-btn mpx-icon-btn--danger"
          aria-label={`${copy.machineProgram.removeSole} ${soleName}`}
          onClick={() => setEditing({ kind: "removeColour" })}
        >
          <TrashIcon />
        </button>
      </header>

      <button type="button" className="mpx-add-article" onClick={() => setEditing({ kind: "addArticle" })}>
        <PlusIcon className="mpx-btn-icon" />
        {copy.machineProgram.addArticle}
      </button>

      <div className="mpx-table-wrap">
        <table className="mpx-table">
          <thead>
            <tr>
              <th scope="col">{copy.machineProgram.colArticle}</th>
              <th scope="col">{copy.machineProgram.colSize}</th>
              {fixOnly ? <th scope="col">{copy.machineProgram.colOuterSole}</th> : null}
              <th scope="col">{fixOnly ? copy.machineProgram.colInnerSole : copy.machineProgram.colUpper}</th>
              {fixOnly ? null : (
                <th scope="col" className="mpx-num">
                  {copy.machineProgram.colAvailable}
                </th>
              )}
              <th scope="col">{copy.machineProgram.colQuantity(total.unitCode)}</th>
              <th scope="col">
                <span className="sr-only">{copy.machineProgram.colActions}</span>
              </th>
            </tr>
          </thead>
          {runs.map((run) => (
            <SoleRunRows
              key={run.id}
              run={run}
              machineId={machineId}
              programDate={programDate}
              shift={shift}
              fixOnly={fixOnly}
              writes={writes}
              onChangeRun={() => setEditing({ kind: "changeRun", run })}
              onRemoveLine={(line) => setEditing({ kind: "removeLine", line })}
              onRemoveRun={() => setEditing({ kind: "removeRun", run })}
            />
          ))}
        </table>
      </div>

      <p className="mpx-sole-total">
        <span>{copy.machineProgram.totalOf(soleName)}</span>
        <b>{formatAmount(total.quantity, total.unitCode)}</b>
      </p>

      {editing.kind === "addArticle" ? (
        <AddArticleDialog
          colour={colour}
          machineId={machineId}
          programDate={programDate}
          shift={shift}
          injectorNo={injectorNo}
          runs={runs}
          articleRates={articleRates}
          writes={writes}
          onClose={done}
        />
      ) : null}

      {editing.kind === "changeRun" ? <RunChangeDialog run={editing.run} writes={writes} onClose={done} /> : null}

      {editing.kind === "removeLine" ? <RemoveLineDialog line={editing.line} writes={writes} onClose={done} /> : null}

      {editing.kind === "removeRun" ? <RemoveFixRunDialog run={editing.run} writes={writes} onClose={done} /> : null}

      {editing.kind === "removeColour" ? (
        <RemoveSoleColourDialog colour={colour} runs={runs} writes={writes} onClose={done} />
      ) : null}
    </article>
  );
};
