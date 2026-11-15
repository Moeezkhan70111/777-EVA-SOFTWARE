import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NotificationsProvider } from "../../../state/NotificationsContext";
import { HandVoucherPanel } from "./HandVoucherPanel";

// The store hand voucher on Store > Move in / Move out > By hand: several materials to or from one party, saved as one
// numbered voucher, then printed, edited, deleted, and found again by number or Previous / Next. Every rule is the data
// layer's (handVouchers.test.ts); this proves the screen sends what was typed and shows what came back.

const NAWAAR = { id: "item-nawaar", item_code: "RM-0001", display_name: "NAWAAR — 5 SOOTAR — BLACK" };
const DANA = { id: "item-dana", item_code: "RM-0002", display_name: "DANA — EVA — WHITE" };
const SUPPLIER = { id: "party-1", partyCode: "PTY000001", partyName: "SHEHZAD RUBBER", partyType: "SUPPLIER", status: "ACTIVE" };
const CONTRACTOR = { id: "party-2", partyCode: "PTY000002", partyName: "ASLAM", partyType: "CONTRACTOR", status: "ACTIVE" };

/** Moving out, the store holds 50 KG of Dana and 1,950 INCH of nawaar. */
const unitsOf = (itemId: string, direction = "IN") =>
  itemId === NAWAAR.id
    ? { itemId, itemCode: "RM-0001", displayName: NAWAAR.display_name, stockUnitCode: "INCH", stockUnitId: "u-inch", quantityOnHand: direction === "OUT" ? 1950 : 0, units: ["RULE", "INCH"], steps: [{ fromUnit: "RULE", toUnit: "INCH", factor: 975 }], labelledPacketsInStore: 0, blockedReason: null }
    : { itemId, itemCode: "RM-0002", displayName: DANA.display_name, stockUnitCode: "KG", stockUnitId: "u-kg", quantityOnHand: direction === "OUT" ? 50 : 0, units: ["KG"], steps: [], labelledPacketsInStore: 0, blockedReason: null };

type FakeVoucher = Record<string, unknown> & { id: string; voucherNumber: number };

const voucher = (voucherNumber: number, overrides: Record<string, unknown> = {}): FakeVoucher => ({
  id: `v-${voucherNumber}`,
  direction: "IN",
  voucherNumber,
  code: `SIV-${String(voucherNumber).padStart(6, "0")}`,
  businessDate: "2026-11-15",
  partyId: SUPPLIER.id,
  partyName: SUPPLIER.partyName,
  note: null,
  status: "POSTED",
  revision: 1,
  createdBy: "aslam",
  createdAt: "2026-11-15T09:00:00.000Z",
  updatedBy: null,
  updatedAt: "2026-11-15T09:00:00.000Z",
  deletedBy: null,
  deletedAt: null,
  editable: true,
  lines: [{ lineNo: 1, itemId: DANA.id, itemName: DANA.display_name, typedQuantity: 50, typedUnitCode: "KG", quantity: 50, stockUnitCode: "KG" }],
  ...overrides,
});

function createFakeBackend(stored: FakeVoucher[] = []) {
  const ofSide = (direction: string) => stored.filter((entry) => entry.direction === direction);
  const view = (wanted: number | null, direction: string) => {
    const side = ofSide(direction);
    const all = side.map((entry) => entry.voucherNumber).sort((a, b) => a - b);
    const latestNumber = all.length ? all[all.length - 1]! : null;
    const target = wanted ?? latestNumber;
    return {
      accepted: true,
      view: {
        voucher: side.find((entry) => entry.voucherNumber === target) ?? null,
        previousNumber: target === null ? null : ([...all].reverse().find((n) => n < target) ?? null),
        nextNumber: target === null ? null : (all.find((n) => n > target) ?? null),
        latestNumber,
      },
    };
  };
  const api = {
    listInventoryItems: vi.fn(async () => [NAWAAR, DANA]),
    listParties: vi.fn(async () => ({ rows: [SUPPLIER, CONTRACTOR], total: 2, page: 1, pageSize: 1000 })),
    getRawMaterialHandMoveOptions: vi.fn(async (itemId: string, direction: string) => unitsOf(itemId, direction)),
    getHandVoucher: vi.fn(async (direction: string, voucherNumber: number | null) => view(voucherNumber, direction)),
    saveHandVoucher: vi.fn(async (input: { requestId: string; lines: unknown[] }) => {
      const saved = voucher(100002, { lines: [{ lineNo: 1, itemId: NAWAAR.id, itemName: NAWAAR.display_name, typedQuantity: 3, typedUnitCode: "RULE", quantity: 2925, stockUnitCode: "INCH" }] });
      stored.push(saved);
      return { accepted: true, voucher: saved, sent: input };
    }),
    editHandVoucher: vi.fn(async () => ({ accepted: false, reason: "DANA — EVA — WHITE on this voucher has already been used: only 10 KG of it is still loose in the store. Nothing was changed." })),
    deleteHandVoucher: vi.fn(async (input: { voucherId: string }) => {
      const index = stored.findIndex((entry) => entry.id === input.voucherId);
      stored[index] = { ...stored[index]!, status: "DELETED", editable: false, revision: 2, deletedBy: "aslam" };
      return { accepted: true, voucher: stored[index] };
    }),
  };
  Object.defineProperty(window, "desktop", { value: { versions: { node: "22", chrome: "128", electron: "43" }, api }, configurable: true });
  return api;
}

