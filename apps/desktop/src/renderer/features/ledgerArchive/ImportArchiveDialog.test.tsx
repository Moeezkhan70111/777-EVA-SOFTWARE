import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Party } from "../../types/desktopApi";
import { ImportArchiveDialog } from "./ImportArchiveDialog";

// Customer Ledger > Import old ledger (docs/50): read, check, match, then import only what is ready, in one go.

const CSV = [
  "party_code,customer_name,transaction_date,voucher_number,transaction_type,bill_number,description,quantity,debit,credit,running_balance,sequence",
  "1301139,Behraam Shoes Karachi,30/09/2026,0,,,Opening Balance,,-,-,\"202,200\",1",
  "1301139,Behraam Shoes Karachi,09/10/2026,11802,SL,14302,4 Dzn HR-1 7/10 EVR Gents@7920 Discount 1440,4,\"30,240\",-,\"232,440\",2",
  "777,Unknown Traders,01/10/2026,0,,,Opening Balance,,-,-,100,1",
].join("\n");

const totals = (rowCount: number) => ({ rowCount, periodFrom: "2026-09-30", periodTo: "2026-10-09", openingBalancePaisa: 20_220_000, closingBalancePaisa: 23_244_000, totalDebitPaisa: 3_024_000, totalCreditPaisa: 0, totalQuantity: 4 });
const behraamMatch = { partyId: "p1", partyName: "Behraam Shoes Karachi", partyCode: "PTY-000123", how: "NAME" };
const statement = (fields: Record<string, unknown>) => ({ partyCode: "", customerName: "", match: null, alreadyStored: null, repeatedRows: 0, totals: totals(2), problems: [], warnings: [], ...fields });

const CUSTOMERS = [
  { id: "p1", partyCode: "PTY-000123", partyName: "Behraam Shoes Karachi", partyType: "CUSTOMER", status: "ACTIVE" },
  { id: "p2", partyCode: "PTY-000124", partyName: "Al Madina Traders", partyType: "CUSTOMER", status: "ACTIVE" },
] as Party[];

function renderDialog(api: Record<string, unknown>) {
  Object.defineProperty(window, "desktop", { value: { versions: { node: "22", chrome: "128", electron: "43" }, api }, configurable: true });
  render(<ImportArchiveDialog customers={CUSTOMERS} onClose={vi.fn()} />);
}

/** jsdom's File has no text() or arrayBuffer(); Chromium's does. */
const csvFile = (csv: string): File =>
  Object.assign(new File([csv], "behraam.csv", { type: "text/csv" }), {
    text: async () => csv,
    arrayBuffer: async () => new TextEncoder().encode(csv).buffer,
  });

const chooseFile = (csv: string = CSV) => fireEvent.change(screen.getByLabelText("Ledger files (.xls, .xlsx or CSV)"), { target: { files: [csvFile(csv)] } });

