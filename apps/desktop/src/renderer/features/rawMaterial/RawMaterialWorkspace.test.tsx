import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RawMaterialWorkspace } from "./RawMaterialWorkspace";
import { NotificationsProvider } from "../../state/NotificationsContext";
import type { RawMaterialMovementConfigRow, WriteLeaseStatus } from "../../types/desktopApi";

// The workspace replaced six separately-permissioned pages, so the two things worth pinning
// down are (a) that a user still sees exactly what their permissions used to open, and
// (b) that the facts which used to live on three different screens — stock, packing and
// route — now read off one row.

const CATEGORIES = [
  {
    id: "cat-1",
    name: "RUBBER UPPER",
    fields: [
      {
        id: "f-1",
        field_key: "COLOR",
        label: "COLOR",
        field_type: "DROPDOWN",
        is_required: 1,
        is_searchable: 1,
        options: [{ id: "o-1", option_value: "RED", display_label: "RED" }],
      },
    ],
  },
];

const UNITS = [{ id: "u-1", code: "DOZ", name: "Dozen" }];

const ITEMS = [
  {
    id: "item-ready",
    item_code: "RM-000001",
    display_name: "RUBBER UPPER — SK6 — RED — 7/10",
    category_name: "RUBBER UPPER",
    default_unit_id: "u-1",
    unit_code: "DOZ",
    quantity_on_hand: 12,
    cost_price: 450,
    values: [{ field_key: "COLOR", label: "COLOR", field_type: "DROPDOWN", text_value: "RED", number_value: null }],
  },
  {
    id: "item-bare",
    item_code: "RM-000002",
    display_name: "RAGZINE — BLACK",
    category_name: "RAGZINE",
    default_unit_id: "u-1",
    unit_code: "DOZ",
    quantity_on_hand: 0,
    cost_price: null,
    values: [],
  },
];

