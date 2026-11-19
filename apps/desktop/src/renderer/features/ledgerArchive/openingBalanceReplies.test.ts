import { describe, expect, it } from "vitest";
import { readOpeningBalanceView, readReconciliation } from "./openingBalanceReplies";
import { formProblems } from "./useOpeningBalanceForm";

// The main process's answers about opening balances are read, never trusted (R25, docs/53); and the form says what
// is missing before anything is sent.

const VIEW = {
  partyId: "c1", side: "CUSTOMER", status: "POSTED", version: 1, firstLiveDate: null,
  current: { direction: "DEBIT", amountPaisa: 35_388_000, effectiveDate: "2026-11-14", sourceReference: "Old ledger", archiveStatementId: null },
  history: [{ id: "h1", version: 1, action: "POST", direction: "DEBIT", amountPaisa: 35_388_000, effectiveDate: "2026-11-14", sourceReference: "Old ledger", note: null, reason: null, recordedBy: "owner", recordedAt: "2026-11-19T10:00:00Z" }],
};

describe("opening balance replies", () => {
  it("reads a posted position and its history", () => {
    const reply = readOpeningBalanceView({ accepted: true, view: VIEW });
    expect(reply.ok && reply.value.current?.amountPaisa).toBe(35_388_000);
    expect(reply.ok && reply.value.history).toHaveLength(1);
  });

  it("refuses a figure that is not whole paisa, a direction that is not one, or a side that is not one", () => {
    expect(readOpeningBalanceView({ accepted: true, view: { ...VIEW, current: { ...VIEW.current, amountPaisa: 12.5 } } }).ok).toBe(false);
    expect(readOpeningBalanceView({ accepted: true, view: { ...VIEW, current: { ...VIEW.current, direction: "UP" } } }).ok).toBe(false);
    expect(readOpeningBalanceView({ accepted: true, view: { ...VIEW, side: "CONTRACTOR" } }).ok).toBe(false);
    expect(readOpeningBalanceView({ accepted: true, view: { ...VIEW, history: [{ ...VIEW.history[0], action: "EDIT" }] } }).ok).toBe(false);
  });

  it("passes a refusal's reason through", () => {
    expect(readOpeningBalanceView({ accepted: false, reason: "Only an administrator…" })).toEqual({ ok: false, reason: "Only an administrator…" });
  });

  it("reads a reconciliation row, and refuses one with a status it does not know", () => {
    const row = { partyId: "c1", partyName: "B", partyCode: "", originalPartyCode: "1301139", status: "MATCHED", statementCount: 1, archiveOpeningPaisa: 1, archiveDebitPaisa: 0, archiveCreditPaisa: 0, archiveClosingPaisa: 1, archiveTo: null, openingPaisa: 1, openingEffectiveDate: null, differencePaisa: 0, liveBalancePaisa: null, notes: [] };
    expect(readReconciliation({ accepted: true, report: { rows: [row] } }).ok).toBe(true);
    expect(readReconciliation({ accepted: true, report: { rows: [{ ...row, status: "FINE" }] } }).ok).toBe(false);
    expect(readReconciliation({ accepted: true, report: { rows: [{ ...row, differencePaisa: "0" }] } }).ok).toBe(false);
  });
});

describe("the opening balance form's own checks", () => {
  const fields = { direction: "DEBIT" as const, amountText: "353,880", effectiveDate: "2026-11-14", sourceReference: "Old ledger 1301139", archiveStatementId: "", note: "", reason: "" };

  it("accepts a complete posting, and asks a correction or reversal for its reason", () => {
    expect(formProblems("post", fields)).toEqual([]);
    expect(formProblems("correct", fields)).toEqual(["Say why the opening balance is being reversed."]);
    expect(formProblems("reverse", { ...fields, reason: "Posted twice" })).toEqual([]);
  });

  it("says when the amount is not a number", () => {
    expect(formProblems("post", { ...fields, amountText: "three lakh" })[0]).toMatch(/Enter the amount as a number/);
  });
});
