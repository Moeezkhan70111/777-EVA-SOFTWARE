import React from "react";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RawMaterialMovementConfigRow } from "../../types/desktopApi";
import { StockRow } from "./StockRow";

// A material on the Stock tab: nothing in store is said in words, and the grey total appears only
// when it says more than the figure on the shelf (a packet count, or a smaller unit).

const item = (onHand: number) => ({
  id: "i1",
  item_code: "RM-000371",
  display_name: "BUCKLES — D-BUCKLE — 1 INCH — DOUBLE PIROYI",
  top_category_name: "BUCKLES",
  sub_category_name: "D-BUCKLE",
  unit_code: "PAIRS",
  quantity_on_hand: onHand,
  cost_price: 12,
});

const renderRow = (onHand: number, config?: Partial<RawMaterialMovementConfigRow>) =>
  render(
    <ul>
      <StockRow
        item={item(onHand)}
        config={config as RawMaterialMovementConfigRow | undefined}
        ladder={[]}
        awaiting={false}
        incomplete={undefined}
        onOpen={vi.fn()}
      />
    </ul>
  );

describe("StockRow", () => {
  it("names the row in full, shows the code and the cost, and the figure on the shelf only once", () => {
    renderRow(4800);
    const row = screen.getByRole("listitem", { name: "BUCKLES — D-BUCKLE — 1 INCH — DOUBLE PIROYI" });
    expect(row).toHaveTextContent("RM-000371");
    expect(row).toHaveTextContent("Cost Rs. 12");
    expect(within(row).getByLabelText("In store: 4,800 PAIRS")).toBeInTheDocument();
    expect(within(row).queryByLabelText(/^Total quantity:/)).toBeNull();
    expect(within(row).queryByText("Out of stock")).toBeNull();
  });

  it("shows the measured total beside a packet count, since it says more", () => {
    renderRow(75, { packetsInStore: 3, packName: "BAG" });
    const row = screen.getByRole("listitem");
    expect(within(row).getByLabelText("In store: 3 BAGS")).toBeInTheDocument();
    expect(within(row).getByLabelText("Total quantity: 75 PAIRS")).toBeInTheDocument();
  });

  it("says Out of stock in words when nothing is in store", () => {
    renderRow(0);
    expect(screen.getByText("Out of stock")).toBeInTheDocument();
  });
});
