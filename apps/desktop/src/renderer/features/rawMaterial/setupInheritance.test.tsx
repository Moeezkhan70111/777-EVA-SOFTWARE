import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NewMaterialModal } from "./NewMaterialModal";
import { NotificationsProvider } from "../../state/NotificationsContext";
import type { RawMaterialMovementConfigRow, RawMaterialSetupTemplate, WorkSection } from "../../types/desktopApi";
import type { CategoryRow } from "./rawMaterial";

// DANA — EVA — BLACK, RED and BLUE are one material in three colours. What the second colour
// inherits from the first has to be SAID before it is saved, and applying a changed route to the
// whole sub-category has to be a deliberate tick rather than a side effect of saving.

const UNITS = [
  { id: "u-kg", code: "KG", name: "Kilogram" },
  { id: "u-doz", code: "DOZ", name: "Dozen" },
];

const SECTIONS: WorkSection[] = [
  { id: "sec-mix", sectionCode: "WS-1", name: "MIXING", status: "ACTIVE" },
  { id: "sec-mac", sectionCode: "WS-2", name: "MACHINE", status: "ACTIVE" },
];

const CATEGORIES: CategoryRow[] = [
  { id: "cat-dana", name: "DANA", parent_id: null, fields: [] },
  {
    id: "cat-eva",
    name: "EVA",
    parent_id: "cat-dana",
    fields: [{ id: "f-colour", field_key: "colour", label: "COLOUR", field_type: "TEXT", is_required: 1 }],
  },
];

const TEMPLATE: RawMaterialSetupTemplate = {
  sourceItemId: "item-black",
  sourceDisplayName: "DANA — EVA — BLACK",
  unitId: "u-kg",
  unitCode: "KG",
  packName: "BAG",
  packingQuantity: 25,
  packingUnitId: "u-kg",
  packingUnitCode: "KG",
  hops: [
    { hopIndex: 1, sectionId: "sec-mix", sectionName: "MIXING" },
    { hopIndex: 2, sectionId: "sec-mac", sectionName: "MACHINE" },
  ],
  materialCount: 3,
};

const CONFIG: RawMaterialMovementConfigRow = {
  itemId: "item-black",
  itemCode: "RM-000001",
  displayName: "DANA — EVA — BLACK",
  packName: "BAG",
  packingQuantity: 25,
  packetsInStore: 0,
  packingUnitId: "u-kg",
  packingUnitCode: "KG",
  stockUnitId: "u-kg",
  stockUnitCode: "KG",
  packingConvertsToStock: true,
  packSizeInStockUnit: 25,
  defaultSectionId: "sec-mix",
  defaultSectionName: "MIXING",
  hops: TEMPLATE.hops,
};

function installApi(overrides: Record<string, unknown> = {}) {
  const api = {
    getRawMaterialSetupTemplate: vi.fn(async () => TEMPLATE),
    createInventoryItem: vi.fn(async (_input: Record<string, unknown>) => ({
      accepted: true,
      id: "item-red",
      code: "RM-000002",
      displayName: "DANA — EVA — RED",
    })),
    addInventoryFieldOption: vi.fn(async () => ({ accepted: true })),
    setRawMaterialMovementConfig: vi.fn(async () => ({ accepted: true })),
    setRawMaterialHops: vi.fn(async () => ({ accepted: true })),
    applyRawMaterialSetupToCategory: vi.fn(
      async (_categoryId: string, _setup: Record<string, unknown>) => ({ accepted: true, updated: 3 })
    ),
    ...overrides,
  };
  Object.defineProperty(window, "desktop", {
    value: { versions: { node: "22", chrome: "128", electron: "43" }, api },
    configurable: true,
  });
  return api;
}

const renderNewMaterial = () =>
  render(
    <NotificationsProvider>
      <NewMaterialModal
        categories={CATEGORIES}
        units={UNITS}
        onClose={vi.fn()}
        onCreated={vi.fn(async () => {})}
        onLookupsChanged={vi.fn(async () => {})}
      />
    </NotificationsProvider>
  );

/** Pick DANA, then EVA — the point at which the sub-category has an answer to give. */
async function chooseEva() {
  await userEvent.selectOptions(screen.getByLabelText(/^Category/), "cat-dana");
  await userEvent.selectOptions(await screen.findByLabelText(/^Sub-category/), "cat-eva");
}

describe("inheriting a sub-category's setup", () => {
  afterEach(() => vi.restoreAllMocks());

  it("says what a new material will follow, and from which material", async () => {
    installApi();
    renderNewMaterial();
    await chooseEva();

    expect(await screen.findByText(/Will follow DANA — EVA — BLACK/)).toBeTruthy();
    expect(screen.getByText(/Counted in KG · MIXING → MACHINE/)).toBeTruthy();
  });

  it("prefills the stock unit the rest of the sub-category is counted in", async () => {
    installApi();
    renderNewMaterial();
    await chooseEva();

    const unit = (await screen.findByLabelText("Stock unit")) as HTMLSelectElement;
    await waitFor(() => expect(unit.value).toBe("u-kg"));
  });

  it("carries the unit and the pack into the material it creates, but no packet size", async () => {
    const api = installApi();
    renderNewMaterial();
    await chooseEva();
    await screen.findByText(/Will follow/);

    await userEvent.type(screen.getByLabelText(/COLOUR/, { selector: "input:not(.urdu-input)" }), "RED");
    await userEvent.click(screen.getByRole("button", { name: "Create material" }));

    await waitFor(() => expect(api.createInventoryItem).toHaveBeenCalled());
    expect(api.createInventoryItem.mock.calls[0][0]).toMatchObject({
      categoryId: "cat-eva",
      unitId: "u-kg",
      packName: "BAG",
    });
    // What a packet holds is typed for each label run, never fixed on the material.
    expect(api.createInventoryItem.mock.calls[0][0].packingQuantity).toBeUndefined();
  });

  it("says so plainly when a sub-category has nothing to inherit yet", async () => {
    installApi({ getRawMaterialSetupTemplate: vi.fn(async () => null) });
    renderNewMaterial();
    await chooseEva();

    expect(await screen.findByText(/Nothing in this sub-category has a route yet/)).toBeTruthy();
  });

  it("does not invent a pack for a material that has nothing to follow", async () => {
    const api = installApi({ getRawMaterialSetupTemplate: vi.fn(async () => null) });
    renderNewMaterial();
    await chooseEva();
    await screen.findByText(/Nothing in this sub-category/);

    await userEvent.type(screen.getByLabelText(/COLOUR/, { selector: "input:not(.urdu-input)" }), "RED");
    await userEvent.click(screen.getByRole("button", { name: "Create material" }));

    await waitFor(() => expect(api.createInventoryItem).toHaveBeenCalled());
    const payload = api.createInventoryItem.mock.calls[0][0];
    expect(payload.packingQuantity).toBeUndefined();
    expect(payload.hopSectionIds).toBeUndefined();
  });
});
