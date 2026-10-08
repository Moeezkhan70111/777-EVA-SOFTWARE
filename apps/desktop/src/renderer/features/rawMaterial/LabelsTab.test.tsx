import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LabelsTab } from "./LabelsTab";
import { NotificationsProvider, useNotifications } from "../../state/NotificationsContext";
import type { RawMaterialMovementConfigRow, RawMaterialQrBatchRow } from "../../types/desktopApi";

// What one packet holds is typed for every label run — the same material arrives 5 DOZEN to a
// packet one day and 3 the next — so a run cannot be generated without it, and the figure the
// operator typed is exactly what is registered.

const SUPPLIER = { id: "party-1", partyCode: "PTY000001", partyName: "SHEHZAD RUBBER", partyType: "SUPPLIER" };
const ITEM = { id: "item-1", item_code: "RM-000001", display_name: "UPPER — RAGZINE — SK6 — BROWN — 7/10", unit_code: "DOZ", values: [] };

const CONFIG = new Map<string, RawMaterialMovementConfigRow>([
  [
    "item-1",
    {
      itemId: "item-1",
      itemCode: "RM-000001",
      displayName: ITEM.display_name,
      packName: null,
      packingQuantity: null,
      packetsInStore: 0,
      packingUnitId: null,
      packingUnitCode: null,
      stockUnitId: "u-1",
      stockUnitCode: "DOZ",
      packingConvertsToStock: true,
      packSizeInStockUnit: null,
      defaultSectionId: null,
      defaultSectionName: null,
      hops: [],
    },
  ],
]);

function installApi() {
  const api = {
    listParties: vi.fn(async () => ({ rows: [SUPPLIER], total: 1 })),
    listInventoryItems: vi.fn(async () => [ITEM]),
    listRawMaterialQrBatches: vi.fn(async (): Promise<RawMaterialQrBatchRow[]> => []),
    getRawMaterialQrSequenceState: vi.fn(async () => ({ lastSequence: 0, nextSequence: 1 })),
    generateRawMaterialQrBatch: vi.fn(async (_input: Record<string, unknown>) => ({ accepted: false, reason: "not under test" })) as ReturnType<typeof vi.fn>,
    deleteRawMaterialQrBatch: vi.fn(
      async (_batchId: string): Promise<{ accepted: boolean; quantity?: number; nextSequence?: number; reason?: string }> => ({
        accepted: true,
        quantity: 0,
        nextSequence: 1,
      })
    ),
    printDocument: vi.fn(
      async (_payload: { html: string; pageSize?: { widthIn: number; heightIn: number } }): Promise<{ accepted: boolean; reason?: string }> => ({
        accepted: true,
      })
    ),
  };
  Object.defineProperty(window, "desktop", {
    value: { versions: { node: "22", chrome: "128", electron: "43" }, api },
    configurable: true,
  });
  return api;
}

/** The app shell draws toasts; here they are just listed so a test can read them. */
const Notices = () => (
  <ul>
    {useNotifications().notices.map((notice) => (
      <li key={notice.id}>
        {notice.title}: {notice.message}
      </li>
    ))}
  </ul>
);

const renderTab = () =>
  render(
    <NotificationsProvider>
      <Notices />
      <LabelsTab username="aslam" configByItem={CONFIG} preselectItemId="item-1" onPreselectConsumed={vi.fn()} />
    </NotificationsProvider>
  );

async function chooseSupplier() {
  await userEvent.click(await screen.findByPlaceholderText("Choose supplier…"));
  await userEvent.click(await screen.findByRole("option", { name: /SHEHZAD RUBBER/ }));
}

describe("LabelsTab — what one packet holds", () => {
  afterEach(() => vi.restoreAllMocks());

  it("will not print until the operator says what one packet holds", async () => {
    installApi();
    renderTab();
    await chooseSupplier();

    await userEvent.type(screen.getByLabelText("How many labels"), "10");
    const generate = screen.getByRole("button", { name: /Print 10 labels/ }) as HTMLButtonElement;
    expect(generate.disabled).toBe(true);

    // The field is in the material's stock unit, and named after its container.
    expect(screen.getByLabelText("One PACKET holds")).toBeInTheDocument();
    expect(screen.getByText("DOZ")).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("One PACKET holds"), "5");
    expect(generate.disabled).toBe(false);
    expect(screen.getByText("Each PACKET holds 5 DOZ.")).toBeInTheDocument();
  });

  it("sends the typed figure with the run", async () => {
    const api = installApi();
    renderTab();
    await chooseSupplier();

    await userEvent.type(screen.getByLabelText("One PACKET holds"), "3");
    await userEvent.type(screen.getByLabelText("How many labels"), "2");
    await userEvent.click(screen.getByRole("button", { name: /Print 2 labels/ }));
    // Nothing is registered until the operator confirms.
    expect(api.generateRawMaterialQrBatch).not.toHaveBeenCalled();
    await userEvent.click(await screen.findByRole("button", { name: /^🖨 Print$/ }));

    await waitFor(() => expect(api.generateRawMaterialQrBatch).toHaveBeenCalled());
    expect(api.generateRawMaterialQrBatch.mock.calls[0][0]).toMatchObject({
      partyId: "party-1",
      itemId: "item-1",
      quantity: 2,
      packingQuantity: 3,
    });
  });

  it("refuses a packet that holds nothing, in words", async () => {
    installApi();
    renderTab();
    await chooseSupplier();

    await userEvent.type(screen.getByLabelText("One PACKET holds"), "0");
    expect(screen.getByText("Enter a number greater than zero, e.g. 5.")).toBeInTheDocument();
  });
});

