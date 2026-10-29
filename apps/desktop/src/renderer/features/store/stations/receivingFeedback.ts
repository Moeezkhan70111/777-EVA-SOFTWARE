import type { RawMaterialReceiptResult } from "../../../types/desktopApi";
import type { ScanStationFeedback } from "../../scanStation/scanStation";
import { packingLabel } from "./packingLabel";

// What the receiving station says after a scan — the business layer's answer in words. Text
// always, never colour alone. Moved here from Raw Material Input (0.3.9) so the full-screen page
// and the Store page's Scan in rail say the same thing.

export const RECEIVING_IDLE: ScanStationFeedback = {
  tone: "idle",
  title: "READY TO SCAN",
  message: "Scan a raw material packet",
  result: null,
  seq: 0,
};

/** Turns the business layer's answer into what the operator reads. Text always, never colour alone. */
export const receivingFeedbackFor = (result: RawMaterialReceiptResult, seq: number): ScanStationFeedback => {
  const packing = packingLabel(result.packingQuantity, result.packingUnitCode, result.packName);
  const base = {
    seq,
    result: {
      qrId: result.qrId,
      product: result.itemDisplayName,
      fromStatus: "Generated",
      toStatus: "In Store",
      currentStatusLabel: result.currentStatus === "IN_STORE" ? "In Store" : (result.currentStatus ?? null),
      facts: [
        { label: "Raw material", value: result.itemDisplayName },
        { label: "Supplier", value: result.partyName },
        { label: "One pack", value: packing },
      ],
      at: result.receivedAt,
    },
  };

  switch (result.outcome) {
    case "RECEIVED":
      return { ...base, tone: "success", title: "✓ RECEIVED", message: `${packing || "Pack"} added to stock` };
    case "ALREADY_IN_STORE":
      return { ...base, tone: "warn", title: "⚠ ALREADY RECEIVED", message: result.reason ?? "This packet has already been received." };
    case "WRONG_PARTY":
      return { ...base, tone: "error", title: "✕ WRONG SUPPLIER", message: result.reason ?? "This packet belongs to another supplier." };
    case "UNKNOWN_QR":
      return { ...base, tone: "error", title: "✕ NOT REGISTERED", message: "This QR has not been generated in the system." };
    case "NOT_CONFIGURED":
      return { ...base, tone: "error", title: "✕ PACK NOT SET", message: result.reason ?? "Set what one pack of this material holds first." };
    case "INVALID_FORMAT":
      return { ...base, tone: "error", title: "✕ NOT A RAW MATERIAL QR", message: result.reason ?? "This is not a raw material label." };
    case "NOT_AUTHORIZED":
      return { ...base, tone: "error", title: "✕ NOT AUTHORISED", message: result.reason ?? "Your account cannot receive raw material." };
    case "NOT_ELIGIBLE":
      return { ...base, tone: "error", title: "✕ CANNOT RECEIVE", message: result.reason ?? "This packet cannot be received." };
    case "STATUS_CHANGED":
      return { ...base, tone: "warn", title: "⚠ TRY AGAIN", message: result.reason ?? "Another terminal moved this packet." };
    default:
      return { ...base, tone: "error", title: "✕ NOT RECEIVED", message: result.reason ?? "The scan could not be saved." };
  }
};
