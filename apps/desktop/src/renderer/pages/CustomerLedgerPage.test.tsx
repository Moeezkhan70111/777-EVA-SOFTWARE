import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PERMISSION } from "@erp/domain";
import { SessionProvider } from "../features/auth/SessionContext";
import type { AuthUser } from "../types/desktopApi";
import type { CsvSheet } from "../utils/exportFile";
import { CustomerLedgerPage } from "./CustomerLedgerPage";

// THE ONE CUSTOMER LEDGER (docs/50): a customer's old-software rows and live ERP entries in one table, the archived
// ones marked, the live balance untouched by them, and both in every download.

const downloads = vi.hoisted(() => ({ sheets: [] as CsvSheet[] }));
vi.mock("../utils/exportFile", async (original) => ({
  ...(await original<typeof import("../utils/exportFile")>()),
  downloadCsv: (_name: string, sheet: CsvSheet) => downloads.sheets.push(sheet),
}));

const BEHRAAM = { id: "p1", partyCode: "PTY-000123", partyName: "Behraam Shoes Karachi", partyType: "CUSTOMER", status: "ACTIVE", city: "Karachi" };

const archivedEntry = (sequence: number, entryDate: string, voucherNumber: string, transactionType: string, description: string, debitPaisa: number, creditPaisa: number, balancePaisa: number) => ({
  id: `a${String(sequence)}`, statementId: "s1", sequence, entryDate, originalDateText: entryDate, voucherNumber, transactionType, billNumber: transactionType === "SL" ? "14302" : "",
  description, quantityText: transactionType === "SL" ? "4" : "0", quantity: transactionType === "SL" ? 4 : 0, debitPaisa, creditPaisa, balancePaisa,
});

const ARCHIVE = {
  accepted: true,
  view: {
    statements: [{ id: "s1", batchId: "b1", originalPartyCode: "1301139", originalPartyName: "Behraam Shoes Karachi", periodFrom: "2026-09-30", periodTo: "2026-11-13", rowCount: 3, closingBalancePaisa: 48_000, sourceFileName: "behraam.csv", sourceDocumentName: "behram shoes.pdf", sourceDocumentHash: "a".repeat(64), importedBy: "accounts", importedAt: "2026-11-16T10:00:00Z" }],
    entries: [
      archivedEntry(1, "2026-09-30", "0", "", "Opening Balance", 0, 0, 20_220_000),
      archivedEntry(2, "2026-10-09", "11802", "SL", "4 Dzn HR-1 7/10 EVR Gents@7920 Discount 1440", 3_024_000, 0, 23_244_000),
      archivedEntry(5, "2026-10-17", "3181", "CV", "received khawaja talal hassan\nmeezan", 0, 23_196_000, 48_000),
    ],
  },
};

const LIVE = {
  partyId: "p1", partyName: "Behraam Shoes Karachi", balanceLimit: null, openingBalance: 0, closingBalance: -50_000,
  entries: [{ voucherId: "cv1", voucherNumber: "RV-00001", voucherDate: "2026-10-12", voucherType: "CASH_RECEIPT", description: "Received on account", modeOfTransfer: "Cash", debitAmount: 0, creditAmount: 50_000, balance: -50_000 }],
};

const user = (permissions: string[], role: "USER" | "ADMIN" = "USER"): AuthUser => ({ id: "u1", username: "accounts", role, accessStatus: "APPROVED", permissions, lastLoginAt: null });

/** No opening balance posted yet (docs/53). */
const NO_OPENING = { accepted: true, view: { partyId: "p1", partyName: "Behraam Shoes Karachi", side: "CUSTOMER", status: "NONE", current: null, version: 0, history: [], firstLiveDate: "2026-10-12" } };
const POSTED_OPENING = {
  accepted: true,
  view: {
    ...NO_OPENING.view, status: "POSTED", version: 1,
    current: { direction: "DEBIT", amountPaisa: 35_388_000, effectiveDate: "2026-11-14", sourceReference: "Old ledger 1301139", archiveStatementId: null },
    history: [{ id: "h1", version: 1, action: "POST", direction: "DEBIT", amountPaisa: 35_388_000, effectiveDate: "2026-11-14", sourceReference: "Old ledger 1301139", note: null, reason: null, recordedBy: "owner", recordedAt: "2026-11-19T10:00:00Z" }],
  },
};

function renderPage(permissions: string[] = [PERMISSION.CUSTOMER_LEDGER], role: "USER" | "ADMIN" = "USER") {
  const api = {
    listParties: vi.fn().mockResolvedValue({ rows: [BEHRAAM], total: 1 }),
    getCustomerLedgerWithCash: vi.fn().mockResolvedValue(LIVE),
    getLedgerArchive: vi.fn().mockResolvedValue(ARCHIVE),
    getPartyOpeningBalance: vi.fn().mockResolvedValue(NO_OPENING),
    postPartyOpeningBalance: vi.fn().mockResolvedValue(POSTED_OPENING),
    getCashVoucher: vi.fn().mockResolvedValue(null),
    savePdfDocument: vi.fn().mockResolvedValue({ accepted: false, canceled: true }),
  };
  Object.defineProperty(window, "desktop", { value: { versions: { node: "22", chrome: "128", electron: "43" }, api }, configurable: true });
  const view = render(
    <SessionProvider user={user(permissions, role)} token="t">
      <CustomerLedgerPage onNavigate={vi.fn()} />
    </SessionProvider>
  );
  return { api, view };
}

