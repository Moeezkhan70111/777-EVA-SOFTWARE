import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PartiesFromListDialog } from "./PartiesFromListDialog";

// Paste parties (owner, 25 Nov 2026): the preview shows what will be added before anything is saved, a city is
// required, and exactly the previewed parties are sent with the city, group and type chosen.

const LIST = "| English Name | Urdu Name |\n| --- | --- |\n| ASHRAF CHAPPAL HYDERABAD | اشرف چپل حیدرآباد |\n| QZ Hyderabad | حیدرآباد QZ |";

function fakeApi() {
  const api = {
    listCities: vi.fn(async () => ["Hyderabad", "Karachi"]),
    listPartyGroups: vi.fn(async () => [{ id: "g1", groupName: "Karachi" }]),
    addPartiesFromList: vi.fn(async () => ({ accepted: true, created: [{ partyName: "QZ Hyderabad", partyCode: "PTY-000101" }], skipped: ["ASHRAF CHAPPAL HYDERABAD"] })),
  };
  Object.defineProperty(window, "desktop", { value: { versions: { node: "22", chrome: "128", electron: "43" }, api }, configurable: true });
  return api;
}

describe("Paste parties", () => {
  it("previews the pasted list, wants a city, then sends exactly the previewed parties", async () => {
    const api = fakeApi();
    const onAdded = vi.fn();
    render(<PartiesFromListDialog onClose={() => undefined} onAdded={onAdded} />);
    fireEvent.change(screen.getByLabelText("Parties"), { target: { value: LIST } });
    const preview = screen.getByRole("table", { name: "2 parties to add" });
    expect(within(preview).getAllByRole("row")).toHaveLength(3);

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Add 2 parties" })); });
    expect(screen.getByRole("alert")).toHaveTextContent("Type the city");
    expect(api.addPartiesFromList).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/City/), { target: { value: "Hyderabad" } });
    fireEvent.change(screen.getByLabelText("Party group"), { target: { value: "Hyderabad" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Add 2 parties" })); });
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith({ added: 1, skipped: ["ASHRAF CHAPPAL HYDERABAD"] }));
    expect(api.addPartiesFromList).toHaveBeenCalledWith({
      rows: [
        { partyName: "ASHRAF CHAPPAL HYDERABAD", partyNameUrdu: "اشرف چپل حیدرآباد" },
        { partyName: "QZ Hyderabad", partyNameUrdu: "حیدرآباد QZ" },
      ],
      city: "Hyderabad",
      groupName: "Hyderabad",
      partyType: "CUSTOMER",
    });
  });
});
