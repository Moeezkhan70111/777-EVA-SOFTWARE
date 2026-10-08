import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SearchableCombobox, matchesSearch } from "./SearchableCombobox";
import { materialPickerOption, type InventoryItemRow } from "../../features/rawMaterial/rawMaterial";

// Operators search the way they think — "brown 8/13", "sk19 ragzine", a bit of the code — so
// every typed word must be found somewhere, in any order.

const BROWN = materialPickerOption({
  id: "i11",
  item_code: "RM-000011",
  display_name: "UPPER — RAGZINE UPPER — SK19 — BROWN — 8/13",
  top_category_name: "UPPER",
  sub_category_name: "RAGZINE UPPER",
} as InventoryItemRow);

const BLACK = materialPickerOption({
  id: "i9",
  item_code: "RM-000009",
  display_name: "UPPER — RAGZINE UPPER — SK19 — BLACK — 8/13",
  top_category_name: "UPPER",
  sub_category_name: "RAGZINE UPPER",
} as InventoryItemRow);

describe("materialPickerOption", () => {
  it("puts what tells the material apart on the big line, and category and code underneath", () => {
    expect(BROWN.label).toBe("SK19 · BROWN · 8/13");
    expect(BROWN.detail).toBe("UPPER — RAGZINE UPPER · RM-000011");
  });
});

describe("matchesSearch", () => {
  it.each(["brown", "BROWN 8/13", "8/13 brown", "sk19 brown", "ragzine brown", "rm-000011", "11 brown", "upper sk19 brown 8/13"])(
    "finds the brown upper by %s",
    (query) => {
      expect(matchesSearch(BROWN, query)).toBe(true);
    }
  );

  it("needs every word: 'brown' and 'black' together match neither", () => {
    expect(matchesSearch(BROWN, "brown black")).toBe(false);
    expect(matchesSearch(BLACK, "brown black")).toBe(false);
  });

  it("matches everything when nothing is typed", () => {
    expect(matchesSearch(BLACK, "   ")).toBe(true);
  });
});

describe("SearchableCombobox", () => {
  it("lists only the options holding every typed word, each with its detail line", () => {
    const onChange = vi.fn();
    render(<SearchableCombobox value="" options={[BROWN, BLACK]} placeholder="Search" onChange={onChange} />);

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "8/13 brown" } });

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("SK19 · BROWN · 8/13");
    expect(options[0]).toHaveTextContent("RM-000011");

    fireEvent.click(options[0]);
    expect(onChange).toHaveBeenLastCalledWith("i11");
  });
});

// Dropdown mode: it reads and behaves like a select — the arrow opens the whole list, and typing
// only narrows it; the material already picked is never thrown away by a stray keystroke.
describe("SearchableCombobox — dropdown mode", () => {
  const renderDropdown = (onChange = vi.fn()) => {
    render(<SearchableCombobox value={BROWN.value} options={[BROWN, BLACK]} placeholder="Choose" onChange={onChange} dropdown />);
    return onChange;
  };

  it("shows the pick, and the arrow opens the whole list", () => {
    renderDropdown();
    expect(screen.getByRole("combobox")).toHaveValue("SK19 · BROWN · 8/13");

    fireEvent.click(screen.getByRole("button", { name: "Show options" }));
    expect(screen.getAllByRole("option")).toHaveLength(2);
    // Open with an empty filter; the current pick shows behind it.
    expect(screen.getByRole("combobox")).toHaveValue("");
    expect(screen.getByRole("combobox")).toHaveAttribute("placeholder", "SK19 · BROWN · 8/13");
  });

  it("filters while typing without clearing the pick", () => {
    const onChange = renderDropdown();
    fireEvent.click(screen.getByRole("button", { name: "Show options" }));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "black" } });

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.click(screen.getByRole("option", { name: /BLACK/ }));
    expect(onChange).toHaveBeenCalledWith(BLACK.value);
  });
});

// Near the bottom of a short window the list opens upward. It used to keep the stylesheet's
// `top` as well as its own `bottom`, which squeezed it to an 11px sliver — "nothing shows".
describe("SearchableCombobox — opening upward", () => {
  it("is pinned by its bottom edge only, so it keeps its full height", () => {
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      top: window.innerHeight - 60, bottom: window.innerHeight - 24, left: 20, right: 420, width: 400, height: 36, x: 20, y: window.innerHeight - 60,
      toJSON: () => ({}),
    });
    render(<SearchableCombobox value="" options={[BROWN, BLACK]} placeholder="Choose" onChange={vi.fn()} dropdown />);
    fireEvent.click(screen.getByRole("button", { name: "Show options" }));

    const list = screen.getByRole("listbox");
    expect(list.style.top).toBe("auto");
    expect(list.style.bottom).not.toBe("auto");
    rect.mockRestore();
  });
});
