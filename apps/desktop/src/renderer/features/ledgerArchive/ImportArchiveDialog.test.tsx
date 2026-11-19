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

const chooseFile = (csv: string = CSV) => fireEvent.change(screen.getByLabelText("Ledger CSV file"), { target: { files: [csvFile(csv)] } });

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
});
