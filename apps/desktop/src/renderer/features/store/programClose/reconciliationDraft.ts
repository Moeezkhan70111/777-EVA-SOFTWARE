import { reconciliationEntryProblem } from "@erp/domain";
import type { ReconciliationEntryInput, ReconciliationLine, ReconciliationLossParty } from "../../../types/desktopApi";

// What the store types on the reconciliation screen for one short upper, and how it becomes what is
// sent. The rule it must meet — the three ways add up to the shortfall exactly, every claim with its
// party and reason — is the domain's (reconciliationEntryProblem), the same one the save applies
// inside the write lock. The screen uses it only to say what is still missing before Save.

/** One short upper's boxes, as typed. Uppers are whole numbers; an empty box is 0. */
export interface LineDraft {
  cutSize: string;
  wastage: string;
  wastagePartyId: string | null;
  wastageReason: string;
  lost: string;
  lostParty: ReconciliationLossParty | null;
  lostReason: string;
}

/** A fresh draft. With one supplier behind the upper, the wastage claim already names it. */
export const emptyDraft = (line: ReconciliationLine): LineDraft => ({
  cutSize: "",
  wastage: "",
  wastagePartyId: line.suppliers.length === 1 ? line.suppliers[0].partyId : null,
  wastageReason: "",
  lost: "",
  lostParty: null,
  lostReason: "",
});

/** Digits only: uppers are counted whole. */
export const cleanCount = (typed: string): string => typed.replace(/[^0-9]/g, "");

const count = (typed: string): number => (typed.trim() === "" ? 0 : Number(typed));

export const toEntry = (lineId: string, draft: LineDraft): ReconciliationEntryInput => ({
  lineId,
  cutSize: count(draft.cutSize),
  wastage: count(draft.wastage),
  wastagePartyId: draft.wastagePartyId,
  wastageReason: draft.wastageReason,
  lost: count(draft.lost),
  lostParty: draft.lostParty,
  lostReason: draft.lostReason,
});

/** How many of the line's missing uppers the draft accounts for so far. */
export const accountedUppers = (draft: LineDraft): number => count(draft.cutSize) + count(draft.wastage) + count(draft.lost);

/** Why this line cannot be saved yet, or null when it accounts for every missing upper. */
export const draftProblem = (line: ReconciliationLine, draft: LineDraft): string | null =>
  reconciliationEntryProblem(line.shortfallUppers, toEntry(line.lineId, draft));
