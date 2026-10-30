import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LeaseDomain } from "@erp/domain";
import { LEDGER_ROUTES, hiddenLedgerRoutes } from "./ledgerVisibility";
import { PartyCard } from "./PartyCard";
import { usePartyBalance } from "./usePartyBalance";

// Party ledgers and balances show only on the computer holding the Accounts lease, where the
// vouchers are (ledgerVisibility.ts). Anywhere else -- including while still asking, and when the
// answer cannot be read -- the balance is not shown at all, and is never even asked for.

function installApi(held: () => Promise<LeaseDomain[]>) {
  const api = { getHeldLeases: vi.fn(held), getCurrentPartyBalance: vi.fn(async () => 1500) };
  Object.defineProperty(window, "desktop", { value: { versions: { node: "22", chrome: "128", electron: "43" }, api }, configurable: true });
  return api;
}

const Card: React.FC = () => <PartyCard party={{ partyName: "Daniyal", partyCode: "PTY-000008" }} balance={usePartyBalance("p-8")} />;

describe("party ledgers and balances", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows a party's balance on the Accounts holder", async () => {
    installApi(async () => ["ACCOUNTS"]);
    render(<Card />);
    expect(await screen.findByTestId("party-balance")).toHaveTextContent("Rs 1,500");
  });

  it("shows no balance, and never asks for one, on a computer that does not hold Accounts", async () => {
    const api = installApi(async () => ["RAW_MATERIAL_STORE"]);
    render(<Card />);
    await waitFor(() => expect(api.getHeldLeases).toHaveBeenCalled());
    expect(screen.getByText("Daniyal")).toBeInTheDocument();
    expect(screen.queryByTestId("party-balance")).not.toBeInTheDocument();
    expect(api.getCurrentPartyBalance).not.toHaveBeenCalled();
  });

  it("fails closed: when the leases cannot be read, no balance is shown", async () => {
    const api = installApi(async () => {
      throw new Error("unreadable");
    });
    render(<Card />);
    await waitFor(() => expect(api.getHeldLeases).toHaveBeenCalled());
    expect(screen.queryByTestId("party-balance")).not.toBeInTheDocument();
    expect(api.getCurrentPartyBalance).not.toHaveBeenCalled();
  });

  it("hides the five ledger and balance pages unless the ledgers are shown", () => {
    expect([...hiddenLedgerRoutes(false)].sort()).toEqual(["contractor-ledger", "customer-balance", "customer-ledger", "supplier-balance", "supplier-ledger"]);
    expect(hiddenLedgerRoutes(false)).toBe(LEDGER_ROUTES);
    expect(hiddenLedgerRoutes(true).size).toBe(0);
  });
});
