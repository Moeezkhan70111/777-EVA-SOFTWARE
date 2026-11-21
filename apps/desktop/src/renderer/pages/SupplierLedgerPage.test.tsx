import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PERMISSION } from "@erp/domain";
import { SessionProvider } from "../features/auth/SessionContext";
import type { AuthUser } from "../types/desktopApi";
import type { CsvSheet } from "../utils/exportFile";
import { SupplierLedgerPage } from "./SupplierLedgerPage";

// THE SUPPLIER LEDGER WITH ITS HISTORY (docs/53): the old software's archived rows beside the live entries, marked
// and kept out of the live balance; the opening balance labelled and in it; downloads carrying both; and the
// reconciliation saying each party's status in words.

const downloads = vi.hoisted(() => ({ sheets: [] as CsvSheet[] }));
vi.mock("../utils/exportFile", async (original) => ({
  ...(await original<typeof import("../utils/exportFile")>()),
  downloadCsv: (_name: string, sheet: CsvSheet) => downloads.sheets.push(sheet),
}));

const RUBBER = { id: "s1", partyCode: "PTY-000200", partyName: "Test Supplier Rubber Soles", partyType: "SUPPLIER", status: "ACTIVE" };

const entry = (sequence: number, entryDate: string, voucherNumber: string, transactionType: string, description: string, debitPaisa: number, creditPaisa: number, balancePaisa: number) => ({
  id: `a${String(sequence)}`, statementId: "st1", sequence, entryDate, originalDateText: entryDate, voucherNumber, transactionType, billNumber: transactionType === "PV" ? "778" : "",
  description, quantityText: "", quantity: null, debitPaisa, creditPaisa, balancePaisa,
});

const ARCHIVE = {
  accepted: true,
  view: {
    statements: [{ id: "st1", batchId: "b1", ledgerSide: "SUPPLIER", balanceRule: "CREDIT_LESS_DEBIT", originalPartyCode: "2200417", originalPartyName: "Test Supplier Rubber Soles", periodFrom: "2026-09-30", periodTo: "2026-11-03", rowCount: 2, closingBalancePaisa: 24_000_000, sourceFileName: "test-suppliers.csv", sourceDocumentName: null, sourceDocumentHash: null, importedBy: "accounts", importedAt: "2026-11-19T10:00:00Z" }],
    entries: [entry(1, "2026-09-30", "0", "", "Opening Balance", 0, 0, 15_000_000), entry(2, "2026-10-05", "5011", "PV", "Rubber sheet 200 kg @450", 0, 9_000_000, 24_000_000)],
  },
};

const LIVE = {
  partyId: "s1", partyName: "Test Supplier Rubber Soles", openingBalance: 0, closingBalance: 100_000,
  entries: [
    { voucherId: "ob1", voucherNumber: "OB", voucherDate: "2026-11-14", voucherType: "OPENING_BALANCE", description: "Old ledger 2200417", debitAmount: 0, creditAmount: 137_500, balance: 137_500 },
    { voucherId: "cv1", voucherNumber: "PV-00001", voucherDate: "2026-11-16", voucherType: "CASH_PAYMENT", description: "Paid", debitAmount: 37_500, creditAmount: 0, balance: 100_000 },
  ],
};

const OPENING = { accepted: true, view: { partyId: "s1", side: "SUPPLIER", status: "POSTED", version: 1, current: { direction: "CREDIT", amountPaisa: 13_750_000, effectiveDate: "2026-11-14", sourceReference: "Old ledger 2200417", archiveStatementId: null }, history: [], firstLiveDate: "2026-11-16" } };

const REPORT = {
  accepted: true,
  report: {
    side: "SUPPLIER",
    rows: [{ partyId: "s1", partyName: "Test Supplier Rubber Soles", partyCode: "PTY-000200", originalPartyCode: "2200417", status: "DIFFERENT", statementCount: 1, archiveOpeningPaisa: 15_000_000, archiveDebitPaisa: 0, archiveCreditPaisa: 9_000_000, archiveClosingPaisa: 24_000_000, archiveTo: "2026-11-03", openingPaisa: 13_750_000, openingEffectiveDate: "2026-11-14", differencePaisa: -10_250_000, liveBalancePaisa: 10_000_000, notes: [] }],
  },
};

const user = (permissions: string[]): AuthUser => ({ id: "u1", username: "accounts", role: "USER", accessStatus: "APPROVED", permissions, lastLoginAt: null });

function renderPage(permissions: string[] = [PERMISSION.SUPPLIER_LEDGER]) {
  const api = {
    listParties: vi.fn().mockResolvedValue({ rows: [RUBBER], total: 1 }),
    getSupplierLedger: vi.fn().mockResolvedValue(LIVE),
    getLedgerArchive: vi.fn().mockResolvedValue(ARCHIVE),
    getPartyOpeningBalance: vi.fn().mockResolvedValue(OPENING),
    getLedgerReconciliation: vi.fn().mockResolvedValue(REPORT),
    savePdfDocument: vi.fn().mockResolvedValue({ accepted: false, canceled: true }),
  };
  Object.defineProperty(window, "desktop", { value: { versions: { node: "22", chrome: "128", electron: "43" }, api }, configurable: true });
  const view = render(
    <SessionProvider user={user(permissions)} token="t">
      <SupplierLedgerPage onNavigate={vi.fn()} />
    </SessionProvider>
  );
  return { api, view };
}

