import React, { useState } from "react";
import { bConversionProblem } from "@erp/domain";
import { copy } from "../../../config/copy";
import { ConfirmDialog } from "../../../components/shared/ConfirmDialog";
import type { MachineProgramReconciliation, ReconciliationFixRun } from "../../../types/desktopApi";
import type { ConvertToB } from "./useBConversion";

// RECONCILIATION — EVR FIX: where are the cartons that did not come back?
//
//   Article                 Due   Back   Not back   B cartons
//   DC3 7/10 (BLACK / RED)   20    10       10      [ 10 ]  [ Generate B labels ]
//                           B · 10 labels printed · 3 of 10 back
//
// They came off the machine as B — mixed colours — so their colour labels no longer tell the
// truth. Generating voids the labels that are not back and prints as many new ones: B in the
// corner, COLOUR MIX. Those B cartons are scanned in like any other, and the program completes.

const text = copy.programClose;

/** The fix runs this table has something to say about: labels not back, or B labels made. */
export const fixRunsToReconcile = (view: MachineProgramReconciliation): ReconciliationFixRun[] =>
  view.fixRuns.filter((run) => run.convertible > 0 || run.bCartons > 0);

const FixRow: React.FC<{ run: ReconciliationFixRun; onGenerate: (run: ReconciliationFixRun, count: number) => void }> = ({ run, onGenerate }) => {
  const [typed, setTyped] = useState(String(run.convertible));
  const count = Number(typed);
  const problem = run.convertible > 0 ? bConversionProblem(count, run.convertible) : null;
  const name = text.fixRunName(run.article, run.size, run.outerSoleColour, run.innerSoleColour);
  return (
    <tr>
      <th scope="row">
        {name}
        {run.bCartons > 0 ? <small className="mpr-b-status">{text.bStatus(run.bCartons, run.bBack)}</small> : null}
      </th>
      <td className="mpr-num">{run.cartonsDue ?? "—"}</td>
      <td className="mpr-num">{run.cartonsBack}</td>
      <td className="mpr-num"><b>{run.convertible}</b></td>
      <td>
        {run.convertible > 0 ? (
          <>
            <input
              type="text"
              inputMode="numeric"
              className="form-input mpr-b-input"
              aria-label={text.bInputLabel(name)}
              value={typed}
              onChange={(event) => /^\d*$/.test(event.target.value) && setTyped(event.target.value)}
            />
            {problem && typed !== "" ? <span className="mpr-b-problem" role="alert">⚠ {problem}</span> : null}
          </>
        ) : (
          "—"
        )}
      </td>
      <td>
        {run.convertible > 0 ? (
          <button type="button" className="btn btn-primary mpr-b-generate" disabled={Boolean(problem) || typed === ""} onClick={() => onGenerate(run, count)}>
            {text.bGenerate}
          </button>
        ) : null}
      </td>
    </tr>
  );
};

export const FixReconciliation: React.FC<{ view: MachineProgramReconciliation; convert: ConvertToB }> = ({ view, convert }) => {
  const [asking, setAsking] = useState<{ run: ReconciliationFixRun; count: number } | null>(null);
  const runs = fixRunsToReconcile(view);
  if (runs.length === 0) return null;

  return (
    <section className="mpr-fix-recon" aria-label={text.bTitle}>
      <h3 className="mpr-fix-recon-title">{text.bTitle}</h3>
      <p className="mpr-fix-recon-line">{text.bLine}</p>
      <div className="mpr-fix-recon-wrap">
        <table className="mpr-fix-recon-table">
          <thead>
            <tr>
              <th scope="col">{text.bColArticle}</th>
              <th scope="col" className="mpr-num">{text.bColDue}</th>
              <th scope="col" className="mpr-num">{text.bColBack}</th>
              <th scope="col" className="mpr-num">{text.bColNotBack}</th>
              <th scope="col">{text.bColB}</th>
              <th scope="col"><span className="sr-only">{text.bGenerate}</span></th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <FixRow key={`${run.runId}:${run.convertible}`} run={run} onGenerate={(chosen, count) => setAsking({ run: chosen, count })} />
            ))}
          </tbody>
        </table>
      </div>

      {asking ? (
        <ConfirmDialog
          title={text.bConfirmTitle(asking.count)}
          facts={[
            { label: text.bColArticle, value: text.fixRunName(asking.run.article, asking.run.size, asking.run.outerSoleColour, asking.run.innerSoleColour) },
            { label: text.bConfirmVoided, value: text.bConfirmVoidedValue(asking.count) },
            { label: text.bConfirmNew, value: text.bConfirmNewValue(asking.count, asking.run.article, asking.run.size) },
          ]}
          explain={text.bConfirmExplain(asking.count)}
          confirmLabel={text.bGenerate}
          tone="primary"
          busyLabel={text.bGenerating}
          onConfirm={() => convert(asking.run, asking.count)}
          onClose={() => setAsking(null)}
        />
      ) : null}
    </section>
  );
};
