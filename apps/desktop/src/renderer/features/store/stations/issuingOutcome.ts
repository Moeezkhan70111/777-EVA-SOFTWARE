import { copy } from "../../../config/copy";
import type { RawMaterialIssueResult } from "../../../types/desktopApi";
import { earlierInSession, quantityOf, type ScanOutcome, type SessionScan } from "./scanOutcome";

// What the issuing station says after a scan (0.3.9): the business layer's answer as the rail reads
// it. A refusal is a sentence, what happened, and what to do — never a colour alone.

const words = copy.storeScan.issuing;

interface Refusal {
  reason: string;
  happened: string | null;
  todo: string;
}

const refusalFor = (result: RawMaterialIssueResult, scans: readonly SessionScan[]): Refusal => {
  const said = result.reason ?? null;
  switch (result.outcome) {
    case "NOT_IN_STORE": {
      // Scanned out earlier in this very session: say so, with when — that is a double scan.
      const earlier = earlierInSession(scans, result.qrId);
      return earlier
        ? { reason: words.alreadyOut, happened: earlier, todo: copy.storeScan.putAside }
        : { reason: words.notInStore, happened: said, todo: copy.storeScan.askOffice };
    }
    case "NO_PARTY":
      return { reason: words.noParty, happened: said, todo: words.noPartyTodo };
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

/** Shown when a packet is scanned before a party is chosen. Nothing was sent or moved. */
export const choosePartyFirst = (seq: number, code: string | null): ScanOutcome => ({
  kind: "refused",
  seq,
  code,
  reason: words.noParty,
  happened: null,
  todo: words.noPartyTodo,
});

/** "Counted to MACHINE 2 · 12 of 50 DOZ", when a machine program was waiting for the packet. */
const programNote = (result: RawMaterialIssueResult): string | null => {
  const program = result.machineProgram;
  if (!program) return null;
  const taken = `${program.lineConsumed} of ${program.lineQuantity}${program.unitCode ? ` ${program.unitCode}` : ""}`;
  return words.program(program.machineName, taken);
};

/** The answer to one issue scan. `scans` is the session as it stood, to explain a double scan. */
export const issuingOutcomeFor = (result: RawMaterialIssueResult, scans: readonly SessionScan[], seq: number): ScanOutcome => {
  if (result.accepted) {
    return {
      kind: "accepted",
      seq,
      material: result.itemDisplayName ?? "—",
      quantity: quantityOf(result.packingQuantity, result.packingUnitCode),
      code: result.qrId ?? null,
      note: programNote(result),
    };
  }
  return { kind: "refused", seq, code: result.qrId ?? null, ...refusalFor(result, scans) };
};
