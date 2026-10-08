import React, { useState } from "react";
import { Modal } from "./Modal";
import { copy } from "../../config/copy";

// The one "are you sure?" dialog: a title, the facts of what is about to happen, a plain
// explanation, and a button that says what it does. Written for Machine Program's destructive
// actions; promoted here when label printing needed the same confirmation (R1/R11).

export interface ConfirmFact {
  label: string;
  value: string;
}

interface ConfirmDialogProps {
  title: string;
  facts: ConfirmFact[];
  explain: string;
  /** A second, stronger line — what will NOT come back. */
  warning?: string | null;
  confirmLabel: string;
  /** Red for actions that undo or remove something; blue for an ordinary go-ahead. */
  tone?: "danger" | "primary";
  /** Shown on the button while `onConfirm` runs. */
  busyLabel?: string;
  /** Resolves with a reason to stay open and show it, or null to close. */
  onConfirm: () => Promise<string | null>;
  onClose: () => void;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  title,
  facts,
  explain,
  warning,
  confirmLabel,
  tone = "danger",
  busyLabel = copy.common.saving,
  onConfirm,
  onClose,
}) => {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const confirm = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const refused = await onConfirm();
      if (refused) setProblem(refused);
      else onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <button type="button" className={`btn btn-${tone}`} disabled={busy} onClick={() => void confirm()}>
          {busy ? busyLabel : confirmLabel}
        </button>
      }
    >
      <dl className="confirm-facts">
        {facts.map((fact) => (
          <div key={fact.label}>
            <dt>{fact.label}</dt>
            <dd>{fact.value}</dd>
          </div>
        ))}
      </dl>
      <p className="confirm-note">{explain}</p>
      {warning ? (
        <p className="confirm-warning" role="status">
          ⚠ {warning}
        </p>
      ) : null}
      {problem ? (
        <p className="confirm-problem" role="alert">
          ⚠ {problem}
        </p>
      ) : null}
    </Modal>
  );
};