const CONFIG: RawMaterialMovementConfigRow[] = [
  {
    itemId: "item-ready",
    itemCode: "RM-000001",
    displayName: "RUBBER UPPER — SK6 — RED — 7/10",
    packName: "PACKET",
    packingQuantity: 2,
    packetsInStore: 2,
    packingUnitId: "u-1",
    packingUnitCode: "DOZ",
    stockUnitId: "u-1",
    stockUnitCode: "DOZ",
    packingConvertsToStock: true,
    packSizeInStockUnit: 2,
    defaultSectionId: "ws-1",
    defaultSectionName: "PACKING",
    hops: [{ hopIndex: 1, sectionId: "ws-1", sectionName: "PACKING" }],
  },
  {
    itemId: "item-bare",
    itemCode: "RM-000002",
    displayName: "RAGZINE — BLACK",
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
];

function installApi(storeLease: WriteLeaseStatus | null = null) {
  const api = {
    getWriteLeases: vi.fn(async () => (storeLease ? [storeLease] : [])),
    listInventoryCategories: vi.fn(async () => CATEGORIES),
    listInventoryUnits: vi.fn(async () => UNITS),
    listRawMaterialMovementConfig: vi.fn(async () => CONFIG),
    listWorkSections: vi.fn(async () => [{ id: "ws-1", sectionCode: "WS-000001", name: "PACKING", status: "ACTIVE" }]),
    listInventoryItems: vi.fn(async () => ITEMS),
    listInventoryItemUnitLadders: vi.fn(async () => ({})),
    queryInventoryStock: vi.fn(async () => ({
      itemCount: 2,
      totalsByUnit: [{ unitId: "u-1", unitCode: "DOZ", quantity: 12 }],
    })),
    listInventoryStockEvents: vi.fn(async () => []),
    listStockCorrectionRequests: vi.fn(async () => []),
    listStockCorrectionRequestsForItem: vi.fn(async () => []),
    listParties: vi.fn(async () => ({ rows: [], total: 0 })),
    listRawMaterialQrBatches: vi.fn(async () => []),
    listPurchaseVouchers: vi.fn(async () => ({ rows: [], total: 0 })),
    listRawMaterialReceivingSessions: vi.fn(async () => []),
  };

  Object.defineProperty(window, "desktop", {
    value: { versions: { node: "22", chrome: "128", electron: "43" }, api },
    configurable: true,
  });
  return api;
}

const renderWorkspace = (permissions: string[]) =>
  render(
    <NotificationsProvider>
      <RawMaterialWorkspace permissions={permissions} allowAll={false} onNavigate={vi.fn()} />
    </NotificationsProvider>
  );

describe("RawMaterialWorkspace", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows counted packets, the measured total and the route for each material on one row", async () => {
    installApi();
    renderWorkspace(["stock"]);

    await waitFor(() => expect(screen.getByText("RUBBER UPPER — SK6 — RED — 7/10")).toBeInTheDocument());

    const ready = screen.getByText("RUBBER UPPER — SK6 — RED — 7/10").closest("tr")!;
    // Two labelled packets in the store holding 12 dozen between them — counted, not divided.
    expect(ready).toHaveTextContent("2 PACKETS");
    expect(ready).toHaveTextContent("12");

    // Raw material routes were removed on 2026-10-07, so no row names a destination.
    const bare = screen.getByText("RAGZINE — BLACK").closest("tr")!;
    expect(bare).not.toHaveTextContent("No route");
  });

  it("on a computer that does not keep the store, shows the measured balance, never a packet count", async () => {
    // Scans do not travel, so a reader's packets all read as unscanned: its "count" would be made up.
    installApi({ domain: "RAW_MATERIAL_STORE", canWrite: false, reason: "HELD_ELSEWHERE", holderLabel: "Store PC" });
    renderWorkspace(["stock"]);

    await waitFor(() => expect(screen.getByText("RUBBER UPPER — SK6 — RED — 7/10")).toBeInTheDocument());
    const ready = screen.getByText("RUBBER UPPER — SK6 — RED — 7/10").closest("tr")!;
    await waitFor(() => expect(ready).not.toHaveTextContent("PACKETS"));
    expect(ready.querySelectorAll("td")[1]).toHaveTextContent("12DOZ");
  });

  it("no longer asks for setup: routes are gone and a packet's contents are typed per label run", async () => {
    installApi();
    renderWorkspace(["stock"]);

    await waitFor(() => expect(screen.getByText("RUBBER UPPER — SK6 — RED — 7/10")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /need setup/i })).not.toBeInTheDocument();
    // The material that used to be flagged is an ordinary row now.
    expect(screen.getByText("RAGZINE — BLACK")).toBeInTheDocument();
  });

  it("shows a stock user the Stock and Receipts tabs, and neither Labels nor Setup", async () => {
    installApi();
    renderWorkspace(["stock"]);

    await waitFor(() => expect(screen.getByRole("tab", { name: "Stock" })).toBeInTheDocument());
    expect(screen.getByRole("tab", { name: "Receipts" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Labels" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Setup" })).not.toBeInTheDocument();
  });

  it("gives a label-generator-only user exactly the one screen they could open before", async () => {
    installApi();
    renderWorkspace(["raw-material-qr-generator"]);

    await waitFor(() => expect(screen.getByText("Select Supplier")).toBeInTheDocument());
    // A single allowed tab needs no tab strip.
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Stock" })).not.toBeInTheDocument();
  });

  it("keeps the operator on the tab they chose when the parent re-renders", async () => {
    installApi();
    const { rerender } = render(
      <NotificationsProvider>
        <RawMaterialWorkspace permissions={["stock", "settings"]} allowAll={false} onNavigate={vi.fn()} />
      </NotificationsProvider>
    );

    await userEvent.click(await screen.findByRole("tab", { name: "Setup" }));
    await waitFor(() => expect(screen.getByRole("tab", { name: "Setup" })).toHaveAttribute("aria-selected", "true"));

    // App hands down a fresh permissions array on every render (session refresh, a toast, …).
    rerender(
      <NotificationsProvider>
        <RawMaterialWorkspace permissions={["stock", "settings"]} allowAll={false} onNavigate={vi.fn()} />
      </NotificationsProvider>
    );

    expect(screen.getByRole("tab", { name: "Setup" })).toHaveAttribute("aria-selected", "true");
  });

  it("opens the Setup tab directly for the Settings deep link", async () => {
    installApi();
    render(
      <NotificationsProvider>
        <RawMaterialWorkspace initialTab="setup" permissions={["settings"]} allowAll={false} onNavigate={vi.fn()} />
      </NotificationsProvider>
    );

    // Units & conversions and Destinations were removed from Setup on 2026-10-07.
    await waitFor(() => expect(screen.getByRole("navigation", { name: "Raw material categories" })).toBeInTheDocument());
    expect(screen.queryByText("Units & conversions")).not.toBeInTheDocument();
    expect(screen.queryByText("Destinations")).not.toBeInTheDocument();
    const categoryNav = screen.getByRole("navigation", { name: "Raw material categories" });
    expect(categoryNav).toHaveTextContent("RUBBER UPPER");
  });
});

