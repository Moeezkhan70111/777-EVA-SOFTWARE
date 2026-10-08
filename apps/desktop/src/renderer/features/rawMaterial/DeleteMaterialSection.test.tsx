import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeleteMaterialSection } from "./DeleteMaterialSection";
import { NotificationsProvider } from "../../state/NotificationsContext";

// Three outcomes for a material that should not be in the list: disable it, put it back, or
// erase it for good. Which are offered is the data layer's answer, shown as it comes.
//
// Erasing takes the material's OWN stock ledger with it, which the screen says out loud.
// Anything outside the material that names it blocks the erase entirely.

function installApi(blockers: string[], cost: string[] = []) {
  const api = {
    itemRemovalBlockers: vi.fn(async () => ({ accepted: true, blockers, cost })),
    removeInventoryItemForGood: vi.fn(async () => ({ accepted: true })),
    createItemRemovalRequest: vi.fn(async () => ({ accepted: true, request: { requestCode: "DEL-000001" } })),
    setInventoryItemStatus: vi.fn(async () => ({ accepted: true, status: "INACTIVE" })),
  };
  Object.defineProperty(window, "desktop", { value: { versions: {}, api }, configurable: true });
  return api;
}

const renderSection = (options: { onDeleted?: ReturnType<typeof vi.fn>; disabled?: boolean; isAdmin?: boolean } = {}) => {
  const onDeleted = options.onDeleted ?? vi.fn();
  render(
    <NotificationsProvider>
      <DeleteMaterialSection
        itemId="item-1"
        displayName="RUBBER — GREY"
        disabled={options.disabled ?? false}
        isAdmin={options.isAdmin ?? true}
        onDeleted={onDeleted}
        onChanged={async () => {}}
      />
    </NotificationsProvider>,
  );
  return onDeleted;
};

describe("DeleteMaterialSection", () => {
  afterEach(() => vi.restoreAllMocks());

  it("erases a material nothing outside it names, after one confirmation", async () => {
    const api = installApi([]);
    const onDeleted = renderSection();

    await userEvent.click(await screen.findByRole("button", { name: "Erase it for good" }));
    expect(await screen.findByRole("dialog", { name: "Delete RUBBER — GREY?" })).toBeInTheDocument();
    expect(api.removeInventoryItemForGood).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(api.removeInventoryItemForGood).toHaveBeenCalledWith("item-1", undefined));
    expect(onDeleted).toHaveBeenCalled();
  });

  it("says what the erase would take with it, and carries it into the confirmation", async () => {
    installApi([], ["25 KG still in stock", "1 stock movement"]);
    renderSection();

    expect(await screen.findByText(/25 KG still in stock and 1 stock movement would go with it/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Erase it for good" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("25 KG still in stock, 1 stock movement");
  });

  it("will not erase a material something outside it names, and offers to disable it instead", async () => {
    const api = installApi(["1 QR label", "3 scans"]);
    renderSection();

    expect(await screen.findByText(/1 QR label, 3 scans/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Erase it for good" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Disable it instead" }));
    await waitFor(() => expect(api.setInventoryItemStatus).toHaveBeenCalledWith("item-1", "INACTIVE"));
    expect(api.removeInventoryItemForGood).not.toHaveBeenCalled();
  });

  it("puts a disabled material back in use", async () => {
    const api = installApi(["1 QR label"]);
    renderSection({ disabled: true });

    await userEvent.click(await screen.findByTestId("material-enable"));
    await waitFor(() => expect(api.setInventoryItemStatus).toHaveBeenCalledWith("item-1", "ACTIVE"));
  });

  it("a disabled material can still be erased when nothing outside it names it", async () => {
    const api = installApi([]);
    renderSection({ disabled: true });

    expect(await screen.findByTestId("material-enable")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Erase it for good" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(api.removeInventoryItemForGood).toHaveBeenCalled());
  });

  it("someone who is not an administrator asks for the erase instead of doing it", async () => {
    const api = installApi([]);
    renderSection({ isAdmin: false });

    await userEvent.click(await screen.findByRole("button", { name: "Ask the administrator to remove it" }));
    await waitFor(() => expect(api.createItemRemovalRequest).toHaveBeenCalledWith({ itemId: "item-1", reason: undefined }));
    expect(api.removeInventoryItemForGood).not.toHaveBeenCalled();
  });

  it("keeps the dialog open and shows why when the erase is refused", async () => {
    const api = installApi([]);
    api.removeInventoryItemForGood.mockResolvedValue({ accepted: false, reason: "A scan landed a moment ago." } as never);
    const onDeleted = renderSection();

    await userEvent.click(await screen.findByRole("button", { name: "Erase it for good" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(await screen.findByText(/A scan landed a moment ago/)).toBeInTheDocument();
    expect(onDeleted).not.toHaveBeenCalled();
  });
});
