import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PasteDiscountsDialog } from "./PasteDiscountsDialog";

// Paste discounts (owner, 26 Nov 2026): the list is read and shown before anything happens; names that are not
// customers are said and skipped; Fill in hands over exactly the matches. Nothing is saved from the dialog.

const PARTIES = [
  { id: "p1", partyName: "ABDUL GHANI HYDERABAD", partyNameUrdu: "عبدل غنی حیدرآباد" },
  { id: "p2", partyName: "QZ Hyderabad" },
];

describe("Paste discounts", () => {
  it("shows what it read, says what it skipped, and fills in only the matches", () => {
    const onFill = vi.fn();
    render(<PasteDiscountsDialog target="SLIPPERS" parties={PARTIES} onClose={() => undefined} onFill={onFill} />);
    expect(screen.getByRole("button", { name: "Fill in 0 discounts" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Discounts"), { target: { value: "عبدل غنی حیدرآباد | 12\nQZ Hyderabad\t7.5\nNOBODY TRADERS | 9" } });
    const preview = screen.getByRole("table", { name: "2 customers found" });
    expect(within(preview).getByText("ABDUL GHANI HYDERABAD")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Not a customer, skipped: NOBODY TRADERS");
    fireEvent.click(screen.getByRole("button", { name: "Fill in 2 discounts" }));
    expect(onFill).toHaveBeenCalledWith([
      { partyId: "p1", partyName: "ABDUL GHANI HYDERABAD", discountPerPair: 12 },
      { partyId: "p2", partyName: "QZ Hyderabad", discountPerPair: 7.5 },
    ]);
  });
});
