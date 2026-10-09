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
//
// One press of Print covers SEVERAL materials: a row of the Selected Items table is one run,
// the same material may be queued twice with different packet sizes, and every sticker goes to
// the printer as one job.

const SUPPLIER = { id: "party-1", partyCode: "PTY000001", partyName: "SHEHZAD RUBBER", partyType: "SUPPLIER" };
const ITEM = { id: "item-1", item_code: "RM-000001", display_name: "UPPER — RAGZINE — SK6 — BROWN — 7/10", unit_code: "DOZ", values: [] };
const ITEM_2 = { id: "item-2", item_code: "RM-000002", display_name: "UPPER — RAGZINE — SK12 — BLACK — 8/11", unit_code: "DOZ", values: [] };
/** What the Selected Items rows call ITEM, with the category prefix taken off. */
const NAME = /SK6/;

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

/** One registered run of ITEM, and the identities it took. */
const BATCH_1 = {
  id: "batch-1", partyId: "party-1", partyCode: "PTY000001", partyName: "SHEHZAD RUBBER",
  itemId: "item-1", itemCode: "RM-000001", itemDisplayName: ITEM.display_name,
  startSequence: 1, endSequence: 2, quantity: 2, packingQuantity: 3,
  createdAt: "2026-10-05T05:00:00.000Z", createdBy: "aslam", requestedBy: null,
};
const CODES_1 = [1, 2].map((sequence) => ({
  id: `RM_PTY000001_RM-000001_${sequence}`, batchId: "batch-1", partyId: "party-1", itemId: "item-1",
  sequence, status: "REGISTERED", createdAt: BATCH_1.createdAt,
}));

/** A second material's run, for a print that covers more than one. */
const BATCH_2 = {
  ...BATCH_1,
  id: "batch-2", itemId: "item-2", itemCode: "RM-000002", itemDisplayName: ITEM_2.display_name,
  startSequence: 1, endSequence: 1, quantity: 1, packingQuantity: 6,
};
const CODES_2 = [{
  id: "RM_PTY000001_RM-000002_1", batchId: "batch-2", partyId: "party-1", itemId: "item-2",
  sequence: 1, status: "REGISTERED", createdAt: BATCH_1.createdAt,
}];

