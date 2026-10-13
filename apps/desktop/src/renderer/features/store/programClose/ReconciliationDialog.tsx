import React, { useState } from "react";
import { Modal } from "../../../components/shared/Modal";
import { copy } from "../../../config/copy";
import type { MachineProgramReconciliation, ReconciliationEntryInput } from "../../../types/desktopApi";
import { FixShortfall } from "./FixShortfall";
import { ReconciliationLineForm } from "./ReconciliationLineForm";
import { draftProblem, emptyDraft, toEntry, type LineDraft } from "./reconciliationDraft";

// RECONCILIATION — Complete Program when cartons are short.
//
// One block per upper that came back short, and one button that saves them all and closes the
// program. Save stays off until every block accounts for its last upper; the main process checks
// the same rule again, against the shortfall it works out itself, before anything is written.

interface ReconciliationDialogProps {
  reconciliation: MachineProgramReconciliation;
  onSubmit: (entries: ReconciliationEntryInput[]) => Promise<string | null>;
  onClose: () => void;
}

export const ReconciliationDialog: React.FC<ReconciliationDialogProps> = ({ reconciliation, onSubmit, onClose }) => {
  const short = reconciliation.lines.filter((line) => line.shortfallUppers > 0);
  const [drafts, setDrafts] = useState<Record<string, LineDraft>>(() =>
    Object.fromEntries(short.map((line) => [line.lineId, emptyDraft(line)]))
  );
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);

  const ready = short.every((line) => draftProblem(line, drafts[line.lineId]) === null);

  const submit = async () => {
    setSaving(true);
    setRefused(null);
    const refusal = await onSubmit(short.map((line) => toEntry(line.lineId, drafts[line.lineId])));
    setSaving(false);
    if (refusal) setRefused(refusal);
    else onClose();
  };

  return (
    <Modal
      title={copy.programClose.dialogTitle(reconciliation.code)}
      subtitle={copy.programClose.dialogIntro}
      wide
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary btn-lg" onClick={onClose} disabled={saving}>
            {copy.programClose.cancel}
          </button>
          <button type="button" className="btn btn-primary btn-lg" onClick={() => void submit()} disabled={!ready || saving}>
            {saving ? copy.programClose.completing : copy.programClose.submit}
          </button>
        </>
      }
    >
      {/* EVR FIX cartons short have no upper to account for — said here, not asked. */}
      <FixShortfall view={reconciliation} />
      <div className="mpr-lines">
        {short.map((line) => (
          <ReconciliationLineForm
            key={line.lineId}
            line={line}
            draft={drafts[line.lineId]}
            machineContractor={reconciliation.machineContractor}
            packingContractor={reconciliation.packingContractor}
            disabled={saving}
            onChange={(next) => setDrafts((previous) => ({ ...previous, [line.lineId]: next }))}
          />
        ))}
      </div>
      {refused ? (
        <p className="mp-problem" role="alert">
          ⚠ {refused}
        </p>
      ) : null}
    </Modal>
  );
};
