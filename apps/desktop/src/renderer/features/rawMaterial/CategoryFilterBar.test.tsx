import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CategoryFilterBar } from "./CategoryFilterBar";
import type { CategoryRow } from "./rawMaterial";

// The Stock tab's categories as buttons: every category in a row, and under a chosen one a second
// row with everything beneath it, however deep, named by its path below the category.

const CATEGORIES = [
  { id: "c-acc", name: "ACCESSORY", path_name: "ACCESSORY" },
  { id: "c-dana", name: "DANA", path_name: "DANA" },
  { id: "c-tag", name: "TAG", parent_id: "c-acc", path_name: "ACCESSORY — TAG" },
  { id: "c-rtag", name: "RUBBER TAG", parent_id: "c-tag", path_name: "ACCESSORY — TAG — RUBBER TAG" },
] as unknown as CategoryRow[];

const renderBar = (categoryId = "", subCategoryId = "") => {
  const onCategory = vi.fn();
  const onSubCategory = vi.fn();
  render(<CategoryFilterBar categories={CATEGORIES} categoryId={categoryId} subCategoryId={subCategoryId} onCategory={onCategory} onSubCategory={onSubCategory} />);
  return { onCategory, onSubCategory };
};

describe("CategoryFilterBar", () => {
  it("offers All and every top-level category, All pressed while none is chosen, and no second row", () => {
    const { onCategory } = renderBar();
    const row = screen.getByRole("group", { name: "Filter by category" });
    expect(within(row).getAllByRole("button").map((button) => button.textContent)).toEqual(["All", "ACCESSORY", "DANA"]);
    expect(within(row).getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("group", { name: /Filter within/ })).toBeNull();

    fireEvent.click(within(row).getByRole("button", { name: "ACCESSORY" }));
    expect(onCategory).toHaveBeenCalledWith("c-acc");
  });

  it("opens the chosen category's levels beneath it, however deep, each named by its path", () => {
    const { onSubCategory } = renderBar("c-acc");
    expect(screen.getByRole("button", { name: "ACCESSORY" })).toHaveAttribute("aria-pressed", "true");
    const sub = screen.getByRole("group", { name: "Filter within ACCESSORY" });
    expect(within(sub).getAllByRole("button").map((button) => button.textContent)).toEqual(["All ACCESSORY", "TAG", "TAG ▸ RUBBER TAG"]);
    expect(within(sub).getByRole("button", { name: "All ACCESSORY" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(within(sub).getByRole("button", { name: "TAG ▸ RUBBER TAG" }));
    expect(onSubCategory).toHaveBeenCalledWith("c-rtag");
  });

  it("shows no second row for a category with nothing beneath it", () => {
    renderBar("c-dana");
    expect(screen.queryByRole("group", { name: /Filter within/ })).toBeNull();
  });
});
