import React, { useState } from "react";
import { fromPaisa } from "@erp/domain";
import { copy } from "../../../config/copy";
import { formatMoney } from "../../../app/format";
import { ConfirmDialog } from "../../../components/shared/ConfirmDialog";
import { StateView } from "../../../components/shared/StateView";
import { formatDateTime } from "../../../utils/dates";
import type { MachineProgramReconciliation, ReconciliationLine } from "../../../types/desktopApi";
import { FixShortfall } from "./FixShortfall";
import { FixReconciliation, fixRunsToReconcile } from "./FixReconciliation";
import { UpperReconciliation, upperLinesToReconcile } from "./UpperReconciliation";
import { useBConversion } from "./useBConversion";
import type { ProgramCloseState } from "./useProgramClose";

// COMPLETE PROGRAM — the last thing done to a machine program, from Store In.
//
//   ┌ Complete Program ─────────────────────────────── 6 of 12 cartons back ┐
//   │ 6 cartons short — 36 pairs to account for                             │
//   │ Reconciliation: Return Upper · per upper: B · cut size · claims · balance │
//   │                                                  [ Reconcile & Complete ] │
//
// All back → a confirmation, and the program closes COMPLETE. Short → the Reconciliation
// workspace, and it closes RECONCILED. EVR FIX keeps its own Reconciliation (B cartons) and closes
// only when every carton is back. Once closed, this section says how — on Store Out too, which is
// where an administrator's claim notice opens the program — with every claim and its amount.

interface ProgramCloseSectionProps {
  close: ProgramCloseState;
  /** Store In closes programs; Store Out only shows how one was closed. */
  allowComplete: boolean;
  /** Store In: what the Reconciliation needs to return packets and make B cartons. */
  bCartons?: BCartonsTarget;
}

interface BCartonsTarget {
  token: string;
  programId: string;
  programCode: string;
  onConverted: () => Promise<void>;
}

const text = copy.programClose;

/** The EVR FIX Reconciliation, with the action that makes B cartons. */
const BCartonReconciliation: React.FC<{ view: MachineProgramReconciliation; target: BCartonsTarget }> = ({ view, target }) => {
  const convert = useBConversion(target);
  return <FixReconciliation view={view} convert={convert} />;
};

const shortCartons = (view: MachineProgramReconciliation): number => view.lines.reduce((total, line) => total + line.missingCartons, 0);
const shortUppers = (view: MachineProgramReconciliation): number => view.lines.reduce((total, line) => total + line.shortfallUppers, 0);

/** What became of one upper's missing pairs, line by line. */
const SavedLine: React.FC<{ line: ReconciliationLine }> = ({ line }) => {
  const saved = line.saved!;
  return (
    <li>
      <b>{text.lineName(line.article, line.size, line.soleColour, line.upperColour)}</b> — {text.lineShort(line.shortfallUppers)}
      <ul>
        {saved.returnedUpperPairs > 0 ? <li>{text.summaryReturned(saved.returnedUpperPairs)}</li> : null}
        {saved.bCartons > 0 ? <li>{text.summaryB(saved.bCartons)}</li> : null}
        {saved.cutSizeUppers > 0 ? <li>{text.summaryCutUpper(saved.cutSizeUppers)}</li> : null}
        {saved.cutSizePairs > 0 ? <li>{text.summaryCutPairs(saved.cutSizePairs)}</li> : null}
        {saved.claims.map((claim, index) => (
          <li key={claim.claimNumber ?? `legacy-${index}`}>
            {text.summaryClaim(claim.pairs, claim.partyName, claim.amountPaisa == null ? null : formatMoney(fromPaisa(claim.amountPaisa)), claim.reason, claim.claimNumber)}
          </li>
        ))}
      </ul>
    </li>
  );
};

/** How a closed program was closed, and — when reconciled — what became of every missing pair. */
const ClosedSummary: React.FC<{ view: MachineProgramReconciliation }> = ({ view }) => {
  const closure = view.closure!;
  const at = formatDateTime(closure.closedAt);
  const reconciled = view.lines.filter((line) => line.saved);
  return (
    <div className="mpr-closed">
      <p className="mpr-closed-head">
        {closure.outcome === "COMPLETE" ? text.closedComplete(closure.closedBy, at) : text.closedReconciled(closure.closedBy, at)}
      </p>
      <p className="mpi-section-line">{text.closedFigures(closure.cartonsBack, closure.cartonsDue)}</p>
      {reconciled.length > 0 ? (
        <ul className="mpr-summary" aria-label={text.summaryTitle}>
          {reconciled.map((line) => (
            <SavedLine key={line.lineId} line={line} />
          ))}
        </ul>
      ) : null}
    </div>
  );
};

