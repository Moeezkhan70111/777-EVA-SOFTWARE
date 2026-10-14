import React, { useState } from "react";
import { copy } from "../../../config/copy";
import { ConfirmDialog } from "../../../components/shared/ConfirmDialog";
import type { MachineProgramReconciliation, ReconciliationEntryInput, ReconciliationLine } from "../../../types/desktopApi";
import { ReturnUpperScan } from "./ReturnUpperScan";
import { UpperLineCard } from "./UpperLineCard";
import { emptyUpperDraft, toEntry, upperDraftProblem, type UpperDraft } from "./upperDraft";
import { useUpperActions } from "./useUpperActions";

// RECONCILIATION of the upper lines — one workspace, everything visible at once:
//
//   Return Upper   [ scan a sealed packet ]                         (stock in, now)
//   ┌ SK6 7/10 · BLACK / RED ─────────────────────────────────────────────────────┐
//   │ Expected · Upper returned · Cartons back · B cartons · Remaining            │
//   │ B-Carton MIX · Cut Size Upper · Cut Size Pairs · Damaged / Claim │ Balance  │
//   └──────────────────────────────────────────────────────────────────────────────┘
//                                                         [ Reconcile & Complete ]
//
// What is typed is kept per upper until the program closes; a scan or a B carton re-reads how the
// program stands and every balance follows. The close itself is the main process's, which checks
// every rule again inside its write lock.

const text = copy.programClose;

interface UpperReconciliationProps {
  view: MachineProgramReconciliation;
  target: { token: string; programId: string; programCode: string; onConverted: () => Promise<void> };
  onComplete: (entries: ReconciliationEntryInput[]) => Promise<string | null>;
}

/** The upper lines with something to reconcile: cartons missing, or B labels still out. */
export const upperLinesToReconcile = (view: MachineProgramReconciliation): ReconciliationLine[] =>
  view.lines.filter((line) => line.missingCartons > 0 || line.bCartons > line.bBack);

export const UpperReconciliation: React.FC<UpperReconciliationProps> = ({ view, target, onComplete }) => {
  const { returnUpper, convertToB } = useUpperActions({ ...target, onChanged: target.onConverted });
  const [drafts, setDrafts] = useState<Record<string, UpperDraft>>({});
  const [asking, setAsking] = useState(false);
  const lines = upperLinesToReconcile(view);
  const short = view.lines.filter((line) => line.shortfallUppers > 0);
  const draftOf = (lineId: string): UpperDraft => drafts[lineId] ?? emptyUpperDraft();
  const ready = !view.blockedReason && short.every((line) => upperDraftProblem(line, draftOf(line.lineId)) === null);
  const claims = short.reduce((total, line) => total + draftOf(line.lineId).claims.length, 0);
  const pairs = short.reduce((total, line) => total + line.shortfallUppers, 0);

  return (
    <section className="mur" aria-label={text.reconTitle}>
      <header className="mur-head">
        <h3 className="mur-title">{text.reconTitle}</h3>
        <p className="mur-lead">{text.reconLine}</p>
      </header>

      <ReturnUpperScan onReturn={returnUpper} disabled={false} />

      {lines.map((line) => (
        <UpperLineCard
          key={line.lineId}
          line={line}
          draft={draftOf(line.lineId)}
          parties={{ machine: view.machineContractor, packing: view.packingContractor }}
          convertToB={convertToB}
          disabled={false}
          onChange={(next) => setDrafts((previous) => ({ ...previous, [line.lineId]: next }))}
        />
      ))}

      {view.blockedReason ? (
        <p className="mp-problem" role="alert">
          ⚠ {view.blockedReason}
        </p>
      ) : null}
      <div className="mur-submit">
        <button type="button" className="btn btn-primary btn-lg" disabled={!ready} onClick={() => setAsking(true)}>
          {text.submit}
        </button>
      </div>

      {asking ? (
        <ConfirmDialog
          title={text.submitTitle(view.code)}
          facts={[
            { label: text.confirmFactCartons, value: text.cartonsBack(view.cartonsBack, view.cartonsDue) },
            { label: text.submitFactPairs, value: text.pairs(pairs) },
            { label: text.submitFactClaims, value: String(claims) },
          ]}
          explain={text.submitExplain}
          confirmLabel={text.submit}
          tone="primary"
          busyLabel={text.completing}
          onConfirm={() => onComplete(short.map((line) => toEntry(line.lineId, draftOf(line.lineId))))}
          onClose={() => setAsking(false)}
        />
      ) : null}
    </section>
  );
};
