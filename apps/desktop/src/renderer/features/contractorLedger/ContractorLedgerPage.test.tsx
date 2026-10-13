import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ContractorLedgerPage } from "./ContractorLedgerPage";
import type { ContractorLedgerAccount, ContractorLedgerReport } from "../../types/desktopApi";

// The Contractor Ledger page: who can be picked and as what, and the ledger the main process
// works out — shown as figures, a running balance, and production days that open to their sums.

const ALAMGIR: ContractorLedgerAccount = { id: "c1", name: "ALAMGIR", city: "LAHORE", active: true, roles: ["MACHINE"] };
const DANIYAL: ContractorLedgerAccount = { id: "c2", name: "DANIYAL", city: "LAHORE", active: true, roles: ["PACKING"] };

const ledgerFor = (overrides: Partial<ContractorLedgerReport> = {}): ContractorLedgerReport => ({
  account: ALAMGIR,
  fromDate: "2026-10-01",
  toDate: "2026-10-12",
  openingBalancePaisa: 0,
  closingBalancePaisa: 20000,
  earnedPaisa: 70000,
  paidPaisa: 50000,
  totalCreditPaisa: 70000,
  totalDebitPaisa: 50000,
  dozens: 10,
  unpricedDozens: 0,
  entries: [
    {
      kind: "WORK", date: "2026-10-10", creditPaisa: 70000, debitPaisa: 0, balancePaisa: 70000,
      work: {
        date: "2026-10-10", cartons: 20, dozens: 10, amountPaisa: 70000, unpricedDozens: 0,
        lines: [{
          programId: "p1", programCode: "MP-000011", machineName: "MACHINE 1", role: "MACHINE", articleSizeId: "sk6",
          article: "SK6", size: "7/10", cartons: 20, dozens: 10, ratePaisa: 7000, rateSource: "PROGRAM", amountPaisa: 70000,
        }],
      },
    },
    {
      kind: "PAYMENT", date: "2026-10-11", creditPaisa: 0, debitPaisa: 50000, balancePaisa: 20000,
      payment: { date: "2026-10-11", voucherId: "v1", voucherNumber: "CV-000045", description: "Weekly", modeOfTransfer: "Cash", kind: "PAYMENT", amountPaisa: 50000 },
    },
  ],
  ...overrides,
});

const renderPage = (api: Record<string, unknown>, onNavigate = vi.fn()) => {
  Object.defineProperty(window, "desktop", {
    value: { versions: { node: "22", chrome: "128", electron: "43" }, api },
    configurable: true,
  });
  render(<ContractorLedgerPage onNavigate={onNavigate} />);
  return onNavigate;
};

const pick = async (name: RegExp) => {
  fireEvent.click(await screen.findByRole("button", { name: "Show options" }));
  fireEvent.click(screen.getByRole("option", { name }));
};

describe("ContractorLedgerPage", () => {
  it("labels each contractor as machine or packing, and lists the printing ledger", async () => {
    renderPage({ listContractorLedgerAccounts: vi.fn().mockResolvedValue({ accepted: true, accounts: [ALAMGIR, DANIYAL] }) });

    expect(await screen.findByText("2 contractors")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show options" }));
    const options = screen.getAllByRole("option").map((option) => option.textContent);
    expect(options).toEqual([
      "ALAMGIRMachine Contractor · LAHORE",
      "DANIYALPacking Contractor · LAHORE",
      "Printing ContractorPrinting Contractor",
    ]);
  });

  it("opens a contractor's ledger: figures, running balance, and a day that opens to its calculation", async () => {
    const getContractorLedger = vi.fn().mockResolvedValue({ accepted: true, ledger: ledgerFor() });
    renderPage({
      listContractorLedgerAccounts: vi.fn().mockResolvedValue({ accepted: true, accounts: [ALAMGIR] }),
      getContractorLedger,
    });

    await pick(/ALAMGIR/);
    expect(await screen.findByText("Balance Payable")).toBeInTheDocument();
    expect(getContractorLedger).toHaveBeenCalledWith("c1", expect.objectContaining({ fromDate: expect.stringMatching(/-01$/) }));
    expect(screen.getAllByText("Machine Contractor").length).toBeGreaterThan(0);
    expect(screen.getByText("Production · MP-000011")).toBeInTheDocument();
    expect(screen.getByText("Payment · CV-000045 · Cash · Weekly")).toBeInTheDocument();

    const toggle = screen.getByRole("button", { name: /show production details/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: /hide production details/i })).toHaveAttribute("aria-expanded", "true");
    const detail = screen.getByRole("columnheader", { name: "Calculation" }).closest("table")!;
    // 10 DOZEN at Rs 70 the dozen, written out the way it was worked out.
    expect(within(detail).getByText("10 DZN × Rs 70.00 = Rs 700.00")).toBeInTheDocument();
    expect(within(detail).getByText("Program rate")).toBeInTheDocument();
    expect(within(detail).getByText("20 cartons")).toBeInTheDocument();
  });

  it("warns when some production has no rate, instead of counting it as free", async () => {
    renderPage({
      listContractorLedgerAccounts: vi.fn().mockResolvedValue({ accepted: true, accounts: [ALAMGIR] }),
      getContractorLedger: vi.fn().mockResolvedValue({ accepted: true, ledger: ledgerFor({ unpricedDozens: 3 }) }),
    });
    await pick(/ALAMGIR/);
    expect(await screen.findByText(/3 DZN produced has no rate set/)).toBeInTheDocument();
  });

  it("says why a ledger could not be loaded, and retries", async () => {
    const getContractorLedger = vi.fn()
      .mockResolvedValueOnce({ accepted: false, reason: "You do not have permission" })
      .mockResolvedValue({ accepted: true, ledger: ledgerFor() });
    renderPage({ listContractorLedgerAccounts: vi.fn().mockResolvedValue({ accepted: true, accounts: [ALAMGIR] }), getContractorLedger });

    await pick(/ALAMGIR/);
    expect(await screen.findByText("You do not have permission")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() => expect(screen.getByText("Balance Payable")).toBeInTheDocument());
  });

  it("with no contractors yet, offers to add one — the printing ledger is still there", async () => {
    const onNavigate = renderPage({ listContractorLedgerAccounts: vi.fn().mockResolvedValue({ accepted: true, accounts: [] }) });

    expect(await screen.findByText("No contractors yet")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add Contractor" }));
    expect(onNavigate).toHaveBeenCalledWith("party-form");
    fireEvent.click(screen.getByRole("button", { name: "Show options" }));
    expect(screen.getAllByRole("option")).toHaveLength(1);
  });
});
