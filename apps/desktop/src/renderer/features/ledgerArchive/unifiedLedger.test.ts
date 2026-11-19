import { describe, expect, it } from "vitest";
import type { ArchiveEntry } from "./archiveReplies";
import { archivedMatches, ledgerExportRows, mergeLedgerTimeline, summarizeArchive, type LiveLedgerEntry } from "./unifiedLedger";

// The one Customer Ledger (docs/50): live entries and archived rows in one chronological list, the archive's figures
// kept apart from the live ones.

const archived = (sequence: number, entryDate: string, fields: Partial<ArchiveEntry> = {}): ArchiveEntry => ({
  id: `a${String(sequence)}`, statementId: "s1", sequence, entryDate, originalDateText: entryDate, voucherNumber: String(1000 + sequence),
  transactionType: "SL", billNumber: "14302", description: `row ${String(sequence)}`, quantityText: "2", quantity: 2,
  debitPaisa: 100_000, creditPaisa: 0, balancePaisa: 100_000 * sequence, ...fields,
});

const live = (id: string, voucherDate: string, fields: Partial<LiveLedgerEntry> = {}): LiveLedgerEntry => ({
  voucherId: id, voucherNumber: `SV-${id}`, voucherDate, voucherType: "SALE", description: "", debitAmount: 500, creditAmount: 0, balance: 500, ...fields,
});

describe("mergeLedgerTimeline", () => {
  it("puts both in date order; on the same day the archived rows come first, each side in its own order", () => {
    const timeline = mergeLedgerTimeline(
      [live("L1", "2026-10-09"), live("L2", "2026-11-20")],
      [archived(1, "2026-09-30"), archived(2, "2026-10-09"), archived(3, "2026-10-09"), archived(4, "2026-11-13")]
    );
    expect(timeline.map((item) => (item.kind === "live" ? item.entry.voucherId : item.entry.id))).toEqual(["a1", "a2", "a3", "L1", "a4", "L2"]);
  });

  it("keeps a live entry's own running balance and an archived row's printed one: neither is added to the other", () => {
    const timeline = mergeLedgerTimeline([live("L1", "2026-11-20", { balance: -50_000 })], [archived(45, "2026-11-13", { balancePaisa: 35_388_000 })]);
    const rows = ledgerExportRows(timeline, (type) => type);
    expect(rows.map((row) => [row.archived, row.balance])).toEqual([[true, 353_880], [false, -50_000]]);
  });

  it("is only one side when the other is empty", () => {
    expect(mergeLedgerTimeline([], [archived(1, "2026-10-01")])).toHaveLength(1);
    expect(mergeLedgerTimeline([live("L1", "2026-10-01")], [])).toHaveLength(1);
    expect(mergeLedgerTimeline([], [])).toEqual([]);
  });
});

describe("archivedMatches", () => {
  it("finds a row by any printed word or number, and by its type in words", () => {
    const row = archived(5, "2026-10-17", { voucherNumber: "3181", transactionType: "CV", billNumber: "", description: "received khawaja talal hassan\nmeezan" });
    for (const query of ["3181", "meezan", "KHAWAJA", "cash voucher", "17/10"]) expect(archivedMatches({ ...row, originalDateText: "17/10/2026" }, query)).toBe(true);
    expect(archivedMatches(row, "14509")).toBe(false);
    expect(archivedMatches(row, "  ")).toBe(true);
  });
});

describe("summarizeArchive", () => {
  it("adds up the rows in view and reports the LAST printed balance, never one worked out", () => {
    const summary = summarizeArchive([archived(1, "2026-10-01", { quantity: 0.5 }), archived(2, "2026-10-02", { quantity: 1.25, creditPaisa: 0 }), archived(3, "2026-10-03", { debitPaisa: 0, creditPaisa: 48_000, quantity: null, balancePaisa: 7 })]);
    expect(summary).toEqual({ rows: 3, debitPaisa: 200_000, creditPaisa: 48_000, quantity: 1.75, lastBalancePaisa: 7, lastDate: "2026-10-03" });
    expect(summarizeArchive([])).toEqual({ rows: 0, debitPaisa: 0, creditPaisa: 0, quantity: 0, lastBalancePaisa: null, lastDate: null });
  });
});

describe("ledgerExportRows", () => {
  it("writes an archived row as printed, in rupees, and a live sale's lines as its description", () => {
    const sale = live("L1", "2026-11-20", { lineItems: [{ article: "SK6", groupName: "EVR Gents", size: "7/10", quantity: 2, unitPrice: 530, totalPrice: 12_000 }, { article: "SK6", groupName: null, size: "4/6", quantity: 1.5, unitPrice: 460, totalPrice: 8_000 }] });
    const rows = ledgerExportRows(mergeLedgerTimeline([sale], [archived(2, "2026-10-09", { description: "4 Dzn HR-1 7/10 EVR Gents@7920 Discount 1440", debitPaisa: 3_024_000 })]), () => "Sale Voucher");
    expect(rows[0]).toEqual({ archived: true, date: "2026-10-09", voucherNumber: "1002", type: "Sale", billNumber: "14302", description: "4 Dzn HR-1 7/10 EVR Gents@7920 Discount 1440", quantity: 2, debit: 30_240, credit: 0, balance: 2_000 });
    expect(rows[1]).toMatchObject({ archived: false, type: "Sale Voucher", quantity: 3.5, description: "SK6 | EVR Gents | 7/10 | 2 x 530\nSK6 | 4/6 | 1.5 x 460" });
  });
});
