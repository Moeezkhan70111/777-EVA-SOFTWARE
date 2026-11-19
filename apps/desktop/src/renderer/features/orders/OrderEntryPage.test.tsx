import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NotificationsProvider } from "../../state/NotificationsContext";
import { OrderEntryPage } from "./OrderEntryPage";

// Enter Orders: a party, an article with several colours at once, quantities in the size × colour matrix, totals, Save.
// Every rule is the data layer's (customerOrders.test.ts); this proves the screen offers only made combinations, sends
// exactly what was typed, and shows the order that came back.

const PARTY = { id: "party-1", partyCode: "PTY000001", partyName: "BEHRAAM SHOES", partyType: "CUSTOMER", status: "ACTIVE", city: "Lahore" };
const PRODUCTS = [
  { productVariantId: "red-6", size: "6", color: "RED" },
  { productVariantId: "red-7", size: "7", color: "RED" },
  { productVariantId: "blue-6", size: "6", color: "BLUE" },
];

const savedOrder = (lines: Array<{ productVariantId: string; quantity: number }>) => ({
  id: "order-1", orderNumber: 1, code: "ORD-000001", businessDate: "2026-11-17", partyId: PARTY.id, partyName: PARTY.partyName, note: null,
  status: "OPEN", revision: 1, createdBy: "clerk", createdAt: "2026-11-17T09:00:00.000Z", updatedBy: null, updatedAt: "2026-11-17T09:00:00.000Z",
  cancelledBy: null, cancelledAt: null, cancelReason: null,
  totals: { ordered: lines.reduce((sum, line) => sum + line.quantity, 0), dispatched: 0, pending: lines.reduce((sum, line) => sum + line.quantity, 0) },
  lines: lines.map((line, index) => {
    const product = PRODUCTS.find((each) => each.productVariantId === line.productVariantId)!;
    return { id: `l${index}`, lineNo: index + 1, productVariantId: line.productVariantId, article: "SK6", color: product.color, size: product.size, quantity: line.quantity, dispatched: 0, pending: line.quantity };
  }),
});

function createFakeBackend() {
  let stored: ReturnType<typeof savedOrder> | null = null;
  const api = {
    listParties: vi.fn(async () => ({ rows: [PARTY], total: 1, page: 1, pageSize: 1000 })),
    listUniqueArticles: vi.fn(async () => ["SK6"]),
    getCustomerOrderArticle: vi.fn(async () => ({ accepted: true, products: PRODUCTS })),
    getCustomerOrder: vi.fn(async () => ({ accepted: true, view: { order: stored, previousNumber: null, nextNumber: null, latestNumber: stored ? 1 : null } })),
    saveCustomerOrder: vi.fn(async (input: { lines: Array<{ productVariantId: string; quantity: number }> }) => {
      stored = savedOrder(input.lines);
      return { accepted: true, order: stored };
    }),
  };
  Object.defineProperty(window, "desktop", { value: { versions: { node: "22", chrome: "128", electron: "43" }, api }, configurable: true });
  return api;
}

const press = async (find: () => Promise<HTMLElement>) => {
  const control = await find();
  await waitFor(() => expect(control).toBeEnabled());
  await act(async () => { fireEvent.click(control); });
};

const pick = async (comboName: string, optionName: RegExp) => {
  await userEvent.click(await screen.findByRole("combobox", { name: comboName }));
  await userEvent.click(await screen.findByRole("option", { name: optionName }));
};

const type = (name: string, value: string) => fireEvent.change(screen.getByRole("textbox", { name }), { target: { value } });

