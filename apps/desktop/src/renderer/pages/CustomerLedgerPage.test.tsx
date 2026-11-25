import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  partyId: "p1", partyName: "Behraam Shoes Karachi", balanceLimit: null, openingBalance: 0, closingBalance: -49_520, oldLedgerBalance: 480,
  entries: [{ voucherId: "cv1", voucherNumber: "RV-00001", voucherDate: "2026-10-12", voucherType: "CASH_RECEIPT", description: "Received on account", modeOfTransfer: "Cash", debitAmount: 0, creditAmount: 50_000, balance: -27_804 }],
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

async function pickBehraam(api: ReturnType<typeof renderPage>["api"]) {
  await waitFor(() => expect(api.listParties).toHaveBeenCalled());
  fireEvent.click(await screen.findByRole("combobox", { name: "Customer" }));
  fireEvent.click(await screen.findByRole("option", { name: /Behraam Shoes Karachi/ }));
}

async function chooseBehraam(view: ReturnType<typeof render>, api: ReturnType<typeof renderPage>["api"]) {
  await pickBehraam(api);
  await screen.findByText("RV-00001");
  await screen.findByText(/4 Dzn HR-1/);
  expect(view.container).toBeTruthy();
}

const show = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

const bodyRows = (view: ReturnType<typeof render>) => Array.from(view.container.querySelectorAll(".customer-ledger-table tbody tr"));

