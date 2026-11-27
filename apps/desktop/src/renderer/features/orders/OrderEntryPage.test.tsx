import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NotificationsProvider } from "../../state/NotificationsContext";
import { OrderEntryPage } from "./OrderEntryPage";
import { SessionProvider } from "../auth/SessionContext";
import type { AuthUser } from "../../types/desktopApi";

/** Adding a colour is for an administrator on the Product Master computer: the one rule (useCanAddColour). */
const ADMIN: AuthUser = { id: "u-admin", username: "owner", role: "ADMIN", accessStatus: "APPROVED", permissions: [], lastLoginAt: null };

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
  const listeners: Array<(change: unknown) => void> = [];
  const api = {
    // The main process's "data changed" announcement after a sync (hooks/useDataChanged.ts).
    onDataChanged: (listener: (change: unknown) => void) => { listeners.push(listener); return () => undefined; },
    announce: (kinds: string[]) => { for (const listener of listeners) listener({ kinds, id: "change-1" }); },
    dispatch: (cartons: number) => { if (stored) stored = { ...stored, totals: { ...stored.totals, dispatched: cartons, pending: stored.totals.ordered - cartons }, lines: stored.lines.map((line, index) => (index === 0 ? { ...line, dispatched: cartons, pending: line.quantity - cartons } : line)) }; },
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
  // Articles are added from a button that becomes the list, already open (24 Nov 2026).
  if (comboName === "Article") await userEvent.click(await screen.findByRole("button", { name: "Add article" }));
  else await userEvent.click(await screen.findByRole("combobox", { name: comboName }));
  await userEvent.click(await screen.findByRole("option", { name: optionName }));
};

const type = (name: string, value: string) => fireEvent.change(screen.getByRole("textbox", { name }), { target: { value } });

