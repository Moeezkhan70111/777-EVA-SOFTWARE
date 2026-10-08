import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatepassPage } from "./GatepassPage";
import { NotificationsProvider } from "../state/NotificationsContext";
import { NotificationCenter } from "../components/layout/NotificationCenter";
import type { CreateGatepassResult, Gatepass, GatepassStockRow, Party } from "../types/desktopApi";

// The page is driven exactly as a clerk writes the Gatepass: pick the party, add an
// article, type cartons against each colour, create, print. The fake backend answers like
// the real CreateGatepassUseCase does — including refusing a document when the store
// changed — so the page is tested against real outcomes, not canned strings.

const PARTIES: Party[] = [
  { id: "p-abc", partyCode: "P-0001", partyName: "ABC TRADERS", partyType: "CUSTOMER", city: "Lahore", status: "ACTIVE", createdAt: "2026-01-01T00:00:00.000Z" },
  { id: "p-xyz", partyCode: "P-0002", partyName: "XYZ TRADERS", partyType: "CUSTOMER", city: "Karachi", status: "ACTIVE", createdAt: "2026-01-01T00:00:00.000Z" },
];

// The whole store: SK6 in two sizes and three colours, SK12 in one size, one colour.
// Deliberately out of order, so the draft's own ordering is what is asserted. Nothing is
// reserved yet, so Reflected Stock equals Current Stock; the reservation tests set their own.
const GROUPS: Record<string, string> = { SK6: "EVR GENTS", SK12: "PVC LADIES" };
const stockRow = (productVariantId: string, article: string, color: string, size: string, storeQuantity: number, reservedQuantity = 0): GatepassStockRow => ({
  productVariantId,
  article,
  color,
  size,
  groupName: GROUPS[article] ?? null,
  storeQuantity,
  reservedQuantity,
  reflectedQuantity: storeQuantity - reservedQuantity,
});
const STOCK: GatepassStockRow[] = [
  stockRow("v-sk12-black-46", "SK12", "BLACK", "4/6", 40),
  stockRow("v-sk6-red-710", "SK6", "RED", "7/10", 120),
  stockRow("v-sk6-red-46", "SK6", "RED", "4/6", 50),
  stockRow("v-sk6-blue-710", "SK6", "BLUE", "7/10", 80),
  stockRow("v-sk6-navy-46", "SK6", "NAVY", "4/6", 15),
];

const SK6_IMAGE = "data:image/png;base64,c2s2";

/** A stored document as the backend returns it, numbered in creation order. */
const makeDocument = (gatepassNumber: number, input: any, stock: GatepassStockRow[], status: Gatepass["status"] = "CREATED"): Gatepass => {
  const lines = input.lines.map((l: any, idx: number) => {
    const row = stock.find((r) => r.productVariantId === l.productVariantId)!;
    return { id: `l-${gatepassNumber}-${idx}`, lineNo: idx + 1, productVariantId: l.productVariantId, article: row.article, color: row.color, size: row.size, groupName: row.groupName, quantity: l.quantity, storeQuantityAtCreation: row.storeQuantity, dispatchedFromStoreQuantity: 0, outstandingQuantity: l.quantity };
  });
  const party = PARTIES.find((p) => p.id === input.partyId)!;
  return {
    id: `gp-${gatepassNumber}`, code: `GP-${String(gatepassNumber).padStart(6, "0")}`, gatepassNumber, partyId: party.id, partyName: party.partyName, partyCode: party.partyCode, partyCity: party.city ?? null,
    gatepassDate: "2026-09-16", status, biltyNumber: input.biltyNumber ?? null, transportVia: input.transportVia ?? null, remarks: input.remarks ?? null,
    totalQuantity: lines.reduce((s: number, l: any) => s + l.quantity, 0), dispatchedFromStoreQuantity: 0, outstandingQuantity: lines.reduce((s: number, l: any) => s + l.quantity, 0), lineCount: lines.length,
    createdBy: "clerk", createdAt: "2026-09-16T10:00:00.000Z", updatedAt: "2026-09-16T10:00:00.000Z",
    cancelledAt: status === "CANCELLED" ? "2026-09-17T08:00:00.000Z" : null, cancelledBy: status === "CANCELLED" ? "owner" : null, cancelReason: status === "CANCELLED" ? "Wrong party" : null, lines,
  };
};