/** The standing line under the figures: pairs to account for, fix cartons not back, or all back. */
const standingLines = (view: MachineProgramReconciliation): string[] => {
  const lines: string[] = [];
  if (shortUppers(view) > 0) lines.push(text.cartonsShort(shortCartons(view), shortUppers(view)));
  if (view.fixCartonsShort > 0) lines.push(text.fixCartonsShort(view.fixCartonsShort));
  return lines.length > 0 ? lines : [text.allBack];
};

/** The open program's standing: the figures, and whichever Reconciliation it needs. */
const OpenStanding: React.FC<{ view: MachineProgramReconciliation; close: ProgramCloseState; target?: BCartonsTarget }> = ({ view, close, target }) => {
  const reconcileUppers = target && upperLinesToReconcile(view).length > 0;
  return (
    <div className="mpr-standing">
      <p className="mpr-standing-figures">{text.cartonsBack(view.cartonsBack, view.cartonsDue)}</p>
      {standingLines(view).map((line) => (
        <p className="mpi-section-line" key={line}>
          {line}
        </p>
      ))}
      {/* With labels to turn into B cartons, the EVR FIX Reconciliation says where the missing
          cartons are; without one (Store Out), the plain shortfall list says it. */}
      {target && fixRunsToReconcile(view).length > 0 ? <BCartonReconciliation view={view} target={target} /> : <FixShortfall view={view} />}
      {reconcileUppers ? (
        <UpperReconciliation view={view} target={target} onComplete={close.complete} />
      ) : view.blockedReason ? (
        <p className="mp-problem" role="alert">
          ⚠ {view.blockedReason}
        </p>
      ) : null}
    </div>
  );
};

export const ProgramCloseSection: React.FC<ProgramCloseSectionProps> = ({ close, allowComplete, bCartons }) => {
  const [confirming, setConfirming] = useState(false);
  const [opening, setOpening] = useState(false);
  const view = close.reconciliation;

  // Store Out shows the section only once the program is closed.
  if (!allowComplete && !view?.closure) return null;

  // Short uppers are completed from the Reconciliation workspace, with what became of them.
  const completeHere = view && !view.closure && allowComplete && upperLinesToReconcile(view).length === 0;

  /** Reads the figures afresh, then asks to confirm — only when every carton is back. */
  const start = async () => {
    setOpening(true);
    const fresh = await close.load();
    setOpening(false);
    if (fresh && !fresh.closure && !fresh.blockedReason && shortUppers(fresh) === 0) setConfirming(true);
  };

  return (
    <section className="mpi-section" aria-label={text.title}>
      <header className="mpi-section-head">
        <div>
          <h2 className="mpi-section-title">{text.title}</h2>
          <p className="mpi-section-line">{text.line}</p>
        </div>
        {completeHere ? (
          <button type="button" className="mpi-action" onClick={() => void start()} disabled={opening || Boolean(view.blockedReason)}>
            {opening ? text.loading : text.complete}
          </button>
        ) : null}
      </header>

      {close.loading && !view ? <StateView kind="loading" compact message={text.loading} /> : null}
      {close.error && !view ? <StateView kind="error" compact message={close.error} onRetry={() => void close.load()} /> : null}

      {view?.closure ? <ClosedSummary view={view} /> : null}
      {view && !view.closure ? <OpenStanding view={view} close={close} target={bCartons} /> : null}

      {confirming && view ? (
        // Every carton is back: an EVR FIX carton still out keeps Complete disabled (blockedReason).
        <ConfirmDialog
          title={text.confirmTitle(view.code)}
          facts={[{ label: text.confirmFactCartons, value: text.cartonsBack(view.cartonsBack, view.cartonsDue) }]}
          explain={text.confirmExplain}
          confirmLabel={text.confirmAction}
          tone="primary"
          busyLabel={text.completing}
          onConfirm={() => close.complete([])}
          onClose={() => setConfirming(false)}
        />
      ) : null}
    </section>
  );
};