// ─── data arriving from another computer (shared/dataChange.ts) ─────────────

describe("RawMaterialWorkspace when data changes underneath it", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Installs the API with a subscription the test can fire, as the main process would. */
  function installLiveApi() {
    const api = installApi();
    const listeners = new Set<(change: unknown) => void>();
    const onDataChanged = vi.fn((listener: (change: unknown) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    });
    Object.defineProperty(window, "desktop", {
      value: { versions: { node: "22", chrome: "128", electron: "43" }, api: { ...api, onDataChanged } },
      configurable: true,
    });
    const announce = (kinds: string[]) => listeners.forEach((listener) => listener({ kinds }));
    return { api, announce, listeners };
  }

  it("updates the stock in place when stock arrives: no refresh, no loading state, same screen", async () => {
    const { api, announce } = installLiveApi();
    renderWorkspace(["stock"]);
    const before = await screen.findByText("RAGZINE — BLACK");
    expect(before.closest("tr")).toHaveTextContent("0");

    // Another computer received 37 dozen of it.
    api.listInventoryItems.mockResolvedValue(ITEMS.map((item) => (item.id === "item-bare" ? { ...item, quantity_on_hand: 37 } : item)));
    const reads = api.listInventoryItems.mock.calls.length;
    announce(["STOCK", "SYNC"]);

    await waitFor(() => expect(screen.getByText("RAGZINE — BLACK").closest("tr")).toHaveTextContent("37"));
    expect(api.listInventoryItems.mock.calls.length).toBe(reads + 1);
    expect(screen.queryByText("Loading raw materials…")).toBeNull();
    // The same row element: the table was never taken down and rebuilt.
    expect(screen.getByText("RAGZINE — BLACK")).toBe(before);
  });

  it("ignores a change of something the screen does not show, and reloads once for a burst", async () => {
    const { api, announce } = installLiveApi();
    renderWorkspace(["stock"]);
    await screen.findByText("RAGZINE — BLACK");
    const reads = api.listInventoryItems.mock.calls.length;

    announce(["PARTIES"]);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(api.listInventoryItems.mock.calls.length).toBe(reads);

    announce(["STOCK"]);
    announce(["MATERIALS"]);
    announce(["STOCK"]);
    await waitFor(() => expect(api.listInventoryItems.mock.calls.length).toBe(reads + 1));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(api.listInventoryItems.mock.calls.length).toBe(reads + 1);
  });

  it("stops listening when the screen closes", async () => {
    const { listeners } = installLiveApi();
    const { unmount } = renderWorkspace(["stock"]);
    await screen.findByText("RAGZINE — BLACK");
    expect(listeners.size).toBeGreaterThan(0);
    unmount();
    expect(listeners.size).toBe(0);
  });
});
