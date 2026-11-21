import React, { useId, useState } from "react";
import { claimDecisionReasonProblem } from "@erp/domain";
import { Modal } from "../../components/shared/Modal";
import { copy } from "../../config/copy";
import type { ClaimOutcome } from "./useClaims";

// REJECT A REQUEST, OR REVERSE A CLAIM (docs/55): both need a reason, which is kept with the claim's history. One dialog
// for both (R1). The rule a reason must meet is the domain's, the same the data layer applies.

const words = copy.claims;

interface ClaimReasonDialogProps {
  title: string;
  explain: string;
  confirm: string;
  busy: boolean;
  onConfirm: (reason: string) => Promise<ClaimOutcome>;
  onClose: () => void;
}

export const ClaimReasonDialog: React.FC<ClaimReasonDialogProps> = ({ title, explain, confirm, busy, onConfirm, onClose }) => {
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const inputId = useId();

  const submit = async () => {
    const invalid = claimDecisionReasonProblem(reason);
    if (invalid) {
      setProblem(invalid);
      return;
    }
    const outcome = await onConfirm(reason.trim());
    if (outcome.ok) onClose();
    else setProblem(outcome.message);
  };

  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void submit()}>
          {busy ? words.working : confirm}
        </button>
      }
    >
      <div className="claims-dialog">
        <p>{explain}</p>
        <label className="claims-field" htmlFor={inputId}>
          <span>{words.reason}</span>
          <textarea
            id={inputId}
            className="form-input"
            rows={3}
            autoFocus
            value={reason}
            placeholder={words.reasonPlaceholder}
            aria-invalid={problem !== null}
            onChange={(event) => { setReason(event.target.value); setProblem(null); }}
          />
        </label>
        {problem ? <p className="claims-problem" role="alert">⚠ {problem}</p> : null}
      </div>
    </Modal>
  );
};