const renderPanel = (direction: "IN" | "OUT" = "IN") =>
  render(
    <NotificationsProvider>
      <HandVoucherPanel direction={direction} token="token-1" username="aslam" />
    </NotificationsProvider>
  );

/** Finds a control, waits until it can be used, then presses it. The find is outside act: inside it, React holds the
 * very updates the find is waiting for. */
const press = async (find: () => Promise<HTMLElement>) => {
  const control = await find();
  await waitFor(() => expect(control).toBeEnabled());
  await act(async () => {
    fireEvent.click(control);
  });
};

const pick = async (comboName: string, optionName: RegExp) => {
  await press(() => screen.findByRole("combobox", { name: comboName }));
  await press(() => screen.findByRole("option", { name: optionName }));
};

describe("Move In voucher", () => {
  it("saves several materials from one supplier as one voucher, leaving the empty line out", async () => {
    const api = createFakeBackend([voucher(100000), voucher(100001)]);
    renderPanel();

    await pick("Supplier", /SHEHZAD RUBBER/);
    await pick("Material for line 1", /NAWAAR/);
    await waitFor(() => expect(screen.getByLabelText("Unit for line 1")).toHaveValue("INCH"));
    fireEvent.change(screen.getByLabelText("Unit for line 1"), { target: { value: "RULE" } });
    fireEvent.change(screen.getByLabelText("Quantity for line 1"), { target: { value: "3" } });
    expect(screen.getByText("= 2925 INCH")).toBeInTheDocument();

    // A second line opened by itself when the first was filled.
    await pick("Material for line 2", /DANA/);
    fireEvent.change(screen.getByLabelText("Quantity for line 2"), { target: { value: "50" } });
    expect(screen.getByLabelText("Material for line 3")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save voucher" }));
    });

    expect(api.saveHandVoucher).toHaveBeenCalledTimes(1);
    const [sent] = api.saveHandVoucher.mock.calls[0]!;
    expect(sent).toMatchObject({
      partyId: SUPPLIER.id,
      note: null,
      lines: [
        { itemId: NAWAAR.id, quantity: "3", unitCode: "RULE" },
        { itemId: DANA.id, quantity: "50", unitCode: "KG" },
      ],
    });
    expect(sent.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await screen.findByRole("heading", { name: "SIV-100002" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Print slip" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Edit" })).toBeEnabled();
  });

  it("refuses to save a material twice, before sending", async () => {
    const api = createFakeBackend();
    renderPanel();
    await pick("Supplier", /SHEHZAD RUBBER/);
    await pick("Material for line 1", /DANA/);
    fireEvent.change(screen.getByLabelText("Quantity for line 1"), { target: { value: "5" } });
    await pick("Material for line 2", /DANA/);
    fireEvent.change(screen.getByLabelText("Quantity for line 2"), { target: { value: "2" } });

    expect(screen.getAllByText(/already on the voucher/)).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Save voucher" })).toBeDisabled();
    expect(api.saveHandVoucher).not.toHaveBeenCalled();
  });

  it("steps through stored vouchers with Previous and Next, and opens one by number", async () => {
    const api = createFakeBackend([voucher(100000), voucher(100001), voucher(100005)]);
    renderPanel();

    const previous = await screen.findByTestId("hand-voucher-prev");
    await waitFor(() => expect(previous).toBeEnabled());
    await act(async () => {
      fireEvent.click(previous);
    });
    expect(await screen.findByRole("heading", { name: "SIV-100005" })).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByTestId("hand-voucher-prev"));
    });
    expect(await screen.findByRole("heading", { name: "SIV-100001" })).toBeInTheDocument();
    expect(api.getHandVoucher).toHaveBeenLastCalledWith("IN", 100001, { token: "token-1" });

    const box = screen.getByTestId("hand-voucher-number-input");
    fireEvent.change(box, { target: { value: "100000" } });
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" });
    });
    expect(await screen.findByRole("heading", { name: "SIV-100000" })).toBeInTheDocument();

    // Next past the newest is a new voucher again.
    fireEvent.change(box, { target: { value: "100005" } });
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" });
    });
    await screen.findByRole("heading", { name: "SIV-100005" });
    await act(async () => {
      fireEvent.click(screen.getByTestId("hand-voucher-next"));
    });
    expect(await screen.findByRole("button", { name: "Save voucher" })).toBeInTheDocument();
  });

  it("deletes today's voucher after asking, and shows it kept and marked deleted", async () => {
    const api = createFakeBackend([voucher(100000)]);
    renderPanel();
    await press(() => screen.findByTestId("hand-voucher-prev"));
    await press(() => screen.findByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    });

    expect(api.deleteHandVoucher).toHaveBeenCalledWith({ voucherId: "v-100000", revision: 1 }, { token: "token-1" });
    expect(await screen.findByText(/Deleted$/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Print slip" })).toBeDisabled();
  });

  it("edits a voucher in the form, and shows the data layer's refusal as it is", async () => {
    const api = createFakeBackend([voucher(100000)]);
    renderPanel();
    await press(() => screen.findByTestId("hand-voucher-prev"));
    await press(() => screen.findByRole("button", { name: "Edit" }));
    const quantity = await screen.findByLabelText("Quantity for line 1");
    expect(quantity).toHaveValue("50");
    await waitFor(() => expect(screen.getByLabelText("Unit for line 1")).toHaveValue("KG"));
    fireEvent.change(quantity, { target: { value: "20" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    });

    expect(api.editHandVoucher).toHaveBeenCalledWith(
      { partyId: SUPPLIER.id, note: null, lines: [{ itemId: DANA.id, quantity: "20", unitCode: "KG" }], voucherId: "v-100000", revision: 1 },
      { token: "token-1" }
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("already been used: only 10 KG");
  });

  it("an earlier day's voucher can be read and printed, not changed", async () => {
    createFakeBackend([voucher(100000, { editable: false, businessDate: "2026-11-14" })]);
    renderPanel();
    await press(() => screen.findByTestId("hand-voucher-prev"));
    expect(await screen.findByText("Only today's vouchers can be edited or deleted.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Print slip" })).toBeEnabled();
  });
});

