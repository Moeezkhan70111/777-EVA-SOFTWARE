import { copy } from "../../../config/copy";
import type { RawMaterialIssueResult } from "../../../types/desktopApi";
import type { ScanStationFeedback } from "../../scanStation/scanStation";
import { packingLabel } from "./packingLabel";

// What the issuing station says after a scan — the business layer's answer in words. Text always,
// never colour alone. Moved here from Raw Material Output (0.3.9) so the full-screen page and the
// Store page's Scan out rail say the same thing.

export const ISSUING_IDLE: ScanStationFeedback = {
  tone: "idle",
  title: "READY TO SCAN",
  message: "Scan a packet leaving the store",
  result: null,
  seq: 0,
};

/** Where a packet went: the party chosen on Scan Out, else its material's section. */
const destinationOf = (result: RawMaterialIssueResult): string | null =>
  result.issuedToPartyName || result.sectionName || null;

/** Shown when a packet is scanned before a party is chosen. Nothing was sent or moved. */
export const choosePartyFirst = (seq: number): ScanStationFeedback => ({
  tone: "warn",
  title: copy.moveOut.scanPartyFirstTitle,
  message: copy.moveOut.scanPartyFirstBody,
  result: null,
  seq,
});

/** Turns the business layer's answer into what the operator reads. Text always, never colour alone. */
export const issuingFeedbackFor = (result: RawMaterialIssueResult, seq: number): ScanStationFeedback => {
  const packing = packingLabel(result.packingQuantity, result.packingUnitCode, result.packName);
  const base = {
    seq,
    result: {
      qrId: result.qrId,
      product: result.itemDisplayName,
      fromStatus: "In Store",
      toStatus: destinationOf(result) ? `Issued to ${destinationOf(result)}` : "Issued",
      currentStatusLabel:
        result.currentStatus === "IN_STORE" ? "In Store" : result.currentStatus === "ISSUED" ? "Issued" : (result.currentStatus ?? null),
      facts: [
        { label: "Raw material", value: result.itemDisplayName },
        { label: "One pack", value: packing },
        { label: copy.moveOut.movedOutTo, value: result.issuedToPartyName },
        { label: "Goes to", value: result.sectionName },
        // Shown only when a machine program was waiting for this bag. The storekeeper chose no
        // program: the packet's own material and supplier found it (see IssueRawMaterialScanUseCase).
        ...(result.machineProgram
          ? [
              {
                label: "Machine program",
                value: `${result.machineProgram.machineName} — ${result.machineProgram.contractorName}`,
              },
            ]
          : []),
      ],
      at: result.issuedAt,
      atLabel: "Issued",
    },
  };

  switch (result.outcome) {
    case "ISSUED": {
      const program = result.machineProgram;
      return {
        ...base,
        tone: "success",
        title: "✓ ISSUED",
        // When a machine program was waiting, the count it is now on is the useful sentence —
        // the storekeeper can see how much of the program is still to come.
        message: program
          ? `${packing || "Pack"} → ${program.machineName} · ${program.lineConsumed} of ${program.lineQuantity}${program.unitCode ? ` ${program.unitCode}` : ""} taken` +
            (program.programCompleted ? " · program finished" : "")
          : `${packing || "Pack"} sent to ${destinationOf(result) ?? "its section"}`,
      };
    }
    case "NO_PARTY":
      return { ...base, tone: "warn", title: copy.moveOut.scanPartyRefusedTitle, message: result.reason ?? copy.moveOut.scanPartyFirstBody };
    case "NOT_IN_STORE":
      return { ...base, tone: "error", title: "✕ NOT IN STORE", message: result.reason ?? "This packet is not in the store." };
    case "UNKNOWN_QR":
      return { ...base, tone: "error", title: "✕ NOT REGISTERED", message: "This QR has not been generated in the system." };
    case "NOT_CONFIGURED":
      return { ...base, tone: "error", title: "✕ NOT SET UP", message: result.reason ?? "Set this material's packing and destination first." };
    case "INVALID_FORMAT":
      return { ...base, tone: "error", title: "✕ NOT A RAW MATERIAL QR", message: result.reason ?? "This is not a raw material label." };
    case "NOT_AUTHORIZED":
      return { ...base, tone: "error", title: "✕ NOT AUTHORISED", message: result.reason ?? "Your account cannot issue raw material." };
    case "NOT_ELIGIBLE":
      return { ...base, tone: "error", title: "✕ CANNOT ISSUE", message: result.reason ?? "This packet cannot be issued." };
    case "STATUS_CHANGED":
      return { ...base, tone: "warn", title: "⚠ TRY AGAIN", message: result.reason ?? "Another terminal moved this packet." };
    default:
      return { ...base, tone: "error", title: "✕ NOT ISSUED", message: result.reason ?? "The scan could not be saved." };
  }
};