async function chooseRubber() {
  const select = await screen.findByRole("combobox", { name: "Select supplier" });
  await waitFor(() => expect(within(select).queryByRole("option", { name: RUBBER.partyName })).not.toBeNull());
  fireEvent.change(select, { target: { value: "s1" } });
  await screen.findByText("PV-00001");
  await screen.findByText(/Rubber sheet 200 kg/);
}

const bodyRows = (view: ReturnType<typeof render>) => Array.from(view.container.querySelectorAll(".customer-ledger-table tbody tr"));

describe("SupplierLedgerPage with an archived ledger and an opening balance", () => {
  beforeEach(() => {
    downloads.sheets.length = 0;
  });

  it("shows archived and live rows in one table by date, archived ones marked, the live balance untouched by them", async () => {
    const { view } = renderPage();
    await chooseRubber();
    const rows = bodyRows(view);
    expect(rows.map((row) => row.querySelectorAll("td")[1]?.textContent)).toEqual(["0", "5011", "OB", "PV-00001"]);
    for (const row of rows.slice(0, 2)) expect(within(row as HTMLElement).getByText("Archived")).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText("Opening balance")).toBeInTheDocument();
    expect((view.container.querySelector(".customer-ledger-highlight") as HTMLElement).textContent).toContain("Rs. 100,000");
    const totals = Array.from(view.container.querySelectorAll("tfoot tr")).map((row) => row.textContent ?? "");
    expect(totals[0]).toContain("Live total (2 entries)");
    expect(totals[1]).toContain("Archived total (2 rows)");
    expect((await screen.findByRole("region", { name: "Opening balance" })).textContent).toContain("Payable");
  });

  it("filters to the archived rows and searches them", async () => {
    const { view } = renderPage();
    await chooseRubber();
    fireEvent.change(screen.getByRole("combobox", { name: "Filter transactions" }), { target: { value: "ARCHIVED" } });
    expect(bodyRows(view).every((row) => row.classList.contains("ledger-archived-row"))).toBe(true);
    fireEvent.change(screen.getByRole("combobox", { name: "Filter transactions" }), { target: { value: "ALL" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Search transactions" }), { target: { value: "778" } });
    expect(bodyRows(view).map((row) => row.querySelectorAll("td")[1]?.textContent)).toEqual(["5011"]);
  });

  it("downloads a Supplier Ledger with both sources, and a PDF titled for suppliers", async () => {
    const { api } = renderPage();
    await chooseRubber();
    fireEvent.click(screen.getByRole("button", { name: /Download Excel/ }));
    const sheet = downloads.sheets[0];
    expect(sheet?.preamble?.[0]).toContain("Supplier Ledger");
    expect(sheet?.rows.map((row) => row[0])).toEqual(["Archived", "Archived", "Live", "Live"]);
    fireEvent.click(screen.getByRole("button", { name: /Download PDF/ }));
    await waitFor(() => expect(api.savePdfDocument).toHaveBeenCalled());
    expect((api.savePdfDocument.mock.calls[0]?.[0] as { html: string }).html).toContain("Supplier Ledger");
  });

  it("offers the import to accounts users only, worded for suppliers", async () => {
    renderPage();
    expect(screen.queryByRole("button", { name: "Import old ledger" })).toBeNull();
    renderPage([PERMISSION.SUPPLIER_LEDGER, PERMISSION.CASH_VOUCHER_FORM]);
    fireEvent.click(await screen.findByRole("button", { name: "Import old ledger" }));
    expect(await screen.findByText(/Customer reports may be chosen with them/)).toBeInTheDocument();
  });

  it("the reconciliation says each supplier's status in words, with the difference", async () => {
    const { api } = renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Reconciliation" }));
    expect(await screen.findByText("⚠ Different")).toBeInTheDocument();
    expect(api.getLedgerReconciliation).toHaveBeenCalledWith("SUPPLIER");
    expect(screen.getByText("-102,500")).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /Download Excel/ }));
    expect(downloads.sheets[0]?.rows[0]).toEqual(expect.arrayContaining(["Test Supplier Rubber Soles", "2200417", 240_000, 137_500, -102_500, "⚠ Different"]));
  });

  it("says when the ledger could not be loaded, and retries", async () => {
    const { api } = renderPage();
    api.getSupplierLedger.mockRejectedValueOnce(new Error("busy"));
    const select = await screen.findByRole("combobox", { name: "Select supplier" });
    await waitFor(() => expect(within(select).queryByRole("option", { name: RUBBER.partyName })).not.toBeNull());
    fireEvent.change(select, { target: { value: "s1" } });
    expect(await screen.findByText(/The ledger could not be loaded./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));
    expect(await screen.findByText("PV-00001")).toBeInTheDocument();
  });
});
