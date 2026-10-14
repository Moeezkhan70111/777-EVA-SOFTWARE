import { RECEIVE_PRODUCTION_OUTCOME, type ReceiveProductionOutcome } from "@erp/domain";
import { copy } from "../../config/copy";
import type { ProductionReceipt, ReceiveProductionResult } from "../../types/desktopApi";
import type { ScanStationFeedback, ScanStationResult, ScanTone } from "../scanStation/scanStation";
import { formatDateTime } from "../../utils/dates";
import { qrStageMeta } from "../../utils/qrLifecycle";

// What the scan panel says for each outcome the main process decided. Words only — whether a
// carton may be received is never worked out here (R13).

const text = copy.receiveProduction;

export const READY_FEEDBACK: ScanStationFeedback = {
  tone: "idle",
  title: text.readyTitle,
  message: text.readyMessage,
  result: null,
  seq: 0,
};

/** "SK6 · 7/10 · BLACKGREY", with B for a B carton. */
export const receiptProduct = (receipt: Pick<ProductionReceipt, "article" | "size" | "color" | "grade">): string =>
  [receipt.article, receipt.size, receipt.color].join(" · ") + (receipt.grade ? ` · ${text.bCarton}` : "");

const receiptResult = (receipt: ProductionReceipt): ScanStationResult => ({
  qrId: receipt.qrId,
  product: receiptProduct(receipt),
  toStatus: qrStageMeta(receipt.stage).label,
  fromStatus: qrStageMeta("REGISTERED").label,
  currentStatusLabel: qrStageMeta(receipt.stage).label,
  facts: [
    { label: text.factProgram, value: receipt.programCode ? `${receipt.programCode} · ${receipt.machineName ?? ""}` : null },
    { label: text.factBy, value: receipt.receivedBy },
  ],
  at: receipt.receivedAt,
  atLabel: text.receivedAtLabel,
});

const TONE: Record<ReceiveProductionOutcome, ScanTone> = {
  RECEIVED: "success",
  ALREADY_RECEIVED: "warn",
  NOT_GENERATED: "error",
  RAW_MATERIAL_QR: "error",
  INVALID_QR: "error",
  INELIGIBLE: "error",
  ERROR: "error",
};

const words = (result: ReceiveProductionResult): { title: string; message: string } => {
  switch (result.outcome) {
    case RECEIVE_PRODUCTION_OUTCOME.RECEIVED:
      return { title: text.receivedTitle, message: result.reason ?? text.receivedMessage };
    case RECEIVE_PRODUCTION_OUTCOME.ALREADY_RECEIVED:
      return { title: text.alreadyTitle, message: text.alreadyMessage(result.receipt ? formatDateTime(result.receipt.receivedAt) : "earlier") };
    case RECEIVE_PRODUCTION_OUTCOME.NOT_GENERATED:
      return { title: text.notGeneratedTitle, message: text.notGeneratedMessage };
    case RECEIVE_PRODUCTION_OUTCOME.RAW_MATERIAL_QR:
      return { title: text.rawMaterialTitle, message: text.rawMaterialMessage };
    case RECEIVE_PRODUCTION_OUTCOME.INVALID_QR:
      return { title: text.invalidTitle, message: text.invalidMessage };
    case RECEIVE_PRODUCTION_OUTCOME.INELIGIBLE:
      return { title: text.ineligibleTitle, message: result.reason ?? text.invalidMessage };
    default:
      return { title: text.errorTitle, message: result.reason ?? text.errorMessage };
  }
};

/** The panel's feedback for one scan's result; `seq` re-animates it even for an identical result. */
export const feedbackFor = (result: ReceiveProductionResult, scanned: string, seq: number): ScanStationFeedback => ({
  tone: TONE[result.outcome] ?? "error",
  ...words(result),
  result: result.receipt ? receiptResult(result.receipt) : { qrId: result.qrId ?? scanned },
  seq,
});
