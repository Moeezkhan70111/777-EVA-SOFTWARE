import React, { useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationsProvider } from "../../../state/NotificationsContext";
import { StorePage } from "./StorePage";
import type { StoreAccess, StoreMode } from "./storeTabs";

// THE STORE PAGE (0.3.9): Receiving | Issuing on one page. The sections in the work area are existing
// screens with their own tests, so they are stand-ins here; the stations, the switch, the rails and
// the keys are the real thing.

vi.mock("../../../utils/playScanSound", () => ({ playScanSound: () => undefined }));
vi.mock("../../rawMaterial/RawMaterialSection", () => ({
  RawMaterialSection: ({ tab }: { tab: string }) => <div data-testid="rm-section">{`section:${tab}`}</div>,
}));
vi.mock("../../rawMaterial/useRawMaterialLookups", () => ({
  useRawMaterialLookups: () => ({ loading: false, error: null, categories: [], units: [], reload: async () => undefined }),
}));
vi.mock("../sections/NewMaterialForm", () => ({ NewMaterialForm: () => <div data-testid="new-material">new material form</div> }));
vi.mock("../HandMovePanel", () => ({ HandMovePanel: ({ direction }: { direction: string }) => <div data-testid={`hand-${direction}`}>by hand</div> }));
vi.mock("../dailyReport/StoreDailyReport", () => ({
  StoreDailyReport: ({ direction }: { direction: string }) => <div data-testid="daily-report">{`report:${direction}`}</div>,
}));

const SUPPLIER = { id: "sup-1", partyCode: "PTY-1", partyName: "SHEHZAD RUBBER", partyType: "SUPPLIER", status: "ACTIVE" };
const CONTRACTOR = { id: "con-1", partyCode: "PTY-2", partyName: "DANIYAL", partyType: "CONTRACTOR", status: "ACTIVE" };
const RECEIVING = {
  id: "rs-1", code: "RMI-000191", sessionNumber: 191, partyId: "sup-1", partyName: "SHEHZAD RUBBER",
  deviceId: "d1", startedBy: "store", status: "OPEN" as const, startedAt: "2026-10-30T04:00:00.000Z", closedAt: null,
};
const ISSUE_ROW = {
  session: { id: "is-9", code: "RMO-000173", sessionNumber: 173, deviceId: "d1", startedBy: "store", status: "CLOSED" as const, startedAt: "2026-10-30T03:00:00.000Z", closedAt: "2026-10-30T03:30:00.000Z" },
  partyId: "con-1", partyName: "DANIYAL", packets: 5,
};

function installApi({ receivingOpen = true, receivedPackets = 2 } = {}) {
  const api = {
    listParties: vi.fn(async () => ({ rows: [SUPPLIER, CONTRACTOR], total: 2, page: 1, pageSize: 1000 })),
    getOpenRawMaterialReceivingSession: vi.fn(async () => (receivingOpen ? RECEIVING : null)),
    getRawMaterialReceivingSessionSummary: vi.fn(async () => ({
      session: RECEIVING, totalPackets: receivedPackets,
      byMaterial: receivedPackets ? [{ itemDisplayName: "DANA — EVA — RED", packets: receivedPackets, quantity: receivedPackets * 25, unitCode: "KG" }] : [],
      scans: [],
    })),
    getOpenRawMaterialIssueSession: vi.fn(async () => null),
    getRawMaterialIssueSessionSummary: vi.fn(async () => null),
    listRawMaterialIssueSessions: vi.fn(async () => [ISSUE_ROW]),
    startRawMaterialIssueSession: vi.fn(),
    listInventoryCategories: vi.fn(async () => [
      { id: "c-dana", name: "DANA", path_name: "DANA" },
      { id: "c-eva", name: "EVA", parent_id: "c-dana", path_name: "DANA — EVA" },
    ]),
    // The first scan of LABEL takes; scanning it again is the double scan.
    rawMaterialReceiptScan: vi.fn(async (code: string) =>
      api.rawMaterialReceiptScan.mock.calls.length === 1
        ? { accepted: true, outcome: "RECEIVED", qrId: code, itemDisplayName: "DANA — EVA — RED", packingQuantity: 25, packingUnitCode: "KG" }
        : { accepted: false, outcome: "ALREADY_IN_STORE", qrId: code, reason: "This packet has already been received." }
    ),
  };
  Object.defineProperty(window, "desktop", { value: { versions: { node: "22", chrome: "128", electron: "43" }, api }, configurable: true });
  return api;
}