async function chooseBehraam(view: ReturnType<typeof render>) {
  await waitFor(() => expect(view.container.querySelector(".cl-customer-select-box")).not.toBeNull());
  fireEvent.click(view.container.querySelector(".cl-customer-select-box") as Element);
  fireEvent.click(await screen.findByRole("option", { name: /Behraam Shoes Karachi/ }));
  await screen.findByText("RV-00001");
  await screen.findByText(/4 Dzn HR-1/);
}

const bodyRows = (view: ReturnType<typeof render>) => Array.from(view.container.querySelectorAll(".customer-ledger-table tbody tr"));

describe("CustomerLedgerPage with an archived ledger", () => {
  beforeEach(() => {
    downloads.sheets.length = 0;
  });

  it("shows archived and live entries in ONE table, by date, the archived ones marked in words", async () => {
    const { view } = renderPage();
    await chooseBehraam(view);
    const rows = bodyRows(view);
    expect(rows.map((row) => row.querySelectorAll("td")[1]?.textContent)).toEqual(["0", "11802", "RV-00001", "3181"]);
    expect(rows.filter((row) => row.classList.contains("ledger-archived-row"))).toHaveLength(3);
    for (const row of rows.filter((item) => item.classList.contains("ledger-archived-row"))) expect(within(row as HTMLElement).getByText("Archived")).toBeInTheDocument();
    expect(view.container.querySelectorAll(".customer-ledger-table")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /Historical|Live Ledger/i })).toBeNull();
    expect(screen.getByText(/meezan/).textContent).toBe("received khawaja talal hassan\nmeezan");
  });

  it("keeps the live balance the live ledger's; the archive's printed balance is shown apart", async () => {
    const { view } = renderPage();
    await chooseBehraam(view);
    const highlight = view.container.querySelector(".customer-ledger-highlight") as HTMLElement;
    expect(highlight.textContent).toContain("Rs. 50,000");
    const strip = screen.getByRole("region", { name: "Previous software" });
    expect(strip.textContent).toContain("Rs. 480");
    expect(strip.textContent).toContain("Not included in the live balance.");
    const totals = Array.from(view.container.querySelectorAll("tfoot tr")).map((row) => row.textContent ?? "");
    expect(totals[0]).toContain("Live total (1 entries)");
    expect(totals[1]).toContain("Archived total (3 rows)");
  });

  it("filters to the archived rows, and searches across both", async () => {
    const { view } = renderPage();
    await chooseBehraam(view);
    fireEvent.change(screen.getByRole("combobox", { name: "Filter transactions" }), { target: { value: "ARCHIVED" } });
    expect(bodyRows(view).every((row) => row.classList.contains("ledger-archived-row"))).toBe(true);
    fireEvent.change(screen.getByRole("combobox", { name: "Filter transactions" }), { target: { value: "ALL" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Search transactions" }), { target: { value: "meezan" } });
    expect(bodyRows(view).map((row) => row.querySelectorAll("td")[1]?.textContent)).toEqual(["3181"]);
    fireEvent.change(screen.getByRole("textbox", { name: "Search transactions" }), { target: { value: "RV-00001" } });
    expect(bodyRows(view).map((row) => row.querySelectorAll("td")[1]?.textContent)).toEqual(["RV-00001"]);
  });

  it("offers the import only to accounts users", async () => {
    renderPage();
    expect(screen.queryByRole("button", { name: "Import old ledger" })).toBeNull();
    renderPage([PERMISSION.CUSTOMER_LEDGER, PERMISSION.CASH_VOUCHER_FORM]);
    expect(await screen.findByRole("button", { name: "Import old ledger" })).toBeInTheDocument();
  });

  it("downloads Excel and PDF with both sources in them", async () => {
    const { view, api } = renderPage();
    await chooseBehraam(view);
    fireEvent.click(screen.getByRole("button", { name: /Download Excel/ }));
    const sheet = downloads.sheets[0];
    expect(sheet?.rows.map((row) => [row[0], row[2]])).toEqual([["Archived", "0"], ["Archived", "11802"], ["Live", "RV-00001"], ["Archived", "3181"]]);
    fireEvent.click(screen.getByRole("button", { name: /Download PDF/ }));
    await waitFor(() => expect(api.savePdfDocument).toHaveBeenCalled());
    const payload = api.savePdfDocument.mock.calls[0]?.[0] as { html: string; pageNumbers: boolean; landscape: boolean };
    expect(payload.pageNumbers).toBe(true);
    expect(payload.html).toContain("RV-00001");
    expect(payload.html.match(/<tr class="archived">/g)).toHaveLength(3);
  });

  it("shows that no opening balance is posted, and offers to set one only to an administrator", async () => {
    const { view } = renderPage();
    await chooseBehraam(view);
    const strip = await screen.findByRole("region", { name: "Opening balance" });
    expect(strip.textContent).toContain("No opening balance posted");
    expect(screen.queryByRole("button", { name: "Set opening balance" })).toBeNull();
  });

  it("an administrator posts the archive's closing balance as the opening balance, and the ledger reloads", async () => {
    const { view, api } = renderPage([PERMISSION.CUSTOMER_LEDGER], "ADMIN");
    await chooseBehraam(view);
    fireEvent.click(await screen.findByRole("button", { name: "Set opening balance" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Use the archive's closing balance" }));
    expect((within(dialog).getByLabelText("Amount (Rs.)") as HTMLInputElement).value).toBe("480");
    expect((within(dialog).getByLabelText("Takes effect on") as HTMLInputElement).value).toBe("2026-11-14");
    fireEvent.change(within(dialog).getByLabelText("Amount (Rs.)"), { target: { value: "353,880" } });
    const loads = api.getCustomerLedgerWithCash.mock.calls.length;
    fireEvent.click(within(dialog).getByRole("button", { name: "Post opening balance" }));
    await waitFor(() => expect(api.postPartyOpeningBalance).toHaveBeenCalled());
    expect(api.postPartyOpeningBalance.mock.calls[0]?.[0]).toMatchObject({ partyId: "p1", direction: "DEBIT", amountPaisa: 35_388_000, effectiveDate: "2026-11-14", archiveStatementId: "s1" });
    await waitFor(() => expect(api.getCustomerLedgerWithCash.mock.calls.length).toBeGreaterThan(loads));
  });

  it("refuses to post without a source, saying what is missing, and sends nothing", async () => {
    const { view, api } = renderPage([PERMISSION.CUSTOMER_LEDGER], "ADMIN");
    await chooseBehraam(view);
    fireEvent.click(await screen.findByRole("button", { name: "Set opening balance" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Amount (Rs.)"), { target: { value: "1,000" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Post opening balance" }));
    expect(await within(dialog).findByText(/Say where the figure comes from/)).toBeInTheDocument();
    expect(api.postPartyOpeningBalance).not.toHaveBeenCalled();
  });

  it("a live opening balance row is labelled, in the live totals, and opens no voucher", async () => {
    const { view, api } = renderPage();
    api.getPartyOpeningBalance.mockResolvedValue(POSTED_OPENING);
    api.getCustomerLedgerWithCash.mockResolvedValue({
      ...LIVE, closingBalance: 303_880,
      entries: [{ voucherId: "ob1", voucherNumber: "OB", voucherDate: "2026-11-14", voucherType: "OPENING_BALANCE", description: "Old ledger 1301139", debitAmount: 353_880, creditAmount: 0, balance: 353_880 }, { ...LIVE.entries[0], voucherDate: "2026-11-15", balance: 303_880 }],
    });
    await waitFor(() => expect(view.container.querySelector(".cl-customer-select-box")).not.toBeNull());
    fireEvent.click(view.container.querySelector(".cl-customer-select-box") as Element);
    fireEvent.click(await screen.findByRole("option", { name: /Behraam Shoes Karachi/ }));
    const row = (await screen.findByText("OB")).closest("tr") as HTMLElement;
    expect(within(row).getAllByText("Opening balance").length).toBeGreaterThan(0);
    fireEvent.click(row);
    expect(api.getCashVoucher).not.toHaveBeenCalled();
    expect((await screen.findByRole("region", { name: "Opening balance" })).textContent).toContain("Included in the live balance.");
  });

  it("asks for the archive with the screen's dates, and shows an empty period plainly", async () => {
    const { view, api } = renderPage();
    api.getLedgerArchive.mockResolvedValue({ accepted: true, view: { statements: [], entries: [] } });
    api.getCustomerLedgerWithCash.mockResolvedValue({ ...LIVE, entries: [], closingBalance: 0 });
    await waitFor(() => expect(view.container.querySelector(".cl-customer-select-box")).not.toBeNull());
    fireEvent.click(view.container.querySelector(".cl-customer-select-box") as Element);
    fireEvent.click(await screen.findByRole("option", { name: /Behraam Shoes Karachi/ }));
    expect(await screen.findByText("No transactions in this period.")).toBeInTheDocument();
    expect(api.getLedgerArchive).toHaveBeenCalledWith("p1", expect.objectContaining({ fromDate: "2026-01-01" }));
    expect(screen.queryByRole("region", { name: "Previous software" })).toBeNull();
  });
});