// One Print button, one confirmation, then straight to the default printer at sticker size.
describe("LabelsTab — printing", () => {
  afterEach(() => vi.restoreAllMocks());

  const BATCH = {
    id: "batch-1", partyId: "party-1", partyCode: "PTY000001", partyName: "SHEHZAD RUBBER",
    itemId: "item-1", itemCode: "RM-000001", itemDisplayName: ITEM.display_name,
    startSequence: 1, endSequence: 2, quantity: 2, packingQuantity: 3,
    createdAt: "2026-10-05T05:00:00.000Z", createdBy: "aslam", requestedBy: null,
  };
  const CODES = [1, 2].map((sequence) => ({
    id: `RM_PTY000001_RM-000001_${sequence}`, batchId: "batch-1", partyId: "party-1", itemId: "item-1",
    sequence, status: "REGISTERED", createdAt: BATCH.createdAt,
  }));

  async function fillAndPress(api: ReturnType<typeof installApi>) {
    api.generateRawMaterialQrBatch.mockResolvedValue({ accepted: true, batch: BATCH, qrCodes: CODES });
    renderTab();
    await chooseSupplier();
    await userEvent.type(screen.getByLabelText("One PACKET holds"), "3");
    await userEvent.type(screen.getByLabelText("How many labels"), "2");
    await userEvent.click(screen.getByRole("button", { name: /Print 2 labels/ }));
  }

  it("registers and prints the run on the default printer after one confirmation", async () => {
    const api = installApi();
    await fillAndPress(api);
    expect(await screen.findByRole("dialog", { name: "Print 2 labels?" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /^🖨 Print$/ }));

    await waitFor(() => expect(api.printDocument).toHaveBeenCalledTimes(1));
    const payload = api.printDocument.mock.calls[0][0];
    expect(payload.pageSize).toEqual({ widthIn: 3, heightIn: 2 });
    expect(payload.html).toContain(CODES[0].id);
    expect(payload.html).toContain(CODES[1].id);
    expect(await screen.findByText(/Sent to the printer/)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("registers nothing when the operator cancels", async () => {
    const api = installApi();
    await fillAndPress(api);
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(api.generateRawMaterialQrBatch).not.toHaveBeenCalled();
    expect(api.printDocument).not.toHaveBeenCalled();
  });

  it("says so when the codes were saved but the printer refused them", async () => {
    const api = installApi();
    api.printDocument.mockResolvedValue({ accepted: false, reason: "No printer is set as default" });
    await fillAndPress(api);
    await userEvent.click(await screen.findByRole("button", { name: /^🖨 Print$/ }));

    expect(await screen.findByText(/Labels saved but not printed: No printer is set as default/)).toBeInTheDocument();
    expect(api.generateRawMaterialQrBatch).toHaveBeenCalledTimes(1);
  });
});

// Erasing a run generated by mistake, from Recent generations.
describe("LabelsTab — erasing a run", () => {
  afterEach(() => vi.restoreAllMocks());

  const BATCH = {
    id: "batch-1", partyId: "party-1", partyCode: "PTY000001", partyName: "SHEHZAD RUBBER",
    itemId: "item-1", itemCode: "RM-000001", itemDisplayName: ITEM.display_name,
    startSequence: 1, endSequence: 6, quantity: 6, packingQuantity: 3,
    createdAt: "2026-10-05T05:00:00.000Z", createdBy: "aslam", requestedBy: null,
  };

  it("erases it after one confirmation and says where the serials now start", async () => {
    const api = installApi();
    api.listRawMaterialQrBatches.mockResolvedValue([BATCH]);
    api.deleteRawMaterialQrBatch.mockResolvedValue({ accepted: true, quantity: 6, nextSequence: 1 });
    renderTab();

    // The row button and the dialog button both read "Delete", so each is reached in its own place.
    await userEvent.click(await screen.findByTitle("Erase this run"));
    const dialog = await screen.findByRole("dialog", { name: "Erase 6 labels?" });
    expect(api.deleteRawMaterialQrBatch).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole("button", { name: /^Delete$/ }));
    await waitFor(() => expect(api.deleteRawMaterialQrBatch).toHaveBeenCalledWith("batch-1"));
    expect(await screen.findByText(/next run for this supplier and material starts at 1/)).toBeInTheDocument();
  });

  it("keeps the dialog open and shows why when a label has already been scanned", async () => {
    const api = installApi();
    api.listRawMaterialQrBatches.mockResolvedValue([BATCH]);
    api.deleteRawMaterialQrBatch.mockResolvedValue({ accepted: false, reason: "This run cannot be erased — 1 scan(s) recorded." });
    renderTab();

    await userEvent.click(await screen.findByTitle("Erase this run"));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: /^Delete$/ }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("1 scan(s) recorded");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
