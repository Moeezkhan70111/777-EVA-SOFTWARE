import React, { useId, useState } from "react";
import { claimAmountPaisa, claimRatePaisaProblem, typedRupeesToPaisa } from "@erp/domain";
import { Modal } from "../../components/shared/Modal";
import { copy } from "../../config/copy";
import { rupees, type ClaimOutcome } from "./useClaims";
import type { ClaimRequest } from "./claimReplies";

// PRICE AND POST (docs/55). Accounts types the amount for one pair; the total is shown before anything is saved:
//
//   2 × Rs 50.00 = Rs 100.00
//   The total is deducted from what we owe ABC UPPER, on their ledger, from today. It moves no stock and no cash.
//                                                                     [ Cancel ]  [ Post Rs 100.00 ]
//
// The rule an amount must meet is the domain's (claimRatePaisaProblem), the same one the data layer applies inside its
// transaction. One claim id per opening of this dialog, so pressing Post again after a lost answer never posts twice.

const words = copy.claims;

interface PostClaimDialogProps {
  request: ClaimRequest;
  busy: boolean;
  onPost: (ratePaisa: number, claimId: string) => Promise<ClaimOutcome>;
  onClose: () => void;
}

export const PostClaimDialog: React.FC<PostClaimDialogProps> = ({ request, busy, onPost, onClose }) => {
  const [typed, setTyped] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [claimId] = useState(() => crypto.randomUUID());
  const inputId = useId();
  const ratePaisa = typedRupeesToPaisa(typed);
  const rateProblem = ratePaisa === null ? (typed.trim() === "" ? null : words.rateHint) : claimRatePaisaProblem(ratePaisa);
  const total = ratePaisa !== null && rateProblem === null ? claimAmountPaisa({ pairs: request.pairs, ratePaisa }) : null;

  const submit = async () => {
    if (ratePaisa === null || total === null) return;
    const outcome = await onPost(ratePaisa, claimId);
    if (outcome.ok) onClose();
    else setProblem(outcome.message);
  };

  return (
    <Modal
      title={words.postTitle(request.requestNumber)}
      subtitle={`${request.partyName} · ${words.pairsOf(request.pairs, request.materialName)}`}
      onClose={onClose}
      footer={
        <button type="button" className="btn btn-primary" disabled={busy || total === null} onClick={() => void submit()}>
          {busy ? words.working : total === null ? words.postConfirm("—") : words.postConfirm(rupees(total))}
        </button>
      }
    >
      <div className="claims-dialog">
        <label className="claims-field" htmlFor={inputId}>
          <span>{words.ratePerPair}</span>
          <input
            id={inputId}
            className="form-input"
            type="text"
            inputMode="decimal"
            autoFocus
            value={typed}
            aria-invalid={rateProblem !== null}
            aria-describedby={`${inputId}-hint`}
            onChange={(event) => { setTyped(event.target.value); setProblem(null); }}
          />
        </label>
        <small id={`${inputId}-hint`} className="claims-muted">{rateProblem ?? words.rateHint}</small>
        <p className="claims-preview" aria-live="polite">
          {total === null || ratePaisa === null ? words.previewNone : words.preview(request.pairs, rupees(ratePaisa), rupees(total))}
        </p>
        <p className="claims-muted">{words.postExplain(request.partyName)}</p>
        {problem ? <p className="claims-problem" role="alert">⚠ {problem}</p> : null}
      </div>
    </Modal>
  );
};