describe("Enter Orders", () => {
  // Owner, 27 Nov 2026: "DONT MAKE IT SELECT THE COLOR FIRST. OPEN ALL THE COLORS IN THE TABLE".
  it("opens every colour of the article at once, offers only made sizes, totals them, and saves exactly what was typed", async () => {
    const api = createFakeBackend();
    render(<NotificationsProvider><OrderEntryPage token="token-1" canCancel /></NotificationsProvider>);

    await pick("Party", /BEHRAAM SHOES/);
    await pick("Article", /SK6/);
    expect(screen.queryByRole("button", { name: "Colour RED" })).toBeNull();

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
    render(<NotificationsProvider><OrderEntryPage token="token-1" canCancel={false} /></NotificationsProvider>);
    await pick("Party", /BEHRAAM SHOES/);
    await pick("Article", /SK6/);
    await screen.findByRole("textbox", { name: "SK6 RED size 6, dozens" });
    type("SK6 RED size 6, dozens", "2.25");
    expect(screen.getByRole("alert").textContent).toMatch(/Fix the highlighted quantities/);
    expect(screen.getByRole("button", { name: "Save order" })).toBeDisabled();
    expect(api.saveCustomerOrder).not.toHaveBeenCalled();
  });
it("lets an administrator add a new colour to the article, and opens it as a column at once", async () => {
    const api = createFakeBackend();
    const withGreen = [...PRODUCTS, { productVariantId: "green-6", size: "6", color: "GREEN" }];
    const addArticleColor = vi.fn(async (_input: { article: string; color: string }) => ({ accepted: true, color: "GREEN", added: 1, existing: 0 }));
    Object.assign(api, {
      addArticleColor,
      getCustomerOrderArticle: vi.fn().mockResolvedValueOnce({ accepted: true, products: PRODUCTS }).mockResolvedValue({ accepted: true, products: withGreen }),
    });
    render(<SessionProvider user={ADMIN} token="token-1"><NotificationsProvider><OrderEntryPage token="token-1" canCancel /></NotificationsProvider></SessionProvider>);
    await pick("Party", /BEHRAAM SHOES/);
    await pick("Article", /SK6/);
    await press(() => screen.findByRole("button", { name: "Add a new colour to SK6" }));
    fireEvent.change(screen.getByRole("textbox", { name: "New colour name" }), { target: { value: "green" } });
    await press(() => screen.findByRole("button", { name: "Add colour" }));
    await screen.findByRole("textbox", { name: "SK6 GREEN size 6, dozens" });
    expect(addArticleColor).toHaveBeenCalledWith({ article: "SK6", color: "green" });
    type("SK6 GREEN size 6, dozens", "7");
    expect(screen.getByText("7 dozen")).toBeTruthy();
  });

  // Owner, 24 Nov 2026 (the page's UI/UX pass): the picker offers only articles not yet on the order, the article just
  // added hands the focus to its first box, and the optional note waits behind "+ Add a note".
  it("hides an added article from the picker, focuses its first box, and keeps the note behind a button until wanted", async () => {
    const api = createFakeBackend();
    Object.assign(api, { listUniqueArticles: vi.fn(async () => ["SK6", "SK9"]) });
    render(<NotificationsProvider><OrderEntryPage token="token-1" canCancel /></NotificationsProvider>);
    await pick("Party", /BEHRAAM SHOES/);

    expect(screen.queryByRole("textbox", { name: "Note" })).toBeNull();
    await press(() => screen.findByRole("button", { name: "+ Add a note" }));
    expect(screen.getByRole("textbox", { name: "Note" })).toHaveFocus();

    await pick("Article", /SK6/);
    // Colours are listed A to Z and sizes smallest first, so the first box is BLUE in size 6.
    const first = await screen.findByRole("textbox", { name: "SK6 BLUE size 6, dozens" });
    await waitFor(() => expect(first).toHaveFocus());

    // Picked, the list went back to being the button.
    expect(screen.queryByRole("combobox", { name: "Article" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Add article" }));
    expect(await screen.findByRole("option", { name: /SK9/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /SK6/ })).toBeNull();
    // Dismissed with Escape, it is the button again, and the page stays.
    await userEvent.keyboard("{Escape}");
    expect(await screen.findByRole("button", { name: "Add article" })).toBeInTheDocument();
  });

  // Owner, 24 Nov 2026: orders are for customers only; a supplier is not offered.
  it("offers customers only in the party list", async () => {
    const api = createFakeBackend();
    const supplier = { ...PARTY, id: "party-2", partyName: "AI TRADERS", partyType: "SUPPLIER" };
    Object.assign(api, { listParties: vi.fn(async () => ({ rows: [PARTY, supplier], total: 2, page: 1, pageSize: 1000 })) });
    render(<NotificationsProvider><OrderEntryPage token="token-1" canCancel /></NotificationsProvider>);
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
    render(<SessionProvider user={ADMIN} token="token-1"><NotificationsProvider><OrderEntryPage token="token-1" canCancel /></NotificationsProvider></SessionProvider>);
    await pick("Party", /BEHRAAM SHOES/);
    await pick("Article", /SK6/);
    await press(() => screen.findByRole("button", { name: "Add BLUE in size 7 to Product Master" }));
    expect(addArticleColor).toHaveBeenCalledWith({ article: "SK6", color: "BLUE" });
    const box = await screen.findByRole("textbox", { name: "SK6 BLUE size 7, dozens" });
    await waitFor(() => expect(box).toHaveFocus());
  });

  // Owner, 24 Nov 2026: orders are entered on PC3 and dispatched on PC1. What PC1 sent shows on PC3's open order without Ctrl+R.
  it("reads the order on screen again when a gatepass from another computer arrives", async () => {
    const api = createFakeBackend();
    render(<NotificationsProvider><OrderEntryPage token="token-1" canCancel /></NotificationsProvider>);
    await pick("Party", /BEHRAAM SHOES/);
    await pick("Article", /SK6/);
    await screen.findByRole("textbox", { name: "SK6 RED size 6, dozens" });
    type("SK6 RED size 6, dozens", "5");
    await press(() => screen.findByRole("button", { name: "Save order" }));
    await screen.findByText("ORD-000001 · BEHRAAM SHOES");
    const pending = () => Array.from(document.querySelectorAll(".ord-figures dd")).map((cell) => cell.textContent);
    expect(pending()).toEqual(["5", "0", "5"]);

    api.dispatch(4); // PC1's gatepass sent 2 dozen (4 cartons) against it
    await act(async () => { api.announce(["BILLING", "SYNC"]); });
    await waitFor(() => expect(pending()).toEqual(["5", "2", "3"]));
  });

  // Owner, 27 Nov 2026: "GIVE ADD COLOR OPTION IN ENTER ORDERS PAGE". Shown to everyone; usable by an administrator where
  // Product Master is written, and anyone else is told who can.
  it("shows New colour to anyone else turned off, saying who can add one", async () => {
    createFakeBackend();
    render(<NotificationsProvider><OrderEntryPage token="token-1" canCancel /></NotificationsProvider>);
    await pick("Party", /BEHRAAM SHOES/);
    await pick("Article", /SK6/);
    const add = await screen.findByRole("button", { name: "Add a new colour to SK6" });
    expect(add).toBeDisabled();
    expect(add).toHaveAccessibleDescription("New colours are added on PC1, by an administrator.");
  });
});
