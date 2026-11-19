import { describe, expect, it } from "vitest";
import { readArchiveView, readImportOutcome, readImportPreview, readSourceDocument } from "./archiveReplies";

// The main process's answers, checked before the screen trusts them (R25).

const entry = { id: "e1", statementId: "s1", sequence: 1, entryDate: "2026-09-30", originalDateText: "30/09/2026", voucherNumber: "0", transactionType: "", billNumber: "", description: "Opening Balance", quantityText: "", quantity: null, debitPaisa: 0, creditPaisa: 0, balancePaisa: 20_220_000 };
const statement = { id: "s1", batchId: "b1", originalPartyCode: "1301139", originalPartyName: "Behraam Shoes Karachi", periodFrom: "2026-09-30", periodTo: "2026-11-13", rowCount: 45, closingBalancePaisa: 35_388_000, sourceFileName: "b.csv", sourceDocumentName: null, sourceDocumentHash: null, importedBy: "accounts", importedAt: "2026-11-16T10:00:00Z" };

describe("readArchiveView", () => {
  it("reads a well-formed view", () => {
    const reply = readArchiveView({ accepted: true, view: { statements: [statement], entries: [entry] } });
    expect(reply.ok && reply.value.entries[0]?.balancePaisa).toBe(20_220_000);
  });

  it("refuses an amount that is not whole paisa, a malformed date, or a refusal, never half-reading", () => {
    expect(readArchiveView({ accepted: true, view: { statements: [], entries: [{ ...entry, debitPaisa: 1.5 }] } }).ok).toBe(false);
    expect(readArchiveView({ accepted: true, view: { statements: [], entries: [{ ...entry, entryDate: "30/09/2026" }] } }).ok).toBe(false);
    expect(readArchiveView({ accepted: true, view: { statements: [{ ...statement, rowCount: "45" }], entries: [] } }).ok).toBe(false);
    expect(readArchiveView({ accepted: false, reason: "No access" })).toEqual({ ok: false, reason: "No access" });
    expect(readArchiveView(null)).toEqual({ ok: false, reason: null });
  });
});

describe("readImportPreview", () => {
  const totals = { rowCount: 45, periodFrom: "2026-09-30", periodTo: "2026-11-13", openingBalancePaisa: 20_220_000, closingBalancePaisa: 35_388_000, totalDebitPaisa: 45_216_000, totalCreditPaisa: 30_048_000, totalQuantity: 79 };
  it("reads a statement's match, and drops a match of an unknown kind", () => {
    const reply = readImportPreview({ accepted: true, preview: { alreadyImported: null, statements: [
      { partyCode: "1301139", customerName: "B", match: { partyId: "p1", partyName: "B", partyCode: "PTY-1", how: "NAME" }, alreadyStored: null, repeatedRows: 0, totals, problems: [], warnings: [] },
      { partyCode: "2", customerName: "C", match: { partyId: "p2", how: "GUESS" }, alreadyStored: null, repeatedRows: 0, totals, problems: ["x"], warnings: [] },
    ] } });
    expect(reply.ok && reply.value.statements.map((item) => item.match?.how ?? null)).toEqual(["NAME", null]);
  });
});

describe("readImportOutcome and readSourceDocument", () => {
  it("counts what was written, and refuses a source without a real hash", () => {
    expect(readImportOutcome({ accepted: true, result: { batchId: "b1", duplicate: false, statements: [statement] } })).toEqual({ ok: true, value: { duplicate: false, statements: 1, rows: 45 } });
    expect(readSourceDocument({ accepted: true, source: { name: "a.pdf", hash: "abc", bytes: 10 } }).ok).toBe(false);
    expect(readSourceDocument({ accepted: true, source: { name: "a.pdf", hash: "a".repeat(64), bytes: 10 } }).ok).toBe(true);
  });
});
