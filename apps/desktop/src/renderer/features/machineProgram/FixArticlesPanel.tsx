import React, { useState } from "react";
import type { MachineShift } from "@erp/domain";
import type { MachineProgramArticleRate, MachineProgramRunRecord, MachineRecord } from "../../types/desktopApi";
import { copy } from "../../config/copy";
import { AddArticleDialog } from "./AddArticleDialog";
import { RunChangeDialog } from "./RunChange";
import { RemoveFixRunDialog } from "./SoleEditors";
import { SoleRunRows } from "./SoleRunRows";
import { PlusIcon, ProductionIcon } from "./MachineProgramIcons";
import { formatAmount, injectorTotal } from "./machineProgram";
import type { ProgramWrites } from "./useProgramWrites";

// FIX ARTICLES — the program's EVR FIX work, beside the two injectors rather than inside one:
//
//   ◉ Fix Articles   EVR FIX — two soles, no upper, no injector        2 articles   [+ Add Fix Article]
//   ┌ Article │ Size │ Outer Sole │ Inner Sole │ Qty to Run │   ┐
//   │ EVR9    │ 7/10 │ ● White    │ ● Black    │ [ 32 ]     │ 🗑 │
//   └ Total (Fix Articles)                        32 DOZEN      ┘
//
// EVR FIX is not moulded on the injectors (owner, 2026-10-12), so a fix run has no injector at all
// (migration 073) and is added here, never from Injector 1 or 2. Every row is the same fix row the
// injector cards used to show, so changing the quantity, the soles or the article works the same.

interface FixArticlesPanelProps {
  id: string;
  machine: MachineRecord;
  programDate: string;
  shift: MachineShift;
  /** The program's fix runs. */
  runs: MachineProgramRunRecord[];
  articleRates: MachineProgramArticleRate[];
  /** The section the tabs are pointing at. */
  isActive: boolean;
  writes: ProgramWrites;
}

type Editing =
  | { kind: "none" }
  | { kind: "add" }
  | { kind: "change"; run: MachineProgramRunRecord }
  | { kind: "remove"; run: MachineProgramRunRecord };

export const FixArticlesPanel: React.FC<FixArticlesPanelProps> = ({ id, machine, programDate, shift, runs, articleRates, isActive, writes }) => {
  const [editing, setEditing] = useState<Editing>({ kind: "none" });
  const done = () => setEditing({ kind: "none" });
  const total = injectorTotal(runs);
  const text = copy.machineProgram;

  return (
    <section id={id} className={`mpx-injector mpx-fix-section${isActive ? " is-active" : ""}`} aria-label={text.fixSection}>
      <header className="mpx-injector-head">
        <span className="mpx-injector-mark" aria-hidden="true">
          <ProductionIcon />
        </span>
        <h3 className="mpx-injector-title">{text.fixSection}</h3>
        <span className="mpx-fix-note">{text.fixSectionNote}</span>
        {runs.length > 0 ? (
          <>
            <span className="mp-badge mp-badge--ok">{text.fixArticleCount(runs.length)}</span>
            <AddFixButton compact onClick={() => setEditing({ kind: "add" })} />
          </>
        ) : null}
      </header>

      {runs.length === 0 ? (
        <div className="mpx-injector-empty">
          <span className="mpx-injector-empty-mark" aria-hidden="true">
            <PlusIcon />
          </span>
          <p className="mpx-injector-empty-title">{text.fixSectionEmptyTitle}</p>
          <p className="mpx-injector-empty-hint">{text.fixSectionEmptyHint}</p>
          <AddFixButton onClick={() => setEditing({ kind: "add" })} />
        </div>
      ) : (
        <article className="mpx-sole">
          <div className="mpx-table-wrap">
            <table className="mpx-table">
              <thead>
                <tr>
                  <th scope="col">{text.colArticle}</th>
                  <th scope="col">{text.colSize}</th>
                  <th scope="col">{text.colOuterSole}</th>
                  <th scope="col">{text.colInnerSole}</th>
                  <th scope="col">{text.colQuantity(total.unitCode)}</th>
                  <th scope="col">
                    <span className="sr-only">{text.colActions}</span>
                  </th>
                </tr>
              </thead>
              {runs.map((run) => (
                <SoleRunRows
                  key={run.id}
                  run={run}
                  machineId={machine.id}
                  programDate={programDate}
                  shift={shift}
                  fixOnly
                  writes={writes}
                  onChangeRun={() => setEditing({ kind: "change", run })}
                  onRemoveLine={() => undefined}
                  onRemoveRun={() => setEditing({ kind: "remove", run })}
                />
              ))}
            </table>
          </div>
          <p className="mpx-sole-total">
            <span>{text.totalOf(text.fixSection)}</span>
            <b>{formatAmount(total.quantity, total.unitCode)}</b>
          </p>
        </article>
      )}

      {editing.kind === "add" ? (
        <AddArticleDialog
          machineId={machine.id}
          programDate={programDate}
          shift={shift}
          injectorNo={null}
          runs={runs}
          articleRates={articleRates}
          writes={writes}
          onClose={done}
          title={text.addFixArticle}
          where={text.fixSection}
        />
      ) : null}
      {editing.kind === "change" ? <RunChangeDialog run={editing.run} writes={writes} onClose={done} /> : null}
      {editing.kind === "remove" ? <RemoveFixRunDialog run={editing.run} writes={writes} onClose={done} /> : null}
    </section>
  );
};

const AddFixButton: React.FC<{ onClick: () => void; compact?: boolean }> = ({ onClick, compact }) => (
  <button type="button" className={`mpx-add-sole${compact ? " mpx-add-sole--compact" : ""}`} onClick={onClick}>
    <PlusIcon className="mpx-btn-icon" />
    {copy.machineProgram.addFixArticle}
  </button>
);
