import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationsProvider } from "../state/NotificationsContext";
import { DiscountPolicyPage } from "./DiscountPolicyPage";

// DISCOUNT POLICY (owner, 28 Nov 2026: in the card pages' look, docs/56): each box starts with the customer's discount
// now, Save sends only the changes, and the report is the same grid as the PDF. Synthetic customers only.

const party = (id: string, partyName: string) => ({ id, partyCode: id, partyName, partyType: "CUSTOMER" });
const CUSTOMERS = [party("p1", "SYNTHETIC ALPHA"), party("p2", "SYNTHETIC BETA")];
const REPORTS: Record<string, unknown[]> = {
  p1: [{ partyId: "p1", partyName: "SYNTHETIC ALPHA", type: "PRODUCT_GROUP", label: "EVR GENTS", discountPerPair: 35 }, { partyId: "p1", partyName: "SYNTHETIC ALPHA", type: "PRODUCT_GROUP", label: "EVR KIDS", discountPerPair: 20 }],
  p2: [{ partyId: "p2", partyName: "SYNTHETIC BETA", type: "PRODUCT_GROUP", label: "EVR GENTS", discountPerPair: 50 }],
};

let api: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  api = {
    getWriteLeases: vi.fn().mockResolvedValue([{ domain: "PARTIES", canWrite: true, reason: null, holderLabel: null }]),
    listParties: vi.fn().mockResolvedValue({ rows: CUSTOMERS, total: 2, page: 1, pageSize: 1000 }),
    listProductGroups: vi.fn().mockResolvedValue([{ id: "g1", groupName: "EVR GENTS" }, { id: "g2", groupName: "EVR KIDS" }]),
    listArticleSeries: vi.fn().mockResolvedValue([]),
    listProducts: vi.fn().mockResolvedValue({ rows: [{ id: "v1", article: "SK6", size: "7/10", color: "RED" }], total: 1 }),
    getPartyDiscountReport: vi.fn(async (partyId: string) => REPORTS[partyId] ?? []),
    createPartyProductGroupDiscount: vi.fn().mockResolvedValue({ accepted: true, id: "r1" }),
  };
  Object.defineProperty(window, "desktop", { value: { versions: { node: "22", chrome: "128", electron: "43" }, api }, configurable: true });
});

const show = () => render(<NotificationsProvider><DiscountPolicyPage /></NotificationsProvider>);
const box = (customer: string, what: string) => screen.getByRole("textbox", { name: `${customer}, discount per pair on ${what}` });

describe("Discount Policy", () => {
  it("opens on the first product group with each customer's discount now in their box", async () => {
    show();
    await waitFor(() => expect(box("SYNTHETIC ALPHA", "EVR GENTS")).toHaveValue("35"));
    expect(box("SYNTHETIC BETA", "EVR GENTS")).toHaveValue("50");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("saves only the box that changed, says what it was, and reads the rules again", async () => {
    show();
    await waitFor(() => expect(box("SYNTHETIC ALPHA", "EVR GENTS")).toHaveValue("35"));
    fireEvent.change(box("SYNTHETIC ALPHA", "EVR GENTS"), { target: { value: "40" } });
    expect(screen.getByText("was 35")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save 1 change" }));
    expect(api.createPartyProductGroupDiscount).toHaveBeenCalledTimes(1);
    expect(api.createPartyProductGroupDiscount).toHaveBeenCalledWith({ partyId: "p1", productGroupId: "g1", discountPerPair: 40 });
    await waitFor(() => expect(api.getPartyDiscountReport.mock.calls.length).toBeGreaterThan(2));
  });

  it("says to type 0 to take a discount off, and keeps Save off until it is fixed", async () => {
    show();
    await waitFor(() => expect(box("SYNTHETIC BETA", "EVR GENTS")).toHaveValue("50"));
    fireEvent.change(box("SYNTHETIC BETA", "EVR GENTS"), { target: { value: "" } });
    expect(screen.getByRole("alert")).toHaveTextContent("Type 0 to take the discount off.");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("shows the report as one row per customer and one column per group, the same grid as the PDF", async () => {
    show();
    const report = await screen.findByRole("table", { name: "Discounts by customer" });
    const headings = within(report).getAllByRole("columnheader").map((cell) => cell.textContent);
    expect(headings).toEqual(["Party name", "EVR GENTS", "EVR KIDS"]);
    const beta = within(report).getByRole("rowheader", { name: "SYNTHETIC BETA" }).closest("tr")!;
    expect(beta).toHaveTextContent("SYNTHETIC BETA50—");
  });

  it("reads everywhere, and changes only where customers are written", async () => {
    api.getWriteLeases!.mockResolvedValue([{ domain: "PARTIES", canWrite: false, reason: "HELD_ELSEWHERE", holderLabel: "PC1 - PARTIES" }]);
    show();
    await waitFor(() => expect(box("SYNTHETIC ALPHA", "EVR GENTS")).toBeDisabled());
    expect(screen.getByText(/PC1 - PARTIES/)).toBeInTheDocument();
  });

  it("says when the discounts could not be read, and Retry reads them again", async () => {
    api.listParties!.mockRejectedValueOnce(new Error("offline"));
    show();
    await userEvent.click(await screen.findByRole("button", { name: /retry/i }));
    await waitFor(() => expect(box("SYNTHETIC ALPHA", "EVR GENTS")).toHaveValue("35"));
  });
});
