import { describe, expect, it } from "vitest";
import { balanceTotals, customerGroups, filterBalances, parseBalancesReply, type CustomerBalanceRow } from "./customerBalances";

const row = (partyName: string, groupName: string | null, balance: number, city: string | null = null): CustomerBalanceRow => ({
  partyId: partyName, partyName, city, groupName, balance, lastVoucherDate: null, totalSales: balance, totalReceipts: 0,
});

const ROWS = [row("ABDUL GHANI HYDERABAD", "Hyderabad", 353_880.1, "Hyderabad"), row("Behraam Shoes", "Karachi", 0.2), row("No Group", null, -1_000)];

describe("Customer Balance figures", () => {
  it("narrows to a group and a loose search (name, city, group or amount)", () => {
    expect(filterBalances(ROWS, "Hyderabad", "").map((each) => each.partyName)).toEqual(["ABDUL GHANI HYDERABAD"]);
    expect(filterBalances(ROWS, "", "behraam").map((each) => each.partyName)).toEqual(["Behraam Shoes"]);
    expect(filterBalances(ROWS, "", "353,880").map((each) => each.partyName)).toEqual(["ABDUL GHANI HYDERABAD"]);
    expect(filterBalances(ROWS, "", "")).toHaveLength(3);
  });

  it("offers only the groups customers are in, once each, A to Z", () => {
    expect(customerGroups([...ROWS, row("Asif Ayoob", "Hyderabad", 0)])).toEqual(["Hyderabad", "Karachi"]);
  });

  it("adds up in paisa, so the total is exact", () => {
    expect(balanceTotals(ROWS)).toEqual({ count: 3, balance: 352_880.3, sales: 352_880.3, receipts: 0 });
  });

  it("refuses a reply with a malformed row, and drops nothing silently", () => {
    expect(parseBalancesReply({ rows: ROWS, total: 3 })).toMatchObject({ ok: true });
    expect(parseBalancesReply({ rows: [{ ...ROWS[0], balance: "1" }] }).ok).toBe(false);
    expect(parseBalancesReply(null).ok).toBe(false);
  });
});