function createFakeBackend(opts: { stock?: GatepassStockRow[]; createResult?: (input: any) => CreateGatepassResult; existing?: Gatepass[] } = {}) {
  let stock = opts.stock ?? STOCK;
  const created: any[] = [];
  /** Every stored document by number — what previous / next / load walk through. */
  const documents = new Map<number, Gatepass>((opts.existing ?? []).map((d) => [d.gatepassNumber, d]));
  const latestNumber = () => Math.max(0, ...documents.keys());

  const createGatepass = vi.fn(async (input: any, _opts?: { token?: string }): Promise<CreateGatepassResult> => {
    if (opts.createResult) return opts.createResult(input);
    created.push(input);
    const document = makeDocument(latestNumber() + 1, input, stock);
    documents.set(document.gatepassNumber, document);
    return { accepted: true, outcome: "CREATED", gatepassId: document.id, gatepassNumber: document.gatepassNumber, code: document.code, totalQuantity: document.totalQuantity, createdAt: document.createdAt };
  });

  const api = {
    listParties: vi.fn(async () => ({ rows: PARTIES, total: PARTIES.length, page: 1, pageSize: 1000 })),
    listGatepassStoreStock: vi.fn(async () => ({ accepted: true, rows: stock.map((r) => ({ ...r })) })),
    getCurrentPartyBalance: vi.fn(async (partyId: string) => (partyId === "p-abc" ? 185000 : -2500)),
    getProductImage: vi.fn(async (article: string) => (article === "SK6" ? SK6_IMAGE : null)),
    createGatepass,
    getGatepass: vi.fn(async (id: string): Promise<Gatepass | null> => [...documents.values()].find((d) => d.id === id) ?? null),
    getGatepassByNumber: vi.fn(async (gatepassNumber: number): Promise<Gatepass | null> => documents.get(gatepassNumber) ?? null),
    // Newest first, like the real list — the first row carries the highest number.
    listGatepasses: vi.fn(async (query: { page?: number; pageSize?: number }) => {
      const rows = [...documents.values()].sort((a, b) => b.gatepassNumber - a.gatepassNumber).slice(0, query.pageSize ?? 25);
      return { rows, total: documents.size, page: 1, pageSize: query.pageSize ?? 25 };
    }),
  };

  Object.defineProperty(window, "desktop", {
    value: { versions: { node: "22", chrome: "128", electron: "43" }, api },
    configurable: true,
  });

  return { api, created, setStock: (next: GatepassStockRow[]) => { stock = next; } };
}

const renderPage = (onNavigate = vi.fn()) => {
  const utils = render(
    <NotificationsProvider>
      <GatepassPage token="token-1" username="clerk" onNavigate={onNavigate} />
      <NotificationCenter />
    </NotificationsProvider>
  );
  return { ...utils, onNavigate };
};

/** Opens the party select, types, and picks the first match. */
const chooseParty = async (text: string) => {
  const input = screen.getByLabelText("Party") as HTMLInputElement;
  await act(async () => {
    fireEvent.change(input, { target: { value: text } });
  });
  const container = input.closest(".gp-select") as HTMLElement;
  const listbox = await within(container).findByRole("listbox");
  const option = within(listbox).getAllByRole("option")[0];
  await act(async () => {
    fireEvent.mouseDown(option);
  });
};

/** Clicks "+ Add Article", types, and picks the first match. */
const addArticle = async (text: string) => {
  await act(async () => {
    fireEvent.click(screen.getByTestId("gatepass-add-article"));
  });
  const picker = await screen.findByTestId("gatepass-article-picker");
  const input = within(picker).getByLabelText("Search article");
  await act(async () => {
    fireEvent.change(input, { target: { value: text } });
  });
  const option = within(await within(picker).findByRole("listbox")).getAllByRole("option")[0];
  await act(async () => {
    fireEvent.mouseDown(option);
  });
};

/** The accessible name of a quantity box: the product in full, group included. */
const productName = (article: string, color: string, size: string) => [article, GROUPS[article], color, size].filter(Boolean).join(" ");
const qty = (article: string, color: string, size: string) => screen.getByLabelText(`Quantity for ${productName(article, color, size)}`) as HTMLInputElement;

const typeQty = async (article: string, color: string, size: string, value: string) => {
  const input = qty(article, color, size);
  await act(async () => {
    fireEvent.change(input, { target: { value } });
  });
  return input;
};