describe("Move Out voucher", () => {
  it("issues several materials to a contractor, capped at what is in the store, and says what for", async () => {
    const api = createFakeBackend();
    renderPanel("OUT");

    await pick("Moving out to", /ASLAM/);
    await pick("Material for line 1", /DANA/);
    expect(await screen.findByText("In store 50 KG")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Quantity for line 1"), { target: { value: "60" } });
    expect(screen.getByText(/Only 50 KG is in the store/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save voucher" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Quantity for line 1"), { target: { value: "30" } });
    expect(screen.getByRole("button", { name: "Save voucher" })).toBeDisabled();
    expect(screen.getByText("Say what this is going out for before saving.")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("Where it went — e.g. cutting table"), { target: { value: "cutting table" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save voucher" }));
    });

    const [sent] = api.saveHandVoucher.mock.calls[0]!;
    expect(sent).toMatchObject({ direction: "OUT", partyId: CONTRACTOR.id, note: "cutting table", lines: [{ itemId: DANA.id, quantity: "30", unitCode: "KG" }] });
    expect(api.getRawMaterialHandMoveOptions).toHaveBeenCalledWith(DANA.id, "OUT", { token: "token-1" });
  });

  it("editing counts what the voucher already took out: 40 out and 50 in the store allows up to 90", async () => {
    createFakeBackend([
      voucher(100000, {
        direction: "OUT", code: "SOV-100000", partyId: CONTRACTOR.id, partyName: "ASLAM", note: "cutting table",
        lines: [{ lineNo: 1, itemId: DANA.id, itemName: DANA.display_name, typedQuantity: 40, typedUnitCode: "KG", quantity: 40, stockUnitCode: "KG" }],
      }),
    ]);
    renderPanel("OUT");
    await press(() => screen.findByTestId("hand-voucher-prev"));
    expect(await screen.findByRole("heading", { name: "SOV-100000" })).toBeInTheDocument();
    expect(screen.getByText("What for: cutting table")).toBeInTheDocument();
    await press(() => screen.findByRole("button", { name: "Edit" }));

    const quantity = await screen.findByLabelText("Quantity for line 1");
    expect(await screen.findByText("In store 90 KG")).toBeInTheDocument();
    fireEvent.change(quantity, { target: { value: "90" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
    fireEvent.change(quantity, { target: { value: "95" } });
    expect(screen.getByText(/Only 90 KG is in the store/)).toBeInTheDocument();
  });
});
