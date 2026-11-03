import React, { useState } from "react";
import { ConfirmDialog } from "../../components/shared/ConfirmDialog";
import { copy } from "../../config/copy";
import type { ManualProductionEntry } from "../../types/desktopApi";

// VOID ONE ENTRY — the shared confirmation, with the reason it requires (docs/42 section 5):
//
//   Void MAN-000003?
//   Product   SK6 7/10 RED      Cartons  20      Machine  MACHINE 1 · MP-000123
//   Its cartons come out of store stock on every computer, and it leaves …
//   ⚠ If the contractor has already been paid for it, the ledger will show them overpaid.
//   Reason (required) [______________________]
//                                                                  [ Void entry ]
//
// The main process checks the reason again and refuses a blank one: this only says so sooner.

const text = copy.manualProduction;

export const VoidEntryDialog: React.FC<{
  entry: ManualProductionEntry;
  onVoid: (entryId: string, reason: string) => Promise<string | null>;
  onClose: () => void;
}> = ({ entry, onVoid, onClose }) => {
  const [reason, setReason] = useState("");
  const confirm = async (): Promise<string | null> => (reason.trim() ? onVoid(entry.id, reason.trim()) : text.voidReasonRequired);

  return (
    <ConfirmDialog
      title={text.voidTitle(entry.code)}
      facts={[
        { label: text.voidFactProduct, value: `${entry.article} ${entry.size} ${entry.color}` },
        { label: text.voidFactCartons, value: entry.cartons.toLocaleString() },
        { label: text.voidFactMachine, value: `${entry.machineName} · ${entry.programCode}` },
      ]}
      explain={text.voidExplain}
      warning={text.voidWarning}
      confirmLabel={text.voidConfirm}
      busyLabel={text.voidBusy}
      onConfirm={confirm}
      onClose={onClose}
    >
      <div className="form-group">
        <label className="input-label" htmlFor="void-reason">{text.voidReasonLabel}</label>
        <textarea
          id="void-reason"
          className="form-input"
          rows={2}
          value={reason}
          required
          aria-describedby="void-reason-hint"
          onChange={(event) => setReason(event.target.value)}
        />
        <p id="void-reason-hint" className="field-help">{text.voidReasonHint}</p>
      </div>
    </ConfirmDialog>
  );
};