const ALL: StoreAccess = { stock: true, labels: true, settings: true };

/** The page with its mode held the way App holds it: in the route. */
const Page: React.FC<{ start?: StoreMode; access?: StoreAccess; onModeChange?: (mode: StoreMode) => void; showMachinePrograms?: boolean }> = ({
  start = "receiving",
  access = ALL,
  onModeChange,
  showMachinePrograms,
}) => {
  const [mode, setMode] = useState<StoreMode>(start);
  return (
    <StorePage
      mode={mode}
      token="t-1"
      username="store"
      isAdmin={false}
      access={access}
      onModeChange={(next) => {
        onModeChange?.(next);
        setMode(next);
      }}
      onNavigate={() => undefined}
      showMachinePrograms={showMachinePrograms}
    />
  );
};

const renderPage = (props: React.ComponentProps<typeof Page> = {}) =>
  render(
    <NotificationsProvider>
      <Page {...props} />
    </NotificationsProvider>
  );

const modeButton = (name: RegExp) => within(screen.getByRole("group", { name: "What the store is doing" })).getByRole("button", { name });

describe("Store page — layout", () => {
  afterEach(() => vi.restoreAllMocks());

  it("has the header design: the brand, STORE, and no buttons -- Daily report is a tab, Machine programs hidden (0.4.1)", async () => {
    installApi();
    renderPage();
    expect(screen.getByRole("img", { name: "777 SEVEN" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Store" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Daily report" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Machine programs" })).toBeNull();
  });

  it("has a splitter between the work area and the scan rail, and lays out the width remembered here", async () => {
    window.localStorage.setItem("erp.store.rail-width", "0.45");
    try {
      installApi();
      const { container } = renderPage();
      const splitter = screen.getByRole("separator", { name: "Resize the scan panel" });
      expect(splitter).toHaveAttribute("aria-valuenow", "45");
      const body = container.querySelector(".sp-body") as HTMLElement;
      expect(body.style.getPropertyValue("--sp-rail-width")).toBe("clamp(300px, 45.00%, calc(100% - 420px))");
      fireEvent.doubleClick(splitter);
      expect(body.style.getPropertyValue("--sp-rail-width")).toBe("");
      expect(window.localStorage.getItem("erp.store.rail-width")).toBeNull();
    } finally {
      window.localStorage.removeItem("erp.store.rail-width");
    }
  });

  it("shows the Machine programs button again only when asked to", async () => {
    installApi();
    renderPage({ showMachinePrograms: true });
    expect(screen.getByRole("button", { name: "Machine programs" })).toBeInTheDocument();
  });

  it("shows each mode's session in words, the inactive one too", async () => {
    installApi();
    renderPage();
    await waitFor(() => expect(modeButton(/Move in/)).toHaveTextContent("Session open · 2 packets"));
    expect(modeButton(/Move in/)).toHaveAttribute("aria-pressed", "true");
    expect(modeButton(/Move out/)).toHaveTextContent("Nothing started");
    expect(modeButton(/Move out/)).toHaveAttribute("aria-pressed", "false");
  });

  it("offers Receiving's seven tabs, and Issuing's four, in order, Daily report last in each", async () => {
    installApi();
    renderPage();
    const tabsOf = (label: string) => within(screen.getByRole("tablist", { name: label })).getAllByRole("tab").map((tab) => tab.textContent);
    expect(tabsOf("Move in sections")).toEqual(["Add material", "Labels", "Stock", "Receipts", "By hand", "Setup", "Daily report"]);
    // The inactive mode is hidden, from assistive technology too: Issuing's tabs appear with Issuing.
    expect(screen.queryByRole("tablist", { name: "Move out sections" })).toBeNull();
    fireEvent.click(modeButton(/Move out/));
    expect(tabsOf("Move out sections")).toEqual(["By hand", "Issued today", "Stock", "Daily report"]);
  });

  it("shows only the tabs the account may open", async () => {
    installApi();
    renderPage({ access: { stock: false, labels: false, settings: false } });
    const receivingTabs = within(screen.getByRole("tablist", { name: "Move in sections" })).getAllByRole("tab").map((tab) => tab.textContent);
    expect(receivingTabs).toEqual(["By hand", "Daily report"]);
    expect(screen.getByTestId("hand-IN")).toBeInTheDocument();
  });
});

describe("Store page — the two modes", () => {
  afterEach(() => vi.restoreAllMocks());

  it("switches to Issuing: Scan out on the right, Scan in hidden, and neither session lost", async () => {
    const api = installApi();
    renderPage();
    await waitFor(() => expect(modeButton(/Move in/)).toHaveTextContent("Session open"));

    fireEvent.click(modeButton(/Move out/));
    expect(screen.getByRole("complementary", { name: "Scan Out" })).toBeVisible();
    expect(screen.queryByRole("complementary", { name: "Scan Material" })).toBeNull();

    fireEvent.click(modeButton(/Move in/));
    expect(screen.getByRole("complementary", { name: "Scan Material" })).toBeVisible();
    expect(modeButton(/Move in/)).toHaveTextContent("Session open · 2 packets");
    expect(api.getOpenRawMaterialReceivingSession).toHaveBeenCalledTimes(1);
  });

  it("opens the Daily report for the mode on screen as its tab, and leaves it for another tab", async () => {
    installApi();
    renderPage();
    const tab = (list: string, name: string) => within(screen.getByRole("tablist", { name: list })).getByRole("tab", { name });
    fireEvent.click(tab("Move in sections", "Daily report"));
    expect(tab("Move in sections", "Daily report")).toHaveAttribute("aria-selected", "true");
    expect(screen.getAllByTestId("daily-report").map((node) => node.textContent)).toEqual(["report:IN"]);

    fireEvent.click(modeButton(/Move out/));
    fireEvent.click(tab("Move out sections", "Daily report"));
    expect(screen.getAllByTestId("daily-report").map((node) => node.textContent)).toEqual(["report:IN", "report:OUT"]);

    fireEvent.click(within(screen.getByRole("tablist", { name: "Move out sections" })).getByRole("tab", { name: "By hand" }));
    expect(screen.getAllByTestId("daily-report").map((node) => node.textContent)).toEqual(["report:IN"]);
  });

  it("lists every session issued today, with its party, packets, and a reprint", async () => {
    const api = installApi();
    renderPage({ start: "issuing" });
    fireEvent.click(within(screen.getByRole("tablist", { name: "Move out sections" })).getByRole("tab", { name: "Issued today" }));
    const list = await screen.findByRole("list");
    const row = within(list).getByText("RMO-000173").closest("li") as HTMLElement;
    expect(row).toHaveTextContent("DANIYAL");
    expect(row).toHaveTextContent("5 packets");
    expect(row).toHaveTextContent("Closed");
    expect(api.listRawMaterialIssueSessions).toHaveBeenCalledWith(expect.objectContaining({ dateFrom: expect.any(String), dateTo: expect.any(String) }));
    expect(screen.getByRole("button", { name: "Reprint slip for RMO-000173" })).toBeEnabled();
  });
});

describe("Store page — the scan panels, as released", () => {
  afterEach(() => vi.restoreAllMocks());

  it("hosts Scan Material as Store In had it: the supplier, Start session, READY TO SCAN", async () => {
    installApi({ receivingOpen: false });
    renderPage();
    const rail = screen.getByRole("complementary", { name: "Scan Material" });
    expect(await within(rail).findByRole("button", { name: /Start session/ })).toBeDisabled();
    expect(within(rail).getByTestId("scan-status")).toHaveTextContent("READY TO SCAN");
    expect(within(rail).getByLabelText("Scanner input")).toBeDisabled();
  });

  it("offers contractors as well as suppliers to receive from, each with its type (0.4.1)", async () => {
    installApi({ receivingOpen: false });
    renderPage();
    const rail = screen.getByRole("complementary", { name: "Scan Material" });
    await act(async () => {
      // A search box: its list opens on focus.
      fireEvent.focus(await within(rail).findByRole("combobox", { name: "Supplier" }));
    });
    expect(await screen.findByRole("option", { name: /SHEHZAD RUBBER/ })).toHaveTextContent("Supplier");
    expect(screen.getByRole("option", { name: /DANIYAL/ })).toHaveTextContent("Contractor");
  });

  it("hosts Scan Out as Store Out had it: the party with its type, New session, End session, Print slip", async () => {
    installApi();
    renderPage({ start: "issuing" });
    const rail = screen.getByRole("complementary", { name: "Scan Out" });
    expect(within(rail).getByRole("button", { name: /New session/ })).toBeDisabled();
    expect(within(rail).getByRole("button", { name: /End session/ })).toBeDisabled();
    expect(within(rail).getByRole("button", { name: /Print slip/ })).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(await within(rail).findByRole("combobox", { name: "Moving out to" }));
    });
    expect(await screen.findByRole("option", { name: /DANIYAL/ })).toHaveTextContent("Contractor");
  });

  it("gives the scanner's focus to the mode on screen only, and back after the Machine programs dialog", async () => {
    installApi();
    renderPage({ showMachinePrograms: true });
    const box = within(screen.getByRole("complementary", { name: "Scan Material" })).getByLabelText("Scanner input");
    await waitFor(() => expect(box).toHaveFocus());

    fireEvent.click(screen.getByRole("button", { name: "Machine programs" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getAllByRole("button", { name: /close|cancel/i })[0]);
    await waitFor(() => expect(box).toHaveFocus());
  });
});

describe("Store page — keys 1 and 2", () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const press = async (key: string, gapMs = 200) => {
    await act(async () => {
      fireEvent.keyDown(window, { key });
      await vi.advanceTimersByTimeAsync(gapMs);
    });
  };

  it("picks a mode on a single press when nothing that takes typing has the focus", async () => {
    installApi({ receivingOpen: false });
    const onModeChange = vi.fn();
    renderPage({ onModeChange });
    (document.activeElement as HTMLElement | null)?.blur();
    await press("2");
    expect(onModeChange).toHaveBeenLastCalledWith("issuing");
    (document.activeElement as HTMLElement | null)?.blur();
    await press("1");
    expect(onModeChange).toHaveBeenLastCalledWith("receiving");
  });

  it("ignores the digits of a scanner burst", async () => {
    installApi({ receivingOpen: false });
    const onModeChange = vi.fn();
    renderPage({ onModeChange });
    (document.activeElement as HTMLElement | null)?.blur();
    await act(async () => {
      for (const key of "RM_2_1_2") {
        fireEvent.keyDown(window, { key });
        await vi.advanceTimersByTimeAsync(5);
      }
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(onModeChange).not.toHaveBeenCalled();
  });

  it("ignores a key typed into a field", async () => {
    installApi();
    const onModeChange = vi.fn();
    renderPage({ onModeChange });
    const box = within(screen.getByRole("complementary", { name: "Scan Material" })).getByLabelText("Scanner input");
    await waitFor(() => expect(box).toBeEnabled());
    box.focus();
    await act(async () => {
      fireEvent.keyDown(box, { key: "2" });
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(onModeChange).not.toHaveBeenCalled();
  });
});
