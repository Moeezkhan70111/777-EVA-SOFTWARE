import React, { useState } from "react";
import { copy } from "../../../config/copy";
import { ConfirmDialog } from "../../../components/shared/ConfirmDialog";
import { StateView } from "../../../components/shared/StateView";
import { formatDateTime } from "../../../utils/dates";
import type { MachineProgramReconciliation } from "../../../types/desktopApi";
import { ReconciliationDialog } from "./ReconciliationDialog";
import { FixShortfall } from "./FixShortfall";
import { FixReconciliation, fixRunsToReconcile } from "./FixReconciliation";
import { useBConversion } from "./useBConversion";
import type { ProgramCloseState } from "./useProgramClose";

// COMPLETE PROGRAM — the last thing done to a machine program, from Store In.
//
//   ┌ Complete Program ─────────────────────────────── 7 of 8 cartons back ┐
//   │ 1 carton short — 6 uppers to account for          [ Complete Program ] │
//
// All back → a confirmation, and the program closes COMPLETE. Short → the reconciliation, and it
// closes RECONCILED. Once closed, this section says how — on Store Out too, which is where an
// administrator's claim notice opens the program — with every claim and its reason.

interface ProgramCloseSectionProps {
  close: ProgramCloseState;
  /** Store In closes programs; Store Out only shows how one was closed. */
  allowComplete: boolean;
  /** Store In: what the EVR FIX Reconciliation needs to turn missing cartons into B cartons. */
  bCartons?: BCartonsTarget;
}

interface BCartonsTarget {
  token: string;
  programId: string;
  programCode: string;
  onConverted: () => Promise<void>;
}

/** The EVR FIX Reconciliation, with the action that makes B cartons. */
const BCartonReconciliation: React.FC<{ view: MachineProgramReconciliation; target: BCartonsTarget }> = ({ view, target }) => {
  const convert = useBConversion(target);
  return <FixReconciliation view={view} convert={convert} />;
};

const shortCartons = (view: MachineProgramReconciliation): number => Math.max(0, view.cartonsDue - view.cartonsBack);
const shortUppers = (view: MachineProgramReconciliation): number => view.lines.reduce((total, line) => total + line.shortfallUppers, 0);

/** How a closed program was closed, and — when reconciled — what became of every missing upper. */
const ClosedSummary: React.FC<{ view: MachineProgramReconciliation }> = ({ view }) => {
  const closure = view.closure!;
  const at = formatDateTime(closure.closedAt);
  const reconciled = view.lines.filter((line) => line.saved);
  return (
    <div className="mpr-closed">
      <p className="mpr-closed-head">
        {closure.outcome === "COMPLETE" ? copy.programClose.closedComplete(closure.closedBy, at) : copy.programClose.closedReconciled(closure.closedBy, at)}
      </p>
      <p className="mpi-section-line">{copy.programClose.closedFigures(closure.cartonsBack, closure.cartonsDue)}</p>
      {reconciled.length > 0 ? (
        <ul className="mpr-summary" aria-label={copy.programClose.summaryTitle}>
          {reconciled.map((line) => {
            const saved = line.saved!;
            return (
              <li key={line.lineId}>
                <b>{`${line.article} ${line.size} ${line.upperColour}`}</b> — {copy.programClose.lineShort(line.shortfallUppers)}
                <ul>
                  {saved.cutSize > 0 ? <li>{copy.programClose.summaryCut(saved.cutSize)}</li> : null}
                  {saved.wastage > 0 ? <li>{copy.programClose.summaryWastage(saved.wastage, saved.wastagePartyName ?? "", saved.wastageReason)}</li> : null}
                  {saved.lost > 0 ? <li>{copy.programClose.summaryLost(saved.lost, saved.lostPartyName ?? "", saved.lostReason)}</li> : null}
                </ul>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
};

/** The standing line under the figures: uppers to account for, fix cartons not back, or all back. */
const standingLines = (view: MachineProgramReconciliation): string[] => {
  const lines: string[] = [];
  if (shortUppers(view) > 0) lines.push(copy.programClose.cartonsShort(shortCartons(view) - view.fixCartonsShort, shortUppers(view)));
  if (view.fixCartonsShort > 0) lines.push(copy.programClose.fixCartonsShort(view.fixCartonsShort));
  return lines.length > 0 ? lines : [copy.programClose.allBack];
};

export const ProgramCloseSection: React.FC<ProgramCloseSectionProps> = ({ close, allowComplete, bCartons }) => {
  const [dialog, setDialog] = useState<null | "confirm" | "reconcile">(null);
  const [opening, setOpening] = useState(false);
  const view = close.reconciliation;

  // Store Out shows the section only once the program is closed.
  if (!allowComplete && !view?.closure) return null;

  /** Reads the figures afresh, then asks for what they call for: a confirmation, or the reconciliation. */
  const start = async () => {
    setOpening(true);
    const fresh = await close.load();
    setOpening(false);
    if (!fresh || fresh.closure || fresh.blockedReason) return;
    setDialog(shortUppers(fresh) === 0 ? "confirm" : "reconcile");
  };

  return (
    <section className="mpi-section" aria-label={copy.programClose.title}>
      <header className="mpi-section-head">
        <div>
          <h2 className="mpi-section-title">{copy.programClose.title}</h2>
          <p className="mpi-section-line">{copy.programClose.line}</p>
        </div>
        {view && !view.closure && allowComplete ? (
          <button type="button" className="mpi-action" onClick={() => void start()} disabled={opening || Boolean(view.blockedReason)}>
            {opening ? copy.programClose.loading : copy.programClose.complete}
          </button>
        ) : null}
      </header>

      {close.loading && !view ? <StateView kind="loading" compact message={copy.programClose.loading} /> : null}
      {close.error && !view ? <StateView kind="error" compact message={close.error} onRetry={() => void close.load()} /> : null}

      {view?.closure ? <ClosedSummary view={view} /> : null}
      {view && !view.closure ? (
        <div className="mpr-standing">
          <p className="mpr-standing-figures">{copy.programClose.cartonsBack(view.cartonsBack, view.cartonsDue)}</p>
          {standingLines(view).map((line) => (
            <p className="mpi-section-line" key={line}>
              {line}
            </p>
          ))}
          {/* With labels to turn into B cartons, the Reconciliation table says where the missing
              cartons are; without one (Store Out), the plain shortfall list says it. */}
          {bCartons && fixRunsToReconcile(view).length > 0 ? (
            <BCartonReconciliation view={view} target={bCartons} />
          ) : (
            <FixShortfall view={view} />
          )}
          {view.blockedReason ? (
            <p className="mp-problem" role="alert">
              ⚠ {view.blockedReason}
            </p>
          ) : null}
        </div>
      ) : null}

      {dialog === "confirm" && view ? (
        // Every carton is back: an EVR FIX carton still out keeps Complete disabled (blockedReason).
        <ConfirmDialog
          title={copy.programClose.confirmTitle(view.code)}
          facts={[{ label: copy.programClose.confirmFactCartons, value: copy.programClose.cartonsBack(view.cartonsBack, view.cartonsDue) }]}
          explain={copy.programClose.confirmExplain}
          confirmLabel={copy.programClose.confirmAction}
          tone="primary"
          busyLabel={copy.programClose.completing}
          onConfirm={() => close.complete([])}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === "reconcile" && view ? (
        <ReconciliationDialog reconciliation={view} onSubmit={close.complete} onClose={() => setDialog(null)} />
      ) : null}
    </section>
  );
};
