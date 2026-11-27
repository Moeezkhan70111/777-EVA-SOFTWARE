import { describe, expect, it } from "vitest";
import type { PendingOrderLine } from "../../types/desktopApi";
import { cellKey, newBlock, withProducts } from "./orderDraft";
import { pendingMatrix } from "./pendingMatrix";

const line = (article: string, color: string, size: string, ordered: number, dispatched: number, orderCodes = ["ORD-000001"]): PendingOrderLine => ({
  productVariantId: `${article}-${color}-${size}`, article, color, size, ordered, dispatched, pending: ordered - dispatched,
  progress: dispatched === 0 ? "PENDING" : dispatched === ordered ? "DISPATCHED" : "PARTIAL", orderCodes,
});

describe("pending orders as a matrix", () => {
  it("groups a party's lines by article, sizes in the store's order and colours across", () => {
    const [sk12, sk6] = pendingMatrix([
      line("SK6", "RED", "1/3", 5, 0),
      line("SK6", "BLUE", "7/10", 10, 4, ["ORD-000002"]),
      line("SK6", "RED", "4/6", 6, 6),
      line("SK6", "RED", "7/10", 20, 0),
      line("SK12", "BLACK", "7/10", 3, 0),
    ]).reverse();
    expect(sk6?.article).toBe("SK6");
    expect(sk6?.sizes.map((size) => size.size)).toEqual(["7/10", "4/6", "1/3"]);
    expect(sk6?.colours).toEqual(["BLUE", "RED"]);
    expect(sk6?.cells.get(cellKey("7/10", "BLUE"))?.pending).toBe(6);
    expect(sk6?.cells.has(cellKey("4/6", "BLUE"))).toBe(false);
    expect(sk6?.pending).toBe(31);
    expect(Object.fromEntries(sk6?.pendingByColour ?? [])).toEqual({ BLUE: 6, RED: 25 });
    expect(sk6?.orderCodes).toEqual(["ORD-000001", "ORD-000002"]);
    expect(sk12?.article).toBe("SK12");
  });

  it("orders articles by name, numbers naturally", () => {
    expect(pendingMatrix([line("SK12", "RED", "7/10", 1, 0), line("SK6", "RED", "7/10", 1, 0)]).map((group) => group.article)).toEqual(["SK6", "SK12"]);
  });
});

describe("a colour added to the article while ordering", () => {
  it("joins the article's products and opens as a column at once, keeping what was typed", () => {
    const before = { ...newBlock("SK6", [{ productVariantId: "red-7", size: "7/10", color: "RED" }]), colours: ["RED"], typed: { "red-7": "4" } };
    const after = withProducts(before, [{ productVariantId: "red-7", size: "7/10", color: "RED" }, { productVariantId: "green-7", size: "7/10", color: "GREEN" }]);
    expect(after.colours).toEqual(["GREEN", "RED"]);
    expect(after.products.map((product) => product.productVariantId)).toEqual(["red-7", "green-7"]);
    expect(after.typed).toEqual({ "red-7": "4" });
  });
});