const card = (key: string) => screen.getByTestId(`gatepass-article-${key}`);
const isExpanded = (key: string) => within(card(key)).getByRole("button", { expanded: true }) !== null;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GatepassPage", () => {
  it("opens on the party with the store loaded, nothing added and Create disabled", async () => {
    const { api } = createFakeBackend();
    renderPage();

    await screen.findByTestId("gatepass-articles-section");
    await waitFor(() => expect(api.listGatepassStoreStock).toHaveBeenCalledWith({ token: "token-1" }));
    expect(await screen.findByText("No articles added")).toBeInTheDocument();
    expect(screen.getByTestId("gatepass-summary-total")).toHaveTextContent("0");
    expect(screen.getByTestId("gatepass-summary-counts")).toHaveTextContent("0 Articles · 0 Colors");
    expect(screen.getByTestId("gatepass-summary-party")).toHaveTextContent("No party selected");
    expect(screen.getByTestId("gatepass-create")).toBeDisabled();
    expect(screen.getByTestId("gatepass-blocker")).toHaveTextContent("Select a party first.");
  });

  it("shows a clear empty state when the store holds nothing", async () => {
    createFakeBackend({ stock: [] });
    renderPage();
    expect(await screen.findByText("The store holds no stock right now")).toBeInTheDocument();
    expect(screen.getByTestId("gatepass-add-article")).toBeDisabled();
  });

  it("shows the chosen party with its city and current balance", async () => {
    const { api } = createFakeBackend();
    renderPage();
    await screen.findByTestId("gatepass-articles-section");
    await chooseParty("abc");

    const partyCard = await screen.findByTestId("party-card");
    expect(partyCard).toHaveTextContent("ABC TRADERS");
    expect(partyCard).toHaveTextContent("P-0001 · Lahore");
    expect(partyCard).toHaveTextContent("Current Balance");
    await waitFor(() => expect(screen.getByTestId("party-balance")).toHaveTextContent("Rs 185,000"));
    expect(api.getCurrentPartyBalance).toHaveBeenCalledWith("p-abc");
    expect(screen.getByTestId("gatepass-summary-party")).toHaveTextContent("ABC TRADERS · Lahore");
    expect(screen.getByTestId("gatepass-blocker")).toHaveTextContent("Add an article and enter at least one quantity.");

    // A party that has paid ahead is shown as a credit, not as a bare number.
    await chooseParty("xyz");
    await waitFor(() => expect(screen.getByTestId("party-balance")).toHaveTextContent("Rs 2,500 Cr"));
  });

  it("adds an article + size as an open card with every colour in store, keeps one card open at a time, and never adds the same one twice", async () => {
    createFakeBackend();
    renderPage();
    await screen.findByTestId("gatepass-articles-section");

    await addArticle("sk6 7/10");
    const sk6 = card("SK6-7/10");
    expect(isExpanded("SK6-7/10")).toBe(true);
    // Colours in natural order with their In Store cartons; a colour the article does not come in is absent.
    const rows = within(sk6).getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getAllByRole("cell").slice(0, 2).map((c) => c.textContent))).toEqual([
      ["BLUE", "80"],
      ["RED", "120"],
    ]);
    expect(screen.queryByLabelText("Quantity for SK6 EVR GENTS NAVY 7/10")).not.toBeInTheDocument();

    // The second article opens and the first closes into one line.
    await addArticle("sk12");
    expect(isExpanded("SK12-4/6")).toBe(true);
    expect(within(card("SK6-7/10")).getByRole("button", { expanded: false })).toBeInTheDocument();
    expect(screen.getByTestId("gatepass-article-meta-SK6-7/10")).toHaveTextContent("No quantity entered");
    expect(screen.queryByLabelText("Quantity for SK6 EVR GENTS RED 7/10")).not.toBeInTheDocument();

    // Adding SK6 · 7/10 again just re-opens it.
    await addArticle("sk6 7/10");
    expect(screen.getAllByTestId(/^gatepass-article-SK/)).toHaveLength(2);
    expect(isExpanded("SK6-7/10")).toBe(true);
    expect(within(card("SK12-4/6")).getByRole("button", { expanded: false })).toBeInTheDocument();

    // Clicking a closed card opens it and closes the other.
    await act(async () => {
      fireEvent.click(within(card("SK12-4/6")).getByRole("button", { expanded: false }));
    });
    expect(isExpanded("SK12-4/6")).toBe(true);
    expect(within(card("SK6-7/10")).getByRole("button", { expanded: false })).toBeInTheDocument();
  });

  it("adds up per article, per colour and overall as quantities are typed, live in the summary", async () => {
    createFakeBackend();
    renderPage();
    await screen.findByTestId("gatepass-articles-section");
    await chooseParty("abc");

    await addArticle("sk6 7/10");
    await typeQty("SK6", "RED", "7/10", "50");
    await typeQty("SK6", "BLUE", "7/10", "20");
    await addArticle("sk12");
    await typeQty("SK12", "BLACK", "4/6", "5");

    expect(screen.getByTestId("gatepass-article-meta-SK6-7/10")).toHaveTextContent("2 colors selected · Total Qty: 70");
    const summary = screen.getByTestId("gatepass-summary");
    const sk6Summary = within(summary).getByTestId("gatepass-summary-SK6-7/10");
    expect(sk6Summary).toHaveTextContent("SK6 EVR GENTS · 7/10");
    expect(sk6Summary).toHaveTextContent("Total 70");
    expect(within(sk6Summary).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["BLUE20", "RED50"]);
    expect(within(summary).getByTestId("gatepass-summary-SK12-4/6")).toHaveTextContent("Total 5");
    expect(screen.getByTestId("gatepass-summary-counts")).toHaveTextContent("2 Articles · 3 Colors");
    expect(screen.getByTestId("gatepass-summary-total")).toHaveTextContent("75");
    expect(screen.getByTestId("gatepass-create")).toBeEnabled();
    expect(screen.queryByTestId("gatepass-blocker")).not.toBeInTheDocument();

    // Zero means "not selected": the colour leaves the summary, the article stays.
    await typeQty("SK12", "BLACK", "4/6", "0");
    expect(within(summary).queryByTestId("gatepass-summary-SK12-4/6")).not.toBeInTheDocument();
    expect(screen.getByTestId("gatepass-summary-counts")).toHaveTextContent("1 Article · 2 Colors");
    expect(screen.getByTestId("gatepass-summary-total")).toHaveTextContent("70");
    expect(card("SK12-4/6")).toBeInTheDocument();
  });

  it("steps one carton at a time with − / + and stops at 0 and at what the store holds", async () => {
    createFakeBackend();
    renderPage();
    await screen.findByTestId("gatepass-articles-section");
    await addArticle("sk6 4/6");

    const minus = screen.getByLabelText("Decrease SK6 EVR GENTS NAVY 4/6");
    const plus = screen.getByLabelText("Increase SK6 EVR GENTS NAVY 4/6");
    expect(minus).toBeDisabled();
    await act(async () => {
      fireEvent.click(plus);
    });
    expect(qty("SK6", "NAVY", "4/6").value).toBe("1");
    expect(minus).toBeEnabled();

    await typeQty("SK6", "NAVY", "4/6", "14");
    await act(async () => {
      fireEvent.click(plus);
    });
    expect(qty("SK6", "NAVY", "4/6").value).toBe("15");
    expect(plus).toBeDisabled();

    await act(async () => {
      fireEvent.click(minus);
    });
    expect(qty("SK6", "NAVY", "4/6").value).toBe("14");
    expect(screen.getByTestId("gatepass-summary-total")).toHaveTextContent("14");
  });

  it("shows Current Stock, Reserved and Reflected Stock per colour, caps the quantity at Reflected Stock — not at what is physically in the store — and sends the Reflected figure it showed", async () => {
    // SK6 RED 7/10: 5 physically in store, 4 promised to other open gatepasses → 1 may go on this one.
    const { api, created } = createFakeBackend({
      stock: [stockRow("v-sk6-red-710", "SK6", "RED", "7/10", 5, 4), stockRow("v-sk6-blue-710", "SK6", "BLUE", "7/10", 3, 3)],
    });
    renderPage();
    await screen.findByTestId("gatepass-articles-section");
    await chooseParty("abc");
    await addArticle("sk6 7/10");

    const cardEl = card("SK6-7/10");
    expect(within(cardEl).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Color", "Current Stock", "Reserved", "Reflected Stock", "Gatepass Qty"]);
    expect(screen.getByTestId("current-SK6-RED-7/10")).toHaveTextContent("5");
    expect(screen.getByTestId("reserved-SK6-RED-7/10")).toHaveTextContent("4");
    expect(screen.getByTestId("available-SK6-RED-7/10")).toHaveTextContent("1");
    // A fully reserved colour stays visible, says so, and takes nothing.
    expect(screen.getByTestId("available-SK6-BLUE-7/10")).toHaveTextContent("0Fully reserved");
    expect(screen.getByRole("button", { name: "Increase SK6 EVR GENTS BLUE 7/10" })).toBeDisabled();

    // 2 is refused although 5 are physically there; 1 is allowed, and + stops at 1.
    await typeQty("SK6", "RED", "7/10", "2");
    expect(await screen.findByRole("alert")).toHaveTextContent("Only 1 available (Reflected Stock)");
    expect(screen.getByTestId("gatepass-create")).toBeDisabled();
    await typeQty("SK6", "RED", "7/10", "1");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Increase SK6 EVR GENTS RED 7/10" })).toBeDisabled();
    expect(screen.getByTestId("gatepass-create")).toBeEnabled();

    await act(async () => {
      fireEvent.click(screen.getByTestId("gatepass-create"));
    });
    await waitFor(() => expect(api.createGatepass).toHaveBeenCalledTimes(1));
    expect(created[0].lines).toEqual([{ productVariantId: "v-sk6-red-710", quantity: 1, reflectedStockSeen: 1 }]);
  });

  it("refuses more than Reflected Stock with an inline error on the row, and blocks Create until it is fixed", async () => {
    createFakeBackend();
    renderPage();
    await screen.findByTestId("gatepass-articles-section");
    await chooseParty("abc");
    await addArticle("sk6 7/10");

    await typeQty("SK6", "RED", "7/10", "130");
    expect(await screen.findByRole("alert")).toHaveTextContent("Only 120 available (Reflected Stock)");
    expect(qty("SK6", "RED", "7/10")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByTestId("gatepass-create")).toBeDisabled();
    expect(screen.getByTestId("gatepass-blocker")).toHaveTextContent("Fix the highlighted quantities first.");
    // A bad line never counts towards the document.
    expect(screen.getByTestId("gatepass-summary-total")).toHaveTextContent("0");

    await typeQty("SK6", "RED", "7/10", "-5");
    expect(screen.getByRole("alert")).toHaveTextContent("Quantity cannot be negative.");
    await typeQty("SK6", "RED", "7/10", "2.5");
    expect(screen.getByRole("alert")).toHaveTextContent("Enter whole cartons only.");

    // A closed card with a problem says so on its one line.
    await addArticle("sk12");
    expect(screen.getByTestId("gatepass-article-meta-SK6-7/10")).toHaveTextContent("1 quantity needs attention");

    await act(async () => {
      fireEvent.click(within(card("SK6-7/10")).getByRole("button", { expanded: false }));
    });
    await typeQty("SK6", "RED", "7/10", "120");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByTestId("gatepass-summary-total")).toHaveTextContent("120");
    expect(screen.getByTestId("gatepass-create")).toBeEnabled();
  });

  it("removes an article together with its quantities", async () => {
    createFakeBackend();
    renderPage();
    await screen.findByTestId("gatepass-articles-section");
    await addArticle("sk6 7/10");
    await typeQty("SK6", "RED", "7/10", "10");
    await addArticle("sk12");
    await typeQty("SK12", "BLACK", "4/6", "3");
    expect(screen.getByTestId("gatepass-summary-total")).toHaveTextContent("13");

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Remove SK6 EVR GENTS · 7/10"));
    });
    expect(screen.queryByTestId("gatepass-article-SK6-7/10")).not.toBeInTheDocument();
    expect(screen.queryByTestId("gatepass-summary-SK6-7/10")).not.toBeInTheDocument();
    expect(screen.getByTestId("gatepass-summary-total")).toHaveTextContent("3");

    // Added back, it starts clean.
    await addArticle("sk6 7/10");
    expect(qty("SK6", "RED", "7/10").value).toBe("");
  });

  it("shows the article's image from the product image store, and says so when there is none", async () => {
    const { api } = createFakeBackend();
    renderPage();
    await screen.findByTestId("gatepass-articles-section");
    await addArticle("sk6 7/10");
    await addArticle("sk12");

    await waitFor(() => expect(api.getProductImage).toHaveBeenCalledWith("SK6"));
    const image = await within(card("SK6-7/10")).findByRole("img");
    expect(image).toHaveAttribute("src", SK6_IMAGE);
    expect(image).toHaveAttribute("alt", "SK6 product");
    expect(await within(card("SK12-4/6")).findByText("Image not found")).toBeInTheDocument();
    expect(within(card("SK12-4/6")).queryByRole("img")).not.toBeInTheDocument();
  });

  it("creates the document with every line in document order, bilty, via and remarks; no rate, discount or amount is ever sent", async () => {
    const { api, created } = createFakeBackend();
    const { onNavigate } = renderPage();
    await screen.findByTestId("gatepass-articles-section");
    await chooseParty("abc");

    await addArticle("sk12");
    await typeQty("SK12", "BLACK", "4/6", "30");
    await addArticle("sk6 7/10");
    await typeQty("SK6", "RED", "7/10", "50");
    await typeQty("SK6", "BLUE", "7/10", "20");
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Bilty No."), { target: { value: " B-4471 " } });
      fireEvent.change(screen.getByLabelText("Via"), { target: { value: "Daewoo Cargo" } });
      fireEvent.change(screen.getByLabelText("Remarks"), { target: { value: "Vehicle LEA-1234" } });
    });
    expect(screen.getByTestId("gatepass-summary").textContent).not.toMatch(/rate|discount|amount/i);

    await act(async () => {
      fireEvent.click(screen.getByTestId("gatepass-create"));
    });

    await waitFor(() => expect(api.createGatepass).toHaveBeenCalledTimes(1));
    expect(created[0]).toEqual({
      partyId: "p-abc",
      lines: [
        { productVariantId: "v-sk6-blue-710", quantity: 20, reflectedStockSeen: 80 },
        { productVariantId: "v-sk6-red-710", quantity: 50, reflectedStockSeen: 120 },
        { productVariantId: "v-sk12-black-46", quantity: 30, reflectedStockSeen: 40 },
      ],
      biltyNumber: "B-4471",
      transportVia: "Daewoo Cargo",
      remarks: "Vehicle LEA-1234",
    });
    expect(api.createGatepass.mock.calls[0][1]).toEqual({ token: "token-1" });
    expect(JSON.stringify(created[0])).not.toMatch(/rate|discount|amount|qrId/i);

    // The stored document takes the draft's place, read-only, in the same two columns.
    const document = await screen.findByTestId("gatepass-document");
    expect(screen.getByTestId("gatepass-title")).toHaveTextContent("Gatepass GP-000001");
    expect(screen.getByText("Gatepass Issued", { selector: ".badge" })).toBeInTheDocument();
    expect(within(document).getByTestId("party-card")).toHaveTextContent("ABC TRADERS");
    const facts = within(document).getByTestId("gatepass-document-facts");
    expect(facts).toHaveTextContent(/16 Sept? 2026/);
    expect(facts).toHaveTextContent("clerk");
    expect(facts).toHaveTextContent("B-4471");
    expect(facts).toHaveTextContent("Daewoo Cargo");
    expect(facts).toHaveTextContent("Vehicle LEA-1234");
    // Cards in document order, the first open with its quantities and no way to change them.
    expect(screen.getAllByTestId(/^gatepass-article-SK/).map((el) => el.getAttribute("data-testid"))).toEqual(["gatepass-article-SK6-7/10", "gatepass-article-SK12-4/6"]);
    expect(screen.getByTestId("qty-SK6-BLUE-7/10")).toHaveTextContent("20");
    expect(screen.getByTestId("qty-SK6-RED-7/10")).toHaveTextContent("50");
    expect(screen.getByTestId("available-SK6-RED-7/10")).toHaveTextContent("120");
    expect(screen.queryByLabelText(/^Quantity for/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Remove/)).not.toBeInTheDocument();
    expect(screen.getByTestId("gatepass-article-meta-SK12-4/6")).toHaveTextContent("1 color selected · Total Qty: 30");
    expect(screen.getByTestId("gatepass-summary-total")).toHaveTextContent("100");
    expect(screen.getByTestId("gatepass-summary-counts")).toHaveTextContent("2 Articles · 3 Colors");
    expect(screen.getByTestId("gatepass-summary-party")).toHaveTextContent("ABC TRADERS · Lahore");
    expect((screen.getByTestId("gatepass-number-input") as HTMLInputElement).value).toBe("1");
    expect(screen.queryByTestId("gatepass-create")).not.toBeInTheDocument();
    expect(screen.getByTestId("gatepass-print")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByText("Open in list"));
    });
    expect(onNavigate).toHaveBeenCalledWith("gatepass-list", "gp-1");

    // New Gatepass: a clean page, stock re-read from the store.
    const stockCalls = api.listGatepassStoreStock.mock.calls.length;
    await act(async () => {
      fireEvent.click(screen.getByTestId("gatepass-new"));
    });
    await screen.findByTestId("gatepass-articles-section");
    await waitFor(() => expect(api.listGatepassStoreStock.mock.calls.length).toBe(stockCalls + 1));
    expect(screen.getByTestId("gatepass-summary-total")).toHaveTextContent("0");
    expect(screen.getByTestId("gatepass-summary-party")).toHaveTextContent("No party selected");
    expect(screen.getByTestId("gatepass-create")).toBeDisabled();
    expect((screen.getByLabelText("Bilty No.") as HTMLInputElement).value).toBe("");
    // The number box is never blank: on a new document it shows the number that document
    // will get, which is what the desk writes on the paper before anything is saved.
    expect((screen.getByTestId("gatepass-number-input") as HTMLInputElement).value).toBe("2");
    expect(screen.getByTestId("gatepass-number-input").closest(".gp-nav-field")?.textContent).toContain("new");
  });

  it("walks stored documents with ‹ › and Load, keeps the draft underneath, and says so when a number does not exist", async () => {
    const existing = [
      makeDocument(1, { partyId: "p-abc", lines: [{ productVariantId: "v-sk6-red-710", quantity: 5 }] }, STOCK),
      makeDocument(2, { partyId: "p-xyz", lines: [{ productVariantId: "v-sk12-black-46", quantity: 7 }], biltyNumber: "B-2" }, STOCK, "CANCELLED"),
    ];
    const { api } = createFakeBackend({ existing });
    renderPage();
    await screen.findByTestId("gatepass-articles-section");
    await waitFor(() => expect(api.listGatepasses).toHaveBeenCalledWith({ page: 1, pageSize: 1 }, { token: "token-1" }));

    // Something in progress, so we can check it survives a look at old documents.
    await addArticle("sk6 4/6");
    await typeQty("SK6", "NAVY", "4/6", "3");

    // ‹ from a new document opens the latest one.
    expect(screen.getByTestId("gatepass-next")).toBeDisabled();
    await act(async () => {
      fireEvent.click(screen.getByTestId("gatepass-prev"));
    });
    await screen.findByTestId("gatepass-document");
    expect(api.getGatepassByNumber).toHaveBeenCalledWith(2, { token: "token-1" });
    expect(screen.getByTestId("gatepass-title")).toHaveTextContent("Gatepass GP-000002");
    expect(screen.getByText("Cancelled", { selector: ".badge" })).toBeInTheDocument();
    expect(screen.getByTestId("gatepass-cancelled-banner")).toHaveTextContent("owner");
    expect(screen.getByTestId("gatepass-cancelled-banner")).toHaveTextContent("Wrong party");
    expect(screen.getByTestId("gatepass-summary-party")).toHaveTextContent("XYZ TRADERS · Karachi");
    expect(screen.getByTestId("gatepass-summary-total")).toHaveTextContent("7");

    // ‹ again: the one before; at #1 there is nothing earlier.
    await act(async () => {
      fireEvent.click(screen.getByTestId("gatepass-prev"));
    });
    await waitFor(() => expect(screen.getByTestId("gatepass-title")).toHaveTextContent("Gatepass GP-000001"));
    expect(screen.getByTestId("gatepass-prev")).toBeDisabled();
    expect(screen.getByTestId("qty-SK6-RED-7/10")).toHaveTextContent("5");

    // Load by typed number.
    await act(async () => {
      fireEvent.change(screen.getByTestId("gatepass-number-input"), { target: { value: "2" } });
      fireEvent.click(screen.getByTestId("gatepass-load"));
    });
    await waitFor(() => expect(screen.getByTestId("gatepass-title")).toHaveTextContent("Gatepass GP-000002"));

    // A number that does not exist: told, and the screen stays where it was.
    await act(async () => {
      fireEvent.change(screen.getByTestId("gatepass-number-input"), { target: { value: "9" } });
      fireEvent.keyDown(screen.getByTestId("gatepass-number-input"), { key: "Enter" });
    });
    expect(await screen.findByText("Gatepass #9 does not exist")).toBeInTheDocument();
    expect(screen.getByTestId("gatepass-title")).toHaveTextContent("Gatepass GP-000002");

    // › past the latest document: back to the draft, exactly as it was left.
    await act(async () => {
      fireEvent.click(screen.getByTestId("gatepass-next"));
    });
    await screen.findByTestId("gatepass-articles-section");
    expect(screen.getByTestId("gatepass-title")).toHaveTextContent("Gatepass");
    expect(qty("SK6", "NAVY", "4/6").value).toBe("3");
    expect(screen.getByTestId("gatepass-summary-total")).toHaveTextContent("3");
    // Back on the draft, the box shows the number it will be saved as: after #1 and #2, #3.
    expect((screen.getByTestId("gatepass-number-input") as HTMLInputElement).value).toBe("3");
  });

  it("writes the next number in the box by itself, and says whether it exists yet", async () => {
    const existing = [
      makeDocument(1, { partyId: "p-abc", lines: [{ productVariantId: "v-sk6-red-710", quantity: 5 }] }, STOCK),
      makeDocument(2, { partyId: "p-xyz", lines: [{ productVariantId: "v-sk12-black-46", quantity: 7 }] }, STOCK),
    ];
    const { api } = createFakeBackend({ existing });
    renderPage();
    await screen.findByTestId("gatepass-articles-section");

    // A new document: the number it WILL get (latest 2 + 1), marked as not saved yet.
    const box = () => screen.getByTestId("gatepass-number-input") as HTMLInputElement;
    const field = () => box().closest(".gp-nav-field") as HTMLElement;
    await waitFor(() => expect(box().value).toBe("3"));
    expect(field().textContent).toContain("new");

    // Load on the untouched box must not report #3 as missing — it is this document.
    await act(async () => {
      fireEvent.click(screen.getByTestId("gatepass-load"));
    });
    expect(api.getGatepassByNumber).not.toHaveBeenCalled();
    expect(screen.queryByText("Gatepass #3 does not exist")).toBeNull();

    // Overtype it with a number that does exist and Load opens that document.
    await act(async () => {
      fireEvent.change(box(), { target: { value: "1" } });
      fireEvent.click(screen.getByTestId("gatepass-load"));
    });
    await waitFor(() => expect(screen.getByTestId("gatepass-title")).toHaveTextContent("Gatepass GP-000001"));
    expect(api.getGatepassByNumber).toHaveBeenCalledWith(1, { token: "token-1" });
    // On a stored document the count replaces the "new" marker.
    expect(box().value).toBe("1");
    expect(field().textContent).toContain("of 2");
  });

  it("asks before New Gatepass throws away a document in progress", async () => {
    createFakeBackend();
    renderPage();
    await screen.findByTestId("gatepass-articles-section");
    await addArticle("sk12");
    await typeQty("SK12", "BLACK", "4/6", "3");

    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await act(async () => {
      fireEvent.click(screen.getByTestId("gatepass-new"));
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(qty("SK12", "BLACK", "4/6").value).toBe("3");

    confirm.mockReturnValue(true);
    await act(async () => {
      fireEvent.click(screen.getByTestId("gatepass-new"));
    });
    expect(screen.queryByTestId("gatepass-article-SK12-4/6")).not.toBeInTheDocument();
    expect(await screen.findByText("No articles added")).toBeInTheDocument();
  });

  it("when the backend reports Reflected Stock changed, stays on the document with the live figures in the row and the exact reason", async () => {
    let calls = 0;
    const backend = createFakeBackend({
      createResult: () => {
        calls += 1;
        // Another clerk reserved 40 cartons while this one was working: Current 120, Reserved 40, Reflected 80.
        backend.setStock(STOCK.map((r) => (r.productVariantId === "v-sk6-red-710" ? stockRow("v-sk6-red-710", "SK6", "RED", "7/10", 120, 40) : r)));
        return {
          accepted: false,
          outcome: "STOCK_CHANGED",
          reason: "Reflected Stock changed before the Gatepass could be created. Please review the latest figures.",
          shortages: [{ productVariantId: "v-sk6-red-710", article: "SK6", color: "RED", size: "7/10", requested: 100, currentStock: 120, reserved: 40, reflected: 80, seen: 120 }],
        };
      },
    });
    renderPage();
    await screen.findByTestId("gatepass-articles-section");
    await chooseParty("abc");
    await addArticle("sk6 7/10");
    await typeQty("SK6", "RED", "7/10", "100");
    await addArticle("sk12");
    await typeQty("SK12", "BLACK", "4/6", "10");
    const stockCallsBefore = backend.api.listGatepassStoreStock.mock.calls.length;

    await act(async () => {
      fireEvent.click(screen.getByTestId("gatepass-create"));
    });

    const alert = await screen.findByTestId("gatepass-submit-error");
    expect(alert).toHaveTextContent("Reflected Stock changed before the Gatepass could be created.");
    expect(alert).toHaveTextContent("SK6 / RED / 7/10 — Current Stock 120, Reserved 40, Reflected Stock 80, Requested 100 (you saw 120)");
    expect(calls).toBe(1);
    expect(screen.queryByTestId("gatepass-document")).not.toBeInTheDocument();
    // The store is re-read, the short article is opened, its row validates against 80, the other line is untouched.
    await waitFor(() => expect(backend.api.listGatepassStoreStock.mock.calls.length).toBe(stockCallsBefore + 1));
    expect(isExpanded("SK6-7/10")).toBe(true);
    expect(await screen.findByText(/Only 80 available/)).toBeInTheDocument();
    expect(screen.getByTestId("current-SK6-RED-7/10")).toHaveTextContent("120");
    expect(screen.getByTestId("reserved-SK6-RED-7/10")).toHaveTextContent("40");
    expect(screen.getByTestId("available-SK6-RED-7/10")).toHaveTextContent("80");
    expect(qty("SK6", "RED", "7/10").value).toBe("100");
    expect(screen.getByTestId("gatepass-article-meta-SK12-4/6")).toHaveTextContent("Total Qty: 10");
    expect(screen.getByTestId("gatepass-create")).toBeDisabled();
  });

  it("surfaces an authorisation refusal without pretending anything was created", async () => {
    createFakeBackend({ createResult: () => ({ accepted: false, outcome: "NOT_AUTHORIZED", reason: "Your account does not have Gatepass access." }) });
    renderPage();
    await screen.findByTestId("gatepass-articles-section");
    await chooseParty("xyz");
    await addArticle("sk12");
    await typeQty("SK12", "BLACK", "4/6", "1");
    await act(async () => {
      fireEvent.click(screen.getByTestId("gatepass-create"));
    });
    expect(await screen.findByTestId("gatepass-submit-error")).toHaveTextContent("Your account does not have Gatepass access.");
    expect(screen.queryByTestId("gatepass-document")).not.toBeInTheDocument();
  });
});
