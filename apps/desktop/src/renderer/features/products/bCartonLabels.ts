import { B_CARTON_COLOUR, CARTON_GRADE, MAX_QR_BATCH_QUANTITY, buildQrId, formatQrSerial } from "@erp/domain";
import { copy } from "../../config/copy";
import type { QrBatchRow, QrSequenceState } from "../../types/desktopApi";

// What the B carton label page needs to decide, kept out of the component (R13): how many labels
// may be asked for, and exactly which identities a run would register.
//
// A B carton's colour is never chosen — it is MIX, because its contents are mixed (migration 074).

/** The identities a run would register, worked out before the operator commits. */
export interface BCartonRange {
  quantity: number;
  first: string;
  last: string;
  /** Nothing has been registered for this article + MIX + size before. */
  isFirstEver: boolean;
  alreadyGenerated: number;
}

/** Why this many labels cannot be asked for, or null. Empty is not a problem — it is unanswered. */
export const bCartonQuantityProblem = (typed: string): string | null => {
  const text = typed.trim();
  if (text === "") return null;
  const quantity = Number(text);
  if (!Number.isFinite(quantity) || !Number.isInteger(quantity)) return copy.bCartons.wholeNumber;
  if (quantity <= 0) return copy.bCartons.atLeastOne;
  if (quantity > MAX_QR_BATCH_QUANTITY) return copy.bCartons.atMost(MAX_QR_BATCH_QUANTITY);
  return null;
};

/**
 * The exact range a run would register, or null while the form cannot say one.
 *
 * Built with the same domain builder the registry writes with, so what the operator reads is what
 * is registered. `formatQrSerial` is the fallback shape for a combination the builder refuses —
 * the generator itself would refuse it too, and the button stays off.
 */
export const bCartonRange = (sequence: QrSequenceState | null, typedQuantity: string): BCartonRange | null => {
  if (!sequence || bCartonQuantityProblem(typedQuantity)) return null;
  const quantity = Number(typedQuantity.trim());
  if (!Number.isInteger(quantity) || quantity <= 0) return null;

  const parts = { article: sequence.article, color: sequence.color, size: sequence.size };
  const start = sequence.nextSequence;
  const identity = (at: number): string => {
    try {
      return buildQrId({ ...parts, sequence: at });
    } catch {
      return `${parts.article}_${parts.color}_${parts.size}_${formatQrSerial(at)}`;
    }
  };
  return {
    quantity,
    first: identity(start),
    last: identity(start + quantity - 1),
    isFirstEver: sequence.lastSequence === 0,
    alreadyGenerated: sequence.lastSequence,
  };
};

/** Whether a generated run is a B carton run — what this page lists, and nothing else. */
export const isBCartonBatch = (batch: QrBatchRow): boolean =>
  batch.grade === CARTON_GRADE.B && batch.color === B_CARTON_COLOUR;
