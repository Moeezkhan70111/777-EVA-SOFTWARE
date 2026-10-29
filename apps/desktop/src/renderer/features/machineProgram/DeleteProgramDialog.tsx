import React, { useId, useState } from "react";
import { MACHINE_PROGRAM_DELETE_REASON_MIN } from "@erp/domain";
import { Modal } from "../../components/shared/Modal";
import { copy } from "../../config/copy";
import { formatDate } from "../../utils/dates";
import type { OpenMachineProgram } from "../../types/desktopApi";

// DELETING A MACHINE PROGRAM (0.3.8) — hard to do by accident. The administrator types why; the
// button stays off until the reason is long enough, and the reason goes into the audit record. The
// main process checks both again: only an administrator, and never without a reason.

const text = copy.cartonProgram;

interface DeleteProgramDialogProps {
  program: OpenMachineProgram;
  /** Resolves with the refusal to show, or null once deleted. */
  onDelete: (reason: string) => Promise<string | null>;
  onClose: () => void;
}

export const DeleteProgramDialog: React.FC<DeleteProgramDialogProps> = ({ program, onDelete, onClose }) => {
  const reasonId = useId();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const ready = reason.trim().length >= MACHINE_PROGRAM_DELETE_REASON_MIN && !busy;

  const confirm = async () => {
    if (!ready) return;
    setBusy(true);
    setRefusal(null);
    const problem = await onDelete(reason.trim());
    setBusy(false);
    if (problem) setRefusal(problem);
  };

  return (
    <Modal
      title={text.deleteTitle(program.code)}
      subtitle={`${program.machineName} · ${formatDate(program.programDate)}`}
      onClose={onClose}
      footer={
        <button type="button" className="btn btn-danger" disabled={!ready} onClick={() => void confirm()}>
          {busy ? text.deleting : text.deleteConfirm(program.code)}
        </button>
      }
    >
      <p>{text.deleteExplain}</p>
      <div className="form-group">
        <label htmlFor={reasonId}>{text.deleteReasonLabel}</label>
        <textarea
          id={reasonId}
          className="form-input"
          rows={3}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          aria-describedby={`${reasonId}-help`}
        />
        <p id={`${reasonId}-help`} className="field-help">
          {text.deleteReasonHelp(MACHINE_PROGRAM_DELETE_REASON_MIN)}
        </p>
      </div>
      {refusal ? (
        <p className="mp-problem" role="alert">
          ⚠ {refusal}
        </p>
      ) : null}
    </Modal>
  );
};
