import { describe, expect, it } from "vitest";
import { toCsv } from "../../utils/exportFile";
import { ledgerReportHtml, ledgerSheet, type LedgerReportInput } from "./ledgerReport";
import type { LedgerExportRow } from "./unifiedLedger";

// The Customer Ledger as a PDF page and as a spreadsheet (docs/50): both sources, the archived ones marked, totals
// kept apart, everything from the data escaped.

const row = (archived: boolean, fields: Partial<LedgerExportRow> = {}): LedgerExportRow => ({
  archived, date: "2026-10-09", voucherNumber: "11802", type: archived ? "Sale" : "Sale Voucher", billNumber: archived ? "14302" : "",
  description: "4 Dzn HR-1 7/10 EVR Gents@7920 Discount 1440", quantity: 4, debit: 30_240, credit: 0, balance: 232_440, ...fields,
});

const input = (rows: LedgerExportRow[]): LedgerReportInput => ({
  customerName: "Behraam Shoes Karachi", customerCode: "PTY-000123", fromDate: "2026-10-01", toDate: "2026-11-30",
  liveOpening: 0, liveClosing: 4_920, rows, logoDataUrl: "", printedAt: new Date("2026-11-16T10:00:00Z"),
});

describe("ledgerReportHtml", () => {
  it("prints both sources in one table, marks every archived row, and keeps their totals on separate lines", () => {
    const html = ledgerReportHtml(input([row(true), row(true, { voucherNumber: "3181", type: "Cash Voucher", debit: 0, credit: 300_000, balance: 480 }), row(false, { voucherNumber: "SV-100001", balance: 4_920, debit: 4_920 })]));
    expect(html.match(/<tr class="archived">/g)).toHaveLength(2);
    expect(html.match(/<tr class="live">/g)).toHaveLength(1);
    expect(html.match(/>ARCHIVED</g)).toHaveLength(2);
    expect(html).toContain("<thead>");
    expect(html).toContain("break-inside: avoid");
    expect(html).toContain("Live total (1 entries)");
    expect(html).toContain("Archived total (2 rows)");
    expect(html).toContain("232,440");
    expect(html).toContain("Behraam Shoes Karachi");
    expect(html).toContain("PTY-000123");
    expect(html).toContain("Rows marked ARCHIVED are from the previous software");
  });

  it("escapes every text from the data", () => {
    const html = ledgerReportHtml(input([row(true, { description: "<img src=x onerror=alert(1)>" })]));
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("says when there is nothing in the period", () => {
    expect(ledgerReportHtml(input([]))).toContain("No transactions in this period.");
  });
});

describe("ledgerSheet", () => {
  it("names each row's source, keeps amounts as numbers and dates as YYYY-MM-DD", () => {
    const sheet = ledgerSheet({ ...input([row(true), row(false, { quantity: null })]), printedAt: new Date("2026-11-16T10:00:00Z") });
    expect(sheet.headers).toEqual(["Source", "Date", "Voucher No.", "Type", "Bill No.", "Description", "Qty", "Debit (Rs.)", "Credit (Rs.)", "Balance (Rs.)"]);
    expect(sheet.rows[0]).toEqual(["Archived", "2026-10-09", "11802", "Sale", "14302", "4 Dzn HR-1 7/10 EVR Gents@7920 Discount 1440", 4, 30_240, 0, 232_440]);
    expect(sheet.rows[1]?.[0]).toBe("Live");
    expect(sheet.preamble?.[0]).toBe("Customer Ledger — Behraam Shoes Karachi (PTY-000123)");
    expect(toCsv(sheet)).toContain('"Archived","2026-10-09","11802"');
  });
});
