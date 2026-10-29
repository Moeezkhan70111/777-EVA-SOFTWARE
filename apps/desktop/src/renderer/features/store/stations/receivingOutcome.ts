import { copy } from "../../../config/copy";
import type { RawMaterialReceiptResult } from "../../../types/desktopApi";
import { earlierInSession, quantityOf, type NameSplitter, type ScanOutcome, type SessionScan } from "./scanOutcome";

// What the receiving station says after a scan (0.3.9): the business layer's answer as the rail
// reads it. A refusal is a sentence, what happened, and what to do — never a colour alone.

const words = copy.storeScan.receiving;

interface Refusal {
  reason: string;
  happened: string | null;
  todo: string;
}

const refusalFor = (result: RawMaterialReceiptResult, scans: readonly SessionScan[]): Refusal => {
  const said = result.reason ?? null;
  switch (result.outcome) {
    case "ALREADY_IN_STORE":
      return { reason: words.alreadyIn, happened: earlierInSession(scans, result.qrId) ?? words.receivedBefore, todo: copy.storeScan.putAside };
    case "WRONG_PARTY":
      return { reason: words.wrongSupplier, happened: said, todo: words.wrongSupplierTodo };
    case "UNKNOWN_QR":
      return { reason: words.unknown, happened: words.unknownHappened, todo: copy.storeScan.askOffice };
    case "NOT_CONFIGURED":
      return { reason: words.notSet, happened: said, todo: words.notSetTodo };
    case "INVALID_FORMAT":
      return { reason: words.notRawMaterial, happened: said, todo: words.notRawMaterialTodo };
    case "NOT_ELIGIBLE":
      return { reason: words.cannot, happened: said, todo: copy.storeScan.askOffice };
    case "STATUS_CHANGED":
      return { reason: words.movedElsewhere, happened: said, todo: copy.storeScan.scanAgain };
    case "NOT_AUTHORIZED":
      return { reason: words.notAllowed, happened: said, todo: words.notAllowedTodo };
    default:
      return { reason: words.failed, happened: said, todo: words.failedTodo };
  }
};

/** The answer to one receipt scan. `scans` is the session as it stood, to explain a double scan. */
export const receivingOutcomeFor = (result: RawMaterialReceiptResult, scans: readonly SessionScan[], seq: number, split: NameSplitter): ScanOutcome => {
  if (result.accepted) {
    return {
      kind: "accepted",
      seq,
      material: split(result.itemDisplayName ?? "—"),
      quantity: quantityOf(result.packingQuantity, result.packingUnitCode),
      code: result.qrId ?? null,
      note: null,
    };
  }
  return { kind: "refused", seq, code: result.qrId ?? null, ...refusalFor(result, scans) };
};
