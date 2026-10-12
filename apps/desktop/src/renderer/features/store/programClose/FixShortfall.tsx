import React from "react";
import { copy } from "../../../config/copy";
import type { MachineProgramReconciliation, ReconciliationFixRun } from "../../../types/desktopApi";

// EVR FIX cartons still out (two soles, no upper) — and the program cannot close until they are back.
//
//   ⚠ Still to come back before the program can close:
//     DC3 7/10 (SILVER GREY / BLACK) — 19 of 20 cartons not back
//
// Shown when there is no label left to turn into a B carton (Reconciliation shows the rest): a
// carton still to be printed, or one produced but not yet stored in.

/** The fix runs with cartons still out, and how many each is short. */
export const fixRunsShort = (view: MachineProgramReconciliation): Array<ReconciliationFixRun & { short: number }> =>
  view.fixRuns
    .map((run) => ({ ...run, short: Math.max(0, (run.cartonsDue ?? 0) - run.cartonsBack) }))
    .filter((run) => run.short > 0);

export const FixShortfall: React.FC<{ view: MachineProgramReconciliation }> = ({ view }) => {
  const runs = fixRunsShort(view);
  if (runs.length === 0) return null;
  return (
    <div className="mpr-fix-short" role="note">
      <p className="mpr-fix-short-head">⚠ {copy.programClose.fixShortOpen}</p>
      <ul>
        {runs.map((run) => (
          <li key={run.runId}>
            <b>{copy.programClose.fixRunName(run.article, run.size, run.outerSoleColour, run.innerSoleColour)}</b>
            {" — "}
            {copy.programClose.fixRunShort(run.short, run.cartonsDue ?? 0)}
          </li>
        ))}
      </ul>
    </div>
  );
};
