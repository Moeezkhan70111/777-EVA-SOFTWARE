import { UPPER_ISSUE_OUTCOME, type UpperIssueOutcome } from "@erp/domain";
import { copy } from "../../config/copy";
import type { UpperIssueResult, UpperIssueRow, UpperQuantity } from "../../types/desktopApi";
import type { ScanStationFeedback, ScanStationResult, ScanTone } from "../scanStation/scanStation";
import { formatDateTime } from "../../utils/dates";

// What the scan panel says for each outcome the main process decided. Words only — whether an upper
// may be issued is never worked out here (R13).

const text = copy.upperMoveOut;

/** "5 DOZEN", in the material's own unit; several units side by side, never added together. */
export const formatUpperQuantity = (quantity: UpperQuantity): string => `${quantity.quantity.toLocaleString()} ${quantity.unitCode}`.trim();
export const formatUpperQuantities = (quantities: UpperQuantity[]): string =>
  quantities.length === 0 ? "—" : quantities.map(formatUpperQuantity).join(" + ");

/** "SK6 · 7/10 · RED", or the material's name when it carries no article. */
export const upperProduct = (issue: Pick<UpperIssueRow, "article" | "size" | "colour" | "itemDisplayName">): string =>
  issue.article ? [issue.article, issue.size, issue.colour].filter(Boolean).join(" · ") : issue.itemDisplayName;

export const idleFeedback = (machineName: string | null, seq: number): ScanStationFeedback =>
  machineName
    ? { tone: "idle", title: text.readyTitle, message: text.readyMessage(machineName), result: null, seq }
    : { tone: "warn", title: text.selectMachineTitle, message: text.selectMachineMessage, result: null, seq };

const issueResult = (issue: UpperIssueRow): ScanStationResult => ({
  qrId: issue.qrId,
  product: upperProduct(issue),
  facts: [
    { label: text.factQuantity, value: formatUpperQuantity({ quantity: issue.quantity, unitCode: issue.unitCode }) },
    { label: text.factMachine, value: issue.machineName },
    { label: text.factBy, value: issue.issuedBy },
  ],
  at: issue.issuedAt,
  atLabel: text.issuedAtLabel,
});

const TONE: Record<UpperIssueOutcome, ScanTone> = {
  ISSUED: "success",
  ALREADY_ISSUED: "warn",
  MACHINE_REQUIRED: "warn",
  MACHINE_INELIGIBLE: "error",
  FINISHED_CARTON: "error",
  NOT_UPPER: "error",
  INVALID_QR: "error",
  UNKNOWN_QR: "error",
  NOT_IN_STORE: "error",
  INELIGIBLE: "error",
  NOT_CONFIGURED: "error",
  INSUFFICIENT_STOCK: "error",
  CONCURRENT_ISSUE: "warn",
  ERROR: "error",
};

const TITLE: Record<UpperIssueOutcome, string> = {
  ISSUED: text.issuedTitle,
  ALREADY_ISSUED: text.alreadyTitle,
  MACHINE_REQUIRED: text.selectMachineTitle,
  MACHINE_INELIGIBLE: text.machineIneligibleTitle,
  FINISHED_CARTON: text.finishedTitle,
  NOT_UPPER: text.notUpperTitle,
  INVALID_QR: text.invalidTitle,
  UNKNOWN_QR: text.unknownTitle,
  NOT_IN_STORE: text.notInStoreTitle,
  INELIGIBLE: text.ineligibleTitle,
  NOT_CONFIGURED: text.notConfiguredTitle,
  INSUFFICIENT_STOCK: text.insufficientTitle,
  CONCURRENT_ISSUE: text.concurrentTitle,
  ERROR: text.errorTitle,
};

const message = (result: UpperIssueResult, machineName: string): string => {
  if (result.outcome === UPPER_ISSUE_OUTCOME.ISSUED) return result.reason ?? text.issuedMessage(machineName);
  if (result.outcome === UPPER_ISSUE_OUTCOME.ALREADY_ISSUED) {
    return result.issue ? text.alreadyMessage(result.issue.machineName, formatDateTime(result.issue.issuedAt)) : text.alreadyMessageUnknown;
  }
  if (result.outcome === UPPER_ISSUE_OUTCOME.MACHINE_REQUIRED) return text.selectMachineMessage;
  return result.reason ?? text.errorMessage;
};

/** The panel's feedback for one scan's result; \`seq\` re-animates it even for an identical result. */
export const feedbackForIssue = (result: UpperIssueResult, scanned: string, machineName: string, seq: number): ScanStationFeedback => ({
  tone: TONE[result.outcome] ?? "error",
  title: TITLE[result.outcome] ?? text.errorTitle,
  message: message(result, machineName),
  result: result.issue ? issueResult(result.issue) : { qrId: result.qrId ?? scanned },
  seq,
});
