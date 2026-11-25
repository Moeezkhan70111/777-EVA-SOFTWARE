import React from "react";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OrderDetails } from "./OrderDetails";
import type { CustomerOrder, CustomerOrderLine } from "../../types/desktopApi";

// A stored order reads like Pending Orders (owner, 25 Nov 2026): an article at a time, sizes down and colours across,
// so the store finds the article, then the size, then sees which colours are still owed.

const line = (id: string, article: string, color: string, size: string, quantity: number, dispatched: number, requested?: number): CustomerOrderLine => ({
  id, lineNo: 1, productVariantId: id, article, color, size, quantity, dispatched, pending: quantity - dispatched,
  ...(requested === undefined ? {} : { requested }),
});

const ORDER = {
  id: "order-1", orderNumber: 1, code: "ORD-000001", businessDate: "2026-11-25", partyId: "p1", partyName: "BEHRAAM SHOES", note: null,
  status: "OPEN", revision: 1, createdBy: "clerk", createdAt: "2026-11-25T09:00:00.000Z", updatedBy: null, updatedAt: null,
  cancelledBy: null, cancelledAt: null, cancelReason: null,
  totals: { ordered: 80, dispatched: 6, pending: 74 },
  lines: [
    line("a", "SK6", "BLACK", "7/10", 50, 0),
    line("b", "SK6", "RED", "7/10", 10, 0),
    line("c", "SK46", "BLACK", "4/6", 5, 0),
    line("d", "SK46", "BLACK", "1/3", 9, 6, 4),
    line("e", "SK46", "BLACK RED", "4/6", 6, 0),
  ],
} as unknown as CustomerOrder;

const show = () => render(<OrderDetails order={ORDER} busy={false} canEdit={false} canCancel={false} onEdit={() => undefined} onCancel={() => undefined} />);

describe("A stored order", () => {
  it("is shown an article at a time, sizes down and colours across, articles A to Z", () => {
    show();
    const articles = Array.from(document.querySelectorAll(".ord-matrix")).map((card) => card.getAttribute("aria-label"));
    expect(articles).toEqual(["SK6", "SK46"]);
    const sk46 = screen.getByRole("region", { name: "SK46" });
    expect(within(sk46).getAllByRole("rowheader").map((cell) => cell.textContent)).toEqual(["4/6", "1/3", "Total"]); // the store's size order (compareSizes), as on Carton Stock
    expect(within(sk46).getByLabelText("BLACK RED 1/3 not ordered").textContent).toBe("");
    expect(within(sk46).getByText("4")).toBeTruthy(); // BLACK: 3 + 5 cartons pending, 4 dozen
  });

  it("still says what was last typed when a gatepass had already sent more", () => {
    show();
    const cell = screen.getByLabelText(/^SK46 BLACK 1\/3: /);
    expect(cell.textContent).toBe("1.5"); // cartons shown as dozens
    expect(cell.getAttribute("title")).toContain("asked 2");
  });
});
