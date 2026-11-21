import { describe, expect, it } from "vitest";
import { readBulkPostOutcome, readBulkPreview } from "./bulkOpeningReplies";
import { readArchiveBatch, readWithdrawOutcome } from "./archiveReplies";

// The main process's answers about moving the old ledgers in, checked (R25, docs/53): a figure that cannot be posted
// as read fails the whole answer.

const ready = { partyId: "p1", partyName: "A", partyCode: "", originalPartyCode: "1301901", status: "READY", skipReason: null, direction: "DEBIT", amountPaisa: 100, archiveStatementId: "s1", balanceAsOf: "2026-11-19", linesOnOrAfterCutover: 0, warnings: [] };
const preview = (proposals: unknown[]) => ({ accepted: true, preview: { side: "CUSTOMER", cutoverDate: "2026-11-21", proposals } });
const statement = { id: "s1", batchId: "b", rowCount: 2, closingBalancePaisa: 5, withdrawnAt: "2026-11-20T08:00:00.000Z", withdrawnBy: "owner", withdrawalReason: "x" };

describe("bulk opening balance replies", () => {
  it("reads a READY party with its figures and a left-out one with its reason", () => {
    const reply = readBulkPreview(preview([ready, { ...ready, partyId: "p2", status: "SKIP", skipReason: "zero", direction: null, amountPaisa: null, archiveStatementId: null }]));
    expect(reply.ok && reply.value.proposals.map((p) => [p.status, p.amountPaisa, p.skipReason])).toEqual([["READY", 100, null], ["SKIP", null, "zero"]]);
  });

  it("fails the whole answer for a READY party it could not post: fractional, negative, no direction or no statement", () => {
    for (const bad of [{ amountPaisa: 1.5 }, { amountPaisa: -1 }, { direction: "UP" }, { archiveStatementId: null }]) {
      expect(readBulkPreview(preview([{ ...ready, ...bad }])).ok).toBe(false);
    }
    expect(readBulkPreview({ accepted: true, preview: { side: "CUSTOMER", cutoverDate: "", proposals: [] } }).ok).toBe(false);
    expect(readBulkPreview({ accepted: false, reason: "Only an administrator" })).toEqual({ ok: false, reason: "Only an administrator" });
  });

  it("reads a posting's outcome", () => {
    expect(readBulkPostOutcome({ accepted: true, result: { duplicate: true, posted: 3 } })).toEqual({ ok: true, value: { duplicate: true, posted: 3 } });
    expect(readBulkPostOutcome({ accepted: true, result: { posted: "3" } }).ok).toBe(false);
  });
});

describe("withdrawal replies", () => {
  it("a withdrawal is read only when every statement it names is withdrawn", () => {
    expect(readWithdrawOutcome({ accepted: true, result: { duplicate: false, statements: [statement] } })).toEqual({ ok: true, value: { duplicate: false, statements: 1 } });
    expect(readWithdrawOutcome({ accepted: true, result: { statements: [{ ...statement, withdrawnAt: null }] } }).ok).toBe(false);
  });

  it("an import's statements are read with their withdrawal", () => {
    const reply = readArchiveBatch({ accepted: true, statements: [statement] });
    expect(reply.ok && reply.value[0]?.withdrawnBy).toBe("owner");
    expect(readArchiveBatch({ accepted: true, statements: [{ id: "s1" }] }).ok).toBe(false);
  });
});
