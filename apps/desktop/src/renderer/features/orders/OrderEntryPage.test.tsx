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

    const grid = await screen.findByLabelText("SK6 dozens by size and colour");
    expect(within(grid).getByLabelText("BLUE is not in Product Master in size 7. Ask an administrator to add it.")).toHaveTextContent("Not in Product Master");
    expect(within(grid).queryByRole("textbox", { name: "SK6 BLUE size 7, dozens" })).toBeNull();

    // Typed in dozens (24 Nov 2026); sent as cartons, 1 dozen = 2.
    type("SK6 RED size 6, dozens", "10");
    type("SK6 RED size 7, dozens", "20.5");
    type("SK6 BLUE size 6, dozens", "15");
    expect(screen.getByText("45.5 dzn")).toBeTruthy();
    expect(screen.getByText("45.5 dozen")).toBeTruthy();

    await press(() => screen.findByRole("button", { name: "Save order" }));
    expect(api.saveCustomerOrder).toHaveBeenCalledTimes(1);
    const sent = api.saveCustomerOrder.mock.calls[0]![0] as { partyId: string; lines: unknown[]; requestId: string };
    expect(sent.partyId).toBe(PARTY.id);
    expect(sent.requestId).toMatch(/^[0-9a-f-]{36}$/);
    const byProduct = (a: { productVariantId: string }, b: { productVariantId: string }) => a.productVariantId.localeCompare(b.productVariantId);
    expect([...(sent.lines as Array<{ productVariantId: string }>)].sort(byProduct)).toEqual([
      { productVariantId: "blue-6", quantity: 30 },
      { productVariantId: "red-6", quantity: 20 },
      { productVariantId: "red-7", quantity: 41 },
    ]);
    expect(await screen.findByText("ORD-000001 · BEHRAAM SHOES")).toBeTruthy();
    // The end of the task (peak-end, 24 Nov 2026): the order says it was saved, in dozens, and offers the next one once.
    expect(screen.getByRole("status")).toHaveTextContent("ORD-000001 saved — 45.5 dozen for BEHRAAM SHOES");
    expect(screen.getAllByRole("button", { name: "+ New order" })).toHaveLength(1);
  });

  it("will not save a quantity that is not whole or half dozens", async () => {
    const api = createFakeBackend();
    render(<NotificationsProvider><OrderEntryPage token="token-1" canCancel={false} isAdmin={false} /></NotificationsProvider>);
    await pick("Party", /BEHRAAM SHOES/);
    await pick("Article", /SK6/);
    await press(() => screen.findByRole("button", { name: "Colour RED" }));
    type("SK6 RED size 6, dozens", "2.25");
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
    type("SK6 GREEN size 6, dozens", "7");
    expect(screen.getByText("7 dozen")).toBeTruthy();
  });

  // Owner, 24 Nov 2026 (the page's UI/UX pass): the picker offers only articles not yet on the order, the article just
  // added hands the focus to its first colour, and the optional note waits behind "+ Add a note".
  it("hides an added article from the picker, focuses its first colour, and keeps the note behind a button until wanted", async () => {
    const api = createFakeBackend();
    Object.assign(api, { listUniqueArticles: vi.fn(async () => ["SK6", "SK9"]) });
    render(<NotificationsProvider><OrderEntryPage token="token-1" canCancel isAdmin={false} /></NotificationsProvider>);
    await pick("Party", /BEHRAAM SHOES/);

    expect(screen.queryByRole("textbox", { name: "Note" })).toBeNull();
    await press(() => screen.findByRole("button", { name: "+ Add a note" }));
    expect(screen.getByRole("textbox", { name: "Note" })).toHaveFocus();

    await pick("Article", /SK6/);
    // Colours are listed A to Z, so the first is BLUE.
    const first = await screen.findByRole("button", { name: "Colour BLUE" });
    await waitFor(() => expect(first).toHaveFocus());

    await userEvent.click(screen.getByRole("combobox", { name: "Article" }));
    expect(await screen.findByRole("option", { name: /SK9/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /SK6/ })).toBeNull();
  });

  // Owner, 24 Nov 2026: orders are for customers only; a supplier is not offered.
  it("offers customers only in the party list", async () => {
    const api = createFakeBackend();
    const supplier = { ...PARTY, id: "party-2", partyName: "AI TRADERS", partyType: "SUPPLIER" };
    Object.assign(api, { listParties: vi.fn(async () => ({ rows: [PARTY, supplier], total: 2, page: 1, pageSize: 1000 })) });
    render(<NotificationsProvider><OrderEntryPage token="token-1" canCancel isAdmin={false} /></NotificationsProvider>);
    await userEvent.click(await screen.findByRole("combobox", { name: "Party" }));
    expect(await screen.findByRole("option", { name: /BEHRAAM SHOES/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /AI TRADERS/ })).toBeNull();
  });

  // Owner, 24 Nov 2026: a size a colour is not made in is no dead end — an administrator adds it, and types the dozens.
  it("lets an administrator add a colour's missing size from its cell, then type its dozens", async () => {
    const api = createFakeBackend();
    const withBlue7 = [...PRODUCTS, { productVariantId: "blue-7", size: "7", color: "BLUE" }];
    const addArticleColor = vi.fn(async (_input: { article: string; color: string }) => ({ accepted: true, color: "BLUE", added: 1, existing: 1 }));
    Object.assign(api, {
      addArticleColor,
      getCustomerOrderArticle: vi.fn().mockResolvedValueOnce({ accepted: true, products: PRODUCTS }).mockResolvedValue({ accepted: true, products: withBlue7 }),
    });
    render(<NotificationsProvider><OrderEntryPage token="token-1" canCancel isAdmin /></NotificationsProvider>);
    await pick("Party", /BEHRAAM SHOES/);
    await pick("Article", /SK6/);
    await press(() => screen.findByRole("button", { name: "Colour BLUE" }));
    await press(() => screen.findByRole("button", { name: "Add BLUE in size 7 to Product Master" }));
    expect(addArticleColor).toHaveBeenCalledWith({ article: "SK6", color: "BLUE" });
    const box = await screen.findByRole("textbox", { name: "SK6 BLUE size 7, dozens" });
    await waitFor(() => expect(box).toHaveFocus());
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