describe("Enter Orders", () => {
  it("takes several colours of one article at once, offers only made sizes, totals them, and saves exactly what was typed", async () => {
    const api = createFakeBackend();
    render(<NotificationsProvider><OrderEntryPage token="token-1" canCancel isAdmin={false} /></NotificationsProvider>);

    await pick("Party", /BEHRAAM SHOES/);
    await pick("Article", /SK6/);
    await press(() => screen.findByRole("button", { name: "Colour RED" }));
    await press(() => screen.findByRole("button", { name: "Colour BLUE" }));

    const grid = await screen.findByLabelText("SK6 cartons by size and colour");
    expect(within(grid).getByLabelText("BLUE is not made in size 7")).toBeTruthy();
    expect(within(grid).queryByRole("textbox", { name: "SK6 BLUE size 7, cartons" })).toBeNull();

    type("SK6 RED size 6, cartons", "10");
    type("SK6 RED size 7, cartons", "20");
    type("SK6 BLUE size 6, cartons", "15");
    expect(screen.getByText("45 ctn")).toBeTruthy();
    expect(screen.getByText("45 cartons")).toBeTruthy();

    await press(() => screen.findByRole("button", { name: "Save order" }));
    expect(api.saveCustomerOrder).toHaveBeenCalledTimes(1);
    const sent = api.saveCustomerOrder.mock.calls[0]![0] as { partyId: string; lines: unknown[]; requestId: string };
    expect(sent.partyId).toBe(PARTY.id);
    expect(sent.requestId).toMatch(/^[0-9a-f-]{36}$/);
    const byProduct = (a: { productVariantId: string }, b: { productVariantId: string }) => a.productVariantId.localeCompare(b.productVariantId);
    expect([...(sent.lines as Array<{ productVariantId: string }>)].sort(byProduct)).toEqual([
      { productVariantId: "blue-6", quantity: 15 },
      { productVariantId: "red-6", quantity: 10 },
      { productVariantId: "red-7", quantity: 20 },
    ]);
    expect(await screen.findByText("ORD-000001 · BEHRAAM SHOES")).toBeTruthy();
  });

  it("will not save a quantity that is not a whole number of cartons", async () => {
    const api = createFakeBackend();
    render(<NotificationsProvider><OrderEntryPage token="token-1" canCancel={false} isAdmin={false} /></NotificationsProvider>);
    await pick("Party", /BEHRAAM SHOES/);
    await pick("Article", /SK6/);
    await press(() => screen.findByRole("button", { name: "Colour RED" }));
    type("SK6 RED size 6, cartons", "2.5");
    expect(screen.getByRole("alert").textContent).toMatch(/Fix the highlighted quantities/);
    expect(screen.getByRole("button", { name: "Save order" })).toBeDisabled();
    expect(api.saveCustomerOrder).not.toHaveBeenCalled();
  });
it("lets an administrator add a new colour to the article, and chooses it at once", async () => {
    const api = createFakeBackend();
    const withGreen = [...PRODUCTS, { productVariantId: "green-6", size: "6", color: "GREEN" }];
    const addArticleColor = vi.fn(async (_input: { article: string; color: string }) => ({ accepted: true, color: "GREEN", added: 1, existing: 0 }));
    Object.assign(api, {
      addArticleColor,
      getCustomerOrderArticle: vi.fn().mockResolvedValueOnce({ accepted: true, products: PRODUCTS }).mockResolvedValue({ accepted: true, products: withGreen }),
    });
    render(<NotificationsProvider><OrderEntryPage token="token-1" canCancel isAdmin /></NotificationsProvider>);
    await pick("Party", /BEHRAAM SHOES/);
    await pick("Article", /SK6/);
    await press(() => screen.findByRole("button", { name: "Add a new colour to SK6" }));
    fireEvent.change(screen.getByRole("textbox", { name: "New colour name" }), { target: { value: "green" } });
    await press(() => screen.findByRole("button", { name: "Add colour" }));
    const green = await screen.findByRole("button", { name: "Colour GREEN" });
    expect(green).toHaveAttribute("aria-pressed", "true");
    expect(addArticleColor).toHaveBeenCalledWith({ article: "SK6", color: "green" });
    type("SK6 GREEN size 6, cartons", "7");
    expect(screen.getByText("7 cartons")).toBeTruthy();
  });

  it("offers no new colour to anyone but an administrator", async () => {
    createFakeBackend();
    render(<NotificationsProvider><OrderEntryPage token="token-1" canCancel isAdmin={false} /></NotificationsProvider>);
    await pick("Party", /BEHRAAM SHOES/);
    await pick("Article", /SK6/);
    await screen.findByRole("button", { name: "Colour RED" });
    expect(screen.queryByRole("button", { name: "Add a new colour to SK6" })).toBeNull();
  });
});