describe("CustomerLedgerPage with an archived ledger", () => {
  beforeEach(() => {
    downloads.sheets.length = 0;
    window.localStorage.clear();
  });

  it("shows imported and ERP entries as ONE ledger, by date, with no old/new tags (owner, 25 Nov 2026)", async () => {
    const { view, api } = renderPage();
    await chooseBehraam(view, api);
    const rows = bodyRows(view);
    expect(rows.map((row) => row.querySelectorAll("td")[1]?.textContent)).toEqual(["0", "11802", "RV-00001", "3181"]);
    expect(rows.filter((row) => row.classList.contains("ledger-archived-row"))).toHaveLength(3);
    expect(within(view.container.querySelector(".customer-ledger-table") as HTMLElement).queryByText("Archived")).toBeNull();
    expect(view.container.querySelectorAll(".customer-ledger-table")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /Historical|Live Ledger/i })).toBeNull();
    expect(screen.getByText(/meezan/).textContent).toBe("received khawaja talal hassan\nmeezan");
  });

  it("one balance (owner, 25 Nov 2026): the imported ledger's 480 and the ERP's −50,000 as one figure, one sum, one total", async () => {
    const { view, api } = renderPage([PERMISSION.CUSTOMER_LEDGER], "ADMIN");
    await chooseBehraam(view, api);
    const hero = screen.getByRole("region", { name: "Current balance" });
    expect(hero.textContent).toContain("Rs. 49,520");
    expect(hero.textContent).toContain("Advance");
    expect(within(hero).queryByText(/Old software|ERP entries/)).toBeNull();
    // Brought forward 202,200 (the imported ledger's opening line) + 30,240 − 281,960 = −49,520.
    const sum = screen.getByRole("region", { name: "How the period's balance is made" });
    expect(sum.textContent).toContain("202,200");
    expect(sum.textContent).toContain("30,240");
    expect(sum.textContent).toContain("281,960");
    expect(screen.queryByText(/not in this figure yet/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Carry it into the balance|Set opening balance/ })).toBeNull();
    const strip = screen.getByRole("region", { name: "Previous software" });
    expect(strip.textContent).toContain("Rs. 480");
    expect(strip.textContent).toContain("Its rows are part of this ledger and its balance.");
    const totals = Array.from(view.container.querySelectorAll("tfoot tr")).map((row) => row.textContent ?? "");
    expect(totals[0]).toContain("Total (4 entries)");
    expect(totals[0]).toContain("30,240");
    expect(totals[0]).toContain("281,960");
    expect(totals.join(" ")).not.toMatch(/Live total|Archived total/);
  });

  it("filters imported and ERP rows by the same choices, and searches across both", async () => {
    const { view, api } = renderPage();
    await chooseBehraam(view, api);
    expect(screen.queryByRole("button", { name: "Old software" })).toBeNull();
    show("Receipts");
    expect(bodyRows(view).map((row) => row.querySelectorAll("td")[1]?.textContent)).toEqual(["RV-00001", "3181"]);
    show("Sales");
    expect(bodyRows(view).map((row) => row.querySelectorAll("td")[1]?.textContent)).toEqual(["11802"]);
    show("All");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search transactions" }), { target: { value: "meezan" } });
    expect(bodyRows(view).map((row) => row.querySelectorAll("td")[1]?.textContent)).toEqual(["3181"]);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search transactions" }), { target: { value: "RV-00001" } });
    expect(bodyRows(view).map((row) => row.querySelectorAll("td")[1]?.textContent)).toEqual(["RV-00001"]);
  });

  it("offers the import only to accounts users", async () => {
    renderPage();
    // Hick's law: the old-ledger actions sit in one menu.
    fireEvent.click(screen.getByRole("button", { name: /Old ledgers/ }));
    expect(screen.queryByRole("menuitem", { name: "Import old ledger" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Reconciliation" })).toBeInTheDocument();
    cleanup();
    renderPage([PERMISSION.CUSTOMER_LEDGER, PERMISSION.CASH_VOUCHER_FORM]);
    fireEvent.click(await screen.findByRole("button", { name: /Old ledgers/ }));
    expect(await screen.findByRole("menuitem", { name: "Import old ledger" })).toBeInTheDocument();
    cleanup();
    // Nothing to post: the imported ledger is already in the balance.
    renderPage([PERMISSION.CUSTOMER_LEDGER], "ADMIN");
    fireEvent.click(await screen.findByRole("button", { name: /Old ledgers/ }));
    expect(screen.queryByRole("menuitem", { name: /opening balance/i })).toBeNull();
  });

  it("downloads Excel and PDF as one ledger: every row, no source column or tags, one total", async () => {
    const { view, api } = renderPage();
    await chooseBehraam(view, api);
    fireEvent.click(screen.getByRole("button", { name: /^Download/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Download Excel" }));
    const sheet = downloads.sheets[0];
    expect(sheet?.headers[0]).toBe("Date");
    expect(sheet?.rows.map((row) => row[1])).toEqual(["0", "11802", "RV-00001", "3181"]);
    fireEvent.click(screen.getByRole("button", { name: /^Download/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Download PDF" }));
    await waitFor(() => expect(api.savePdfDocument).toHaveBeenCalled());
    const payload = api.savePdfDocument.mock.calls[0]?.[0] as { html: string; pageNumbers: boolean; landscape: boolean };
    expect(payload.pageNumbers).toBe(true);
    expect(payload.html).toContain("RV-00001");
    expect(payload.html).not.toContain('<tr class="archived">');
    expect(payload.html).toContain("Total (4 entries)");
    expect(payload.html).not.toMatch(/Live total|Archived total/);
  });

  it("a posted opening balance row is labelled, counted once, and opens no voucher", async () => {
    const { view, api } = renderPage();
    api.getPartyOpeningBalance.mockResolvedValue(POSTED_OPENING);
    api.getCustomerLedgerWithCash.mockResolvedValue({
      ...LIVE, closingBalance: 303_880, oldLedgerBalance: 353_880,
      entries: [{ voucherId: "ob1", voucherNumber: "OB", voucherDate: "2026-11-14", voucherType: "OPENING_BALANCE", description: "Old ledger 1301139", debitAmount: 353_880, creditAmount: 0, balance: 353_880 }, { ...LIVE.entries[0], voucherDate: "2026-11-15", balance: 303_880 }],
    });
    await pickBehraam(api);
    const row = (await screen.findByText("OB")).closest("tr") as HTMLElement;
    expect(within(row).getAllByText("Opening balance").length).toBeGreaterThan(0);
    fireEvent.click(row);
    expect(api.getCashVoucher).not.toHaveBeenCalled();
    // An opening balance posted before is counted once: the balance is the main process's 303,880.
    expect(screen.getByRole("region", { name: "Current balance" }).textContent).toContain("Rs. 303,880");
    expect(view.container).toBeTruthy();
  });

  it("asks for the archive with the screen's dates, and shows an empty period plainly", async () => {
    const { view, api } = renderPage();
    api.getLedgerArchive.mockResolvedValue({ accepted: true, view: { statements: [], entries: [] } });
    api.getCustomerLedgerWithCash.mockResolvedValue({ ...LIVE, entries: [], closingBalance: 0 });
    await pickBehraam(api);
    expect(await screen.findByText("No transactions in this period.")).toBeInTheDocument();
    // The ledger opens on All time: the old software's history is part of it.
    expect(api.getLedgerArchive).toHaveBeenCalledWith("p1", expect.objectContaining({ fromDate: "2000-01-01" }));
    expect(view.container).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Previous software" })).toBeNull();
  });

  it("says when the ledger could not be read, and reads it again on Retry", async () => {
    const { api } = renderPage();
    api.getCustomerLedgerWithCash.mockRejectedValueOnce(new Error("disk"));
    await pickBehraam(api);
    fireEvent.click(await screen.findByRole("button", { name: /Retry/ }));
    expect(await screen.findByText("RV-00001")).toBeInTheDocument();
  });

  it("opens a voucher from its number, a button with a name", async () => {
    const { view, api } = renderPage();
    await chooseBehraam(view, api);
    fireEvent.click(screen.getByRole("button", { name: "Open RV-00001" }));
    await waitFor(() => expect(api.getCashVoucher).toHaveBeenCalledWith("cv1"));
  });

  it("finds a voucher typed loosely, and Escape clears the search", async () => {
    const { view, api } = renderPage();
    await chooseBehraam(view, api);
    const search = screen.getByRole("searchbox", { name: "Search transactions" });
    fireEvent.change(search, { target: { value: "rv1" } });
    expect(bodyRows(view).map((row) => row.querySelectorAll("td")[1]?.textContent)).toEqual(["RV-00001"]);
    fireEvent.change(search, { target: { value: "50,000" } });
    expect(bodyRows(view).map((row) => row.querySelectorAll("td")[1]?.textContent)).toEqual(["RV-00001"]);
    fireEvent.keyDown(search, { key: "Escape" });
    expect((search as HTMLInputElement).value).toBe("");
  });

  it("shows the old software's columns by default, the rest on request, and ends on the closing balance", async () => {
    const { view, api } = renderPage();
    await chooseBehraam(view, api);
    const table = view.container.querySelector(".customer-ledger-table") as HTMLElement;
    expect(table.classList.contains("cl-table--simple")).toBe(true);
    const closing = view.container.querySelector(".cl-closing-row") as HTMLElement;
    expect(closing.textContent).toContain("Closing balance on");
    expect(closing.textContent).toContain("Advance");
    expect(closing.textContent).toContain("49,520");
    fireEvent.click(screen.getByRole("button", { name: "More columns" }));
    expect(table.classList.contains("cl-table--simple")).toBe(false);
    expect(screen.getByRole("button", { name: "Fewer columns" })).toHaveAttribute("aria-pressed", "true");
  });
});