function installApi() {
  const api = {
    listParties: vi.fn(async () => ({ rows: [SUPPLIER], total: 1 })),
    listInventoryItems: vi.fn(async () => [ITEM, ITEM_2]),
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

/** The two typed figures of the row for `match`, in the Selected Items table. */
const packetsBox = (match: RegExp) => screen.getByLabelText(new RegExp(`How many packets of .*${match.source}`));
const perPacketBox = (match: RegExp) => screen.getByLabelText(new RegExp(`What one PACKET of .*${match.source}.*holds`));

/** Queues another material by pressing + Add on its row of the picker. */
async function addMaterial(match: RegExp) {
  await userEvent.click(screen.getByRole("button", { name: new RegExp(`Add .*${match.source}.* to the selection`) }));
}

/** Fills the row for `match`: how many packets, and what one of them holds. */
async function fillRun(match: RegExp, packets: string, perPacket: string) {
  await userEvent.type(perPacketBox(match), perPacket);
  await userEvent.type(packetsBox(match), packets);
}

const printButton = () => screen.getByRole("button", { name: "Print QR Codes & Labels" }) as HTMLButtonElement;

describe("LabelsTab — what one packet holds", () => {
  afterEach(() => vi.restoreAllMocks());

  it("will not print until the operator says what one packet holds", async () => {
    installApi();
    renderTab();
    await chooseSupplier();

    // The material arrived from its drawer, so it is already a row — with nothing typed on it.
    await userEvent.type(await screen.findByLabelText(/How many packets of .*SK6/), "10");
    expect(printButton().disabled).toBe(true);

    // The figure is in the material's stock unit, and the box is named after its container.
    expect(perPacketBox(NAME)).toBeInTheDocument();
    expect(screen.getAllByText("DOZ").length).toBeGreaterThan(0);

    await userEvent.type(perPacketBox(NAME), "5");
    expect(printButton().disabled).toBe(false);
    // The row does the arithmetic the operator would otherwise do in their head.
    expect(screen.getByText("50 DOZ")).toBeInTheDocument();
  });

  it("sends the typed figures with the run", async () => {
    const api = installApi();
    renderTab();
    await chooseSupplier();
    await fillRun(NAME, "2", "3");

    await userEvent.click(printButton());
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

    await userEvent.type(await screen.findByLabelText(/How many packets of .*SK6/), "1");
    await userEvent.type(perPacketBox(NAME), "0");
    expect(screen.getByText(/Type what one PACKET holds/)).toBeInTheDocument();
    expect(printButton().disabled).toBe(true);
  });

  it("queues the SAME material twice, each with its own packet size, as two runs", async () => {
    const api = installApi();
    api.generateRawMaterialQrBatch.mockResolvedValue({ accepted: true, batch: BATCH_1, qrCodes: CODES_1 });
    renderTab();
    await chooseSupplier();

    await fillRun(NAME, "2", "3");
    await addMaterial(NAME);
    // Two rows for one material: the figures are per row, so each is reached by its own box.
    const packets = screen.getAllByLabelText(/How many packets of .*SK6/);
    const perPacket = screen.getAllByLabelText(/What one PACKET of .*SK6.*holds/);
    expect(packets).toHaveLength(2);
    await userEvent.type(perPacket[1], "4");
    await userEvent.type(packets[1], "5");

    expect(screen.getByText("Total materials").parentElement).toHaveTextContent("2");
    expect(screen.getByText("Total labels").parentElement).toHaveTextContent("7");

    await userEvent.click(printButton());
    await userEvent.click(await screen.findByRole("button", { name: /^🖨 Print$/ }));

    // One registration per row — same material, different packet size.
    await waitFor(() => expect(api.generateRawMaterialQrBatch).toHaveBeenCalledTimes(2));
    expect(api.generateRawMaterialQrBatch.mock.calls[0][0]).toMatchObject({ itemId: "item-1", quantity: 2, packingQuantity: 3 });
    expect(api.generateRawMaterialQrBatch.mock.calls[1][0]).toMatchObject({ itemId: "item-1", quantity: 5, packingQuantity: 4 });
  });

  it("prints every material's stickers as ONE print job", async () => {
    const api = installApi();
    api.generateRawMaterialQrBatch
      .mockResolvedValueOnce({ accepted: true, batch: BATCH_1, qrCodes: CODES_1 })
      .mockResolvedValueOnce({ accepted: true, batch: BATCH_2, qrCodes: CODES_2 });
    renderTab();
    await chooseSupplier();

    await fillRun(NAME, "2", "3");
    await addMaterial(/SK12/);
    await fillRun(/SK12/, "1", "6");

    await userEvent.click(printButton());
    await userEvent.click(await screen.findByRole("button", { name: /^🖨 Print$/ }));

    await waitFor(() => expect(api.printDocument).toHaveBeenCalledTimes(1));
    const html = api.printDocument.mock.calls[0][0].html;
    expect(html).toContain(CODES_1[0].id);
    expect(html).toContain(CODES_2[0].id);
  });

  it("prints what WAS registered when a later material is refused, and drops it from the list", async () => {
    const api = installApi();
    api.generateRawMaterialQrBatch
      .mockResolvedValueOnce({ accepted: true, batch: BATCH_1, qrCodes: CODES_1 })
      .mockResolvedValueOnce({ accepted: false, reason: "That material was retired." });
    renderTab();
    await chooseSupplier();

    await fillRun(NAME, "2", "3");
    await addMaterial(/SK12/);
    await fillRun(/SK12/, "1", "6");

    await userEvent.click(printButton());
    await userEvent.click(await screen.findByRole("button", { name: /^🖨 Print$/ }));

    // The codes that went through exist, so their stickers are printed anyway — a registered
    // code with no sticker is a packet nobody can scan.
    await waitFor(() => expect(api.printDocument).toHaveBeenCalledTimes(1));
    expect(api.printDocument.mock.calls[0][0].html).toContain(CODES_1[0].id);
    // Said twice on purpose: in the dialog that stays open, and as a toast.
    expect((await screen.findAllByText(/That material was retired/)).length).toBeGreaterThan(0);

    // The row that went through is gone; the refused one stays, so a second press cannot
    // register the first one twice.
    await waitFor(() => expect(screen.queryAllByLabelText(/How many packets of .*SK6 /)).toHaveLength(0));
    expect(screen.getByLabelText(/How many packets of .*SK12/)).toBeInTheDocument();
  });
});

// One Print button, one confirmation, then straight to the default printer at sticker size.
describe("LabelsTab — printing", () => {
  afterEach(() => vi.restoreAllMocks());

  async function fillAndPress(api: ReturnType<typeof installApi>) {
    api.generateRawMaterialQrBatch.mockResolvedValue({ accepted: true, batch: BATCH_1, qrCodes: CODES_1 });
    renderTab();
    await chooseSupplier();
    await fillRun(NAME, "2", "3");
    await userEvent.click(printButton());
  }

  it("registers and prints the run on the default printer after one confirmation", async () => {
    const api = installApi();
    await fillAndPress(api);
    expect(await screen.findByRole("dialog", { name: "Print 2 labels for 1 material?" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /^🖨 Print$/ }));

    await waitFor(() => expect(api.printDocument).toHaveBeenCalledTimes(1));
    const payload = api.printDocument.mock.calls[0][0];
    expect(payload.pageSize).toEqual({ widthIn: 3, heightIn: 2 });
    expect(payload.html).toContain(CODES_1[0].id);
    expect(payload.html).toContain(CODES_1[1].id);
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