describe("ImportArchiveDialog", () => {
  it("groups the file by customer, imports only the ready statement, and says what it did", async () => {
    const previewLedgerArchive = vi.fn().mockResolvedValue({
      accepted: true,
      preview: { alreadyImported: null, statements: [statement({ partyCode: "1301139", customerName: "Behraam Shoes Karachi", match: behraamMatch }), statement({ partyCode: "777", customerName: "Unknown Traders", totals: totals(1) })] },
    });
    const importLedgerArchive = vi.fn().mockResolvedValue({ accepted: true, result: { batchId: "b", duplicate: false, statements: [{ id: "s1", rowCount: 2, closingBalancePaisa: 23_244_000 }] } });
    renderDialog({ previewLedgerArchive, importLedgerArchive });
    chooseFile();

    expect(await screen.findByText("✓ Ready")).toBeInTheDocument();
    expect(screen.getByText("⚠ Choose the ERP customer")).toBeInTheDocument();
    const sent = previewLedgerArchive.mock.calls[0]?.[0] as { fileHash: string; statements: Array<{ rows: Array<{ partyCode: string }> }> };
    expect(sent.fileHash).toMatch(/^[0-9a-f]{64}$/);
    expect(sent.statements.map((item) => item.rows.map((row) => row.partyCode))).toEqual([["1301139", "1301139"], ["777"]]);

    fireEvent.click(screen.getByRole("button", { name: "Import 1 statement" }));
    await screen.findByText("✓ Old ledger imported");
    const imported = importLedgerArchive.mock.calls[0]?.[0] as { batchId: string; fileName: string; statements: Array<{ partyId: string; rows: unknown[] }> };
    expect(imported.fileName).toBe("behraam.csv");
    expect(imported.batchId).toMatch(/^[0-9a-f-]{36}$/);
    expect(imported.statements.map((item) => [item.partyId, item.rows.length])).toEqual([["p1", 2]]);
    expect(screen.getByText(/Nothing in the live accounts changed/)).toBeInTheDocument();
  });

  it("checks again with the customer the person chooses", async () => {
    const previewLedgerArchive = vi.fn().mockResolvedValue({ accepted: true, preview: { alreadyImported: null, statements: [statement({ partyCode: "777", customerName: "Unknown Traders" })] } });
    renderDialog({ previewLedgerArchive, importLedgerArchive: vi.fn() });
    chooseFile(CSV.split("\n").filter((line, index) => index === 0 || line.startsWith("777")).join("\n"));
    expect(await screen.findByRole("button", { name: "Import 0 statements" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Show options" }));
    fireEvent.click(screen.getByRole("option", { name: /Al Madina Traders/ }));
    await waitFor(() => expect(previewLedgerArchive).toHaveBeenCalledTimes(2));
    const again = previewLedgerArchive.mock.calls[1]?.[0] as { statements: Array<{ partyId?: string }> };
    expect(again.statements[0]?.partyId).toBe("p2");
  });

  it("refuses a file already imported, and keeps the same batch id for a retry after a failure", async () => {
    const previewLedgerArchive = vi.fn().mockResolvedValue({ accepted: true, preview: { alreadyImported: { fileName: "behraam.csv", importedBy: "accounts" }, statements: [statement({ match: behraamMatch })] } });
    renderDialog({ previewLedgerArchive, importLedgerArchive: vi.fn() });
    chooseFile();
    expect(await screen.findByText(/This file was already imported \(behraam.csv, by accounts\)/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import 0 statements" })).toBeDisabled();
  });

  it("shows the reason when the import is refused, and retries under the same batch", async () => {
    const previewLedgerArchive = vi.fn().mockResolvedValue({ accepted: true, preview: { alreadyImported: null, statements: [statement({ match: behraamMatch })] } });
    const importLedgerArchive = vi.fn().mockResolvedValue({ accepted: false, reason: "This computer does not hold the accounts lease." });
    renderDialog({ previewLedgerArchive, importLedgerArchive });
    chooseFile();
    fireEvent.click(await screen.findByRole("button", { name: "Import 1 statement" }));
    expect(await screen.findByText(/does not hold the accounts lease/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Import 1 statement" }));
    await waitFor(() => expect(importLedgerArchive).toHaveBeenCalledTimes(2));
    const [first, second] = importLedgerArchive.mock.calls.map((call) => (call[0] as { batchId: string }).batchId);
    expect(second).toBe(first);
  });
  // The previous software's Supplier Ledger Report, saved as CSV text (docs/53): read by the report reader, not the template.
  const SUPPLIER_REPORT = [
    ",777 EVA Shoes", ",,,,,Supplier Ledger Report", ",,,Name : 1201903 - SYNTHETIC SUPPLIER FOXTROT", "From,:,01/09/2026", "To,:,20/11/2026",
    "Date,,No.,Type,Bill.No,Description,,,,Qty,Debit,,Credit,,Balance",
    "31/08/2026,,0,,,Opening Balance,,,,0,,0,,,0",
    "12/10/2026,,5101,PU,,Total Qty= 140,,,,140,0,,123000,,,-123000",
    ",,,,,Total :,,,140,0,,123000,,,-123000",
  ].join("\n");
  const SUPPLIERS = [{ id: "s1", partyCode: "PTY-000200", partyName: "SYNTHETIC SUPPLIER FOXTROT", partyType: "SUPPLIER", status: "ACTIVE" }] as Party[];
  const textFile = (content: string, name: string): File =>
    Object.assign(new File([content], name, { type: "text/csv" }), { text: async () => content, arrayBuffer: async () => new TextEncoder().encode(content).buffer });
  const chooseFiles = (...files: File[]) => fireEvent.change(screen.getByLabelText("Ledger files (.xls, .xlsx or CSV)"), { target: { files } });
  const supplierStatement = statement({ side: "SUPPLIER", partyCode: "1201903", customerName: "SYNTHETIC SUPPLIER FOXTROT", match: { partyId: "s1", partyName: "SYNTHETIC SUPPLIER FOXTROT", partyCode: "PTY-000200", how: "NAME" }, totals: totals(2) });

  it("imports several files at once, customers and suppliers mixed, each statement with its own side, file and report", async () => {
    const previewLedgerArchive = vi.fn().mockResolvedValue({
      accepted: true,
      preview: { alreadyImported: null, statements: [statement({ partyCode: "1301139", customerName: "Behraam Shoes Karachi", match: behraamMatch }), statement({ partyCode: "777", customerName: "Unknown Traders", totals: totals(1) }), supplierStatement] },
    });
    const importLedgerArchive = vi.fn().mockResolvedValue({ accepted: true, result: { batchId: "b", duplicate: false, statements: [{ id: "x1", rowCount: 2, closingBalancePaisa: 1 }, { id: "x2", rowCount: 2, closingBalancePaisa: 1 }] } });
    const listParties = vi.fn().mockResolvedValue({ rows: SUPPLIERS, total: 1, page: 1, pageSize: 1000 });
    renderDialog({ previewLedgerArchive, importLedgerArchive, listParties });
    chooseFiles(csvFile(CSV), textFile(SUPPLIER_REPORT, "foxtrot.csv"));

    expect(await screen.findByText(/2 files chosen/)).toBeInTheDocument();
    const sent = previewLedgerArchive.mock.calls[0]?.[0] as { fileHash: string; statements: Array<{ side: string; sourceFile: { name: string }; report: { partyCode: string; printedTotals: { credit: string } } | null }> };
    expect(sent.fileHash).toBe("");
    expect(sent.statements.map((item) => [item.side, item.sourceFile.name, item.report?.partyCode ?? null])).toEqual([
      ["CUSTOMER", "behraam.csv", null], ["CUSTOMER", "behraam.csv", null], ["SUPPLIER", "foxtrot.csv", "1201903"],
    ]);
    expect(sent.statements[2]?.report?.printedTotals.credit).toBe("123000");
    await waitFor(() => expect(listParties).toHaveBeenCalledWith(expect.objectContaining({ partyType: "SUPPLIER" })));
    expect(screen.getByLabelText("Original ledger PDF")).toBeDisabled();

    fireEvent.click(await screen.findByRole("button", { name: "Import 2 statements" }));
    await screen.findByText("✓ Old ledger imported");
    const imported = importLedgerArchive.mock.calls[0]?.[0] as { fileName: string; statements: Array<{ partyId: string; side: string; sourceDocument: unknown }> };
    expect(imported.fileName).toBe("behraam.csv and 1 more");
    expect(imported.statements.map((item) => [item.partyId, item.side, item.sourceDocument])).toEqual([["p1", "CUSTOMER", null], ["s1", "SUPPLIER", null]]);
  });

  it("reads the same file chosen twice once, and says so", async () => {
    const previewLedgerArchive = vi.fn().mockResolvedValue({ accepted: true, preview: { alreadyImported: null, statements: [statement({ match: behraamMatch }), statement({})] } });
    renderDialog({ previewLedgerArchive, importLedgerArchive: vi.fn() });
    chooseFiles(csvFile(CSV), textFile(CSV, "copy-of-behraam.csv"));
    expect(await screen.findByText(/copy-of-behraam.csv is the same file as one already chosen/)).toBeInTheDocument();
    expect((previewLedgerArchive.mock.calls[0]?.[0] as { statements: unknown[] }).statements).toHaveLength(2);
  });

  it("a report the reader could not account for is never imported, whatever the preview says", async () => {
    const noTotal = SUPPLIER_REPORT.split("\n").slice(0, -1).join("\n");
    const previewLedgerArchive = vi.fn().mockResolvedValue({ accepted: true, preview: { alreadyImported: null, statements: [supplierStatement] } });
    renderDialog({ previewLedgerArchive, importLedgerArchive: vi.fn(), listParties: vi.fn().mockResolvedValue({ rows: SUPPLIERS, total: 1, page: 1, pageSize: 1000 }) });
    chooseFiles(textFile(noTotal, "foxtrot.csv"));
    expect(await screen.findByText(/✕ 2 problems/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import 0 statements" })).toBeDisabled();
  });

  it("a statement already imported from its file, among others, blocks only itself", async () => {
    const previewLedgerArchive = vi.fn().mockResolvedValue({
      accepted: true,
      preview: { alreadyImported: null, statements: [statement({ match: behraamMatch, fileAlreadyImported: { fileName: "behraam.csv", importedBy: "accounts" } }), statement({}), supplierStatement] },
    });
    renderDialog({ previewLedgerArchive, importLedgerArchive: vi.fn(), listParties: vi.fn().mockResolvedValue({ rows: SUPPLIERS, total: 1, page: 1, pageSize: 1000 }) });
    chooseFiles(csvFile(CSV), textFile(SUPPLIER_REPORT, "foxtrot.csv"));
    expect(await screen.findByText(/✕ Already imported from this file \(behraam.csv, by accounts\)/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import 1 statement" })).toBeEnabled();
  });
});
