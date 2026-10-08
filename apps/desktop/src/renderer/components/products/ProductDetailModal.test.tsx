import React from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProductDetailModal } from "./ProductDetailModal";
import type { InventoryRow, ProductRow } from "../../types/desktopApi";

const size = (id: string, sizeLabel: string, sellingPrice: number | null): ProductRow => ({
  id,
  productCode: `P-${id}`,
  article: "SK6",
  color: "",
  size: sizeLabel,
  description: null,
  costPrice: null,
  sellingPrice,
  mainGroupId: "mg-1",
  groupId: "pg-1",
  mainGroupName: "GENTS",
  groupName: "EVA",
  articleSeriesName: "CLASSIC",
  status: "ACTIVE",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
});

const stock = (sizeLabel: string, color: string, quantity: number): InventoryRow => ({
  productId: "x", article: "SK6", color, size: sizeLabel, quantity,
  costPrice: 0, sellingPrice: 0, stockValue: 0, potentialRevenue: 0, profitPotential: 0,
});

const sizes = [size("1", "4/6", 480), size("2", "7/10", 550), size("3", "11/13", 620)];
const inventory: Record<string, InventoryRow[]> = {
  "4/6": [stock("4/6", "BLUE", 144), stock("4/6", "RED", 36)],
  "7/10": [stock("7/10", "BLUE", 4)],
  "11/13": [],
};

function renderModal(overrides: Partial<React.ComponentProps<typeof ProductDetailModal>> = {}) {
  const onClose = vi.fn();
  const onEdit = vi.fn();
  render(
    <ProductDetailModal
      product={sizes[1]}
      sellingType="NORMAL"
      articleSizes={sizes}
      colors={["BLUE", "RED"]}
      totalStockCartons={184}
      imageUrl={null}
      stockRowsFor={(_article, sizeLabel) => inventory[sizeLabel] ?? []}
      onClose={onClose}
      onEdit={onEdit}
      {...overrides}
    />,
  );
  return { onClose, onEdit };
}

describe("ProductDetailModal", () => {
  it("shows the article, its classification, and one row per size with stock status and A/B prices", () => {
    renderModal();

    const dialog = screen.getByRole("dialog", { name: "SK6" });
    expect(within(dialog).getByText("GENTS")).toBeInTheDocument();
    expect(within(dialog).getByText("CLASSIC")).toBeInTheDocument();
    expect(within(dialog).getByText("A-Type")).toBeInTheDocument();
    expect(within(dialog).getByText("480 – 620")).toBeInTheDocument();

    const rows = within(dialog).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByText("BLUE")).toBeInTheDocument();
    expect(within(rows[0]).getByText("RED")).toBeInTheDocument();
    expect(within(rows[0]).getByText("In stock")).toBeInTheDocument();
    expect(within(rows[0]).getByText("480.00")).toBeInTheDocument();
    expect(within(rows[0]).getByText("330.00")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Low stock")).toBeInTheDocument();
    expect(within(rows[2]).getByText("Out of stock")).toBeInTheDocument();
  });

  it("closes on Escape, on the close button, and on the backdrop — but not on the card itself", async () => {
    const { onClose } = renderModal();
    expect(document.querySelector("[data-suppress-esc]")).not.toBeNull();

    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: /close product details/i }));
    expect(onClose).toHaveBeenCalledTimes(2);

    await userEvent.click(screen.getByRole("heading", { name: "SK6" }));
    expect(onClose).toHaveBeenCalledTimes(2);

    await userEvent.click(document.querySelector(".product-detail-backdrop") as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("hands the product id to onEdit", async () => {
    const { onEdit } = renderModal();
    await userEvent.click(screen.getByRole("button", { name: "Edit Product" }));
    expect(onEdit).toHaveBeenCalledWith("2");
  });
});
