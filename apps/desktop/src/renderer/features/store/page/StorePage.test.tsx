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

  it("offers Receiving's eight tabs, and Issuing's five, in order, Daily report last in each", async () => {
    installApi();
    renderPage();
    const tabsOf = (label: string) => within(screen.getByRole("tablist", { name: label })).getAllByRole("tab").map((tab) => tab.textContent);
    expect(tabsOf("Move in sections")).toEqual(["Add material", "Labels", "Stock", "Receipts", "By hand", "Setup", "QR Journey", "Daily report"]);
    // The inactive mode is hidden, from assistive technology too: Issuing's tabs appear with Issuing.
    expect(screen.queryByRole("tablist", { name: "Move out sections" })).toBeNull();
    fireEvent.click(modeButton(/Move out/));
    expect(tabsOf("Move out sections")).toEqual(["By hand", "Issued today", "Stock", "QR Journey", "Daily report"]);
  });

  it("shows only the tabs the account may open", async () => {
    installApi();
    renderPage({ access: { stock: false, labels: false, settings: false } });
    const receivingTabs = within(screen.getByRole("tablist", { name: "Move in sections" })).getAllByRole("tab").map((tab) => tab.textContent);
    expect(receivingTabs).toEqual(["By hand", "QR Journey", "Daily report"]);
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

  it("hosts Scan Material: Not Ready, the supplier, Ready to Scan with Start Session inside it", async () => {
    const api = Object.assign(installApi({ receivingOpen: false }), { startRawMaterialReceivingSession: vi.fn() });
    renderPage();
    const rail = screen.getByRole("complementary", { name: "Scan Material" });
    const start = await within(rail).findByRole("button", { name: /Start Session/ });
    expect(within(rail).getByRole("status")).toHaveTextContent("Not Ready");
    expect(within(rail).getByTestId("scan-status")).toHaveTextContent("Ready to Scan");
    // Nothing a scan could land in until a session is open.
    expect(within(rail).queryByLabelText("Scanner input")).toBeNull();

    // With no supplier chosen it says to choose one (a notice), and starts nothing.
    await act(async () => {
      fireEvent.click(start);
    });
    expect(api.startRawMaterialReceivingSession).not.toHaveBeenCalled();
    expect(within(rail).getByRole("status")).toHaveTextContent("Not Ready");
  });

  it("puts the open session's party, large with its type, and End Session inside the scan panel", async () => {
    installApi();
    renderPage();
    const rail = screen.getByRole("complementary", { name: "Scan Material" });
    const panel = await within(rail).findByRole("region", { name: "Scanning station" });

    const party = await within(panel).findByTestId("scan-party");
    expect(party).toHaveTextContent("Receiving from");
    expect(party).toHaveTextContent("SHEHZAD RUBBER");
    expect(within(party).getByTestId("party-type-badge")).toHaveTextContent("Supplier");
    expect(within(panel).getByRole("button", { name: "End Session" })).toBeEnabled();
    // No scanner pill on the rail: its head already says Ready.
    expect(within(rail).queryByText(/Keyboard input|Scanner ready/)).toBeNull();

    // Print Receipt is in the rail's head (beside nothing else), once, and not in the station's toolbar.
    const pill = await within(rail).findByRole("status");
    await waitFor(() => expect(pill).toHaveTextContent(/^Ready$/));
    // The head is the <header> the pill is in (inside the rail's <aside>, so it has no banner role).
    const head = pill.closest("header") as HTMLElement;
    expect(await within(head).findByRole("button", { name: "Print Receipt" })).toBeEnabled();
    expect(within(rail).getAllByRole("button", { name: /Print receipt/i })).toHaveLength(1);
  });

  it("lists the session's packets newest first: time, name, the rest, the category as a tag, QR and amount", async () => {
    const api = installApi();
    api.getRawMaterialReceivingSessionSummary.mockResolvedValue({
      session: RECEIVING,
      totalPackets: 2,
      byMaterial: [
        { itemDisplayName: "UPPER — LADIES — DC1 — 6/9", categoryLabel: "UPPER — LADIES", packets: 1, quantity: 1, unitCode: "BUNDLE" },
        { itemDisplayName: "UPPER — LADIES — DC2", categoryLabel: "UPPER — LADIES", packets: 1, quantity: 2, unitCode: "BUNDLE" },
      ],
      scans: [
        { qrId: "RM_16_802_4", itemDisplayName: "UPPER — LADIES — DC2", categoryLabel: "UPPER — LADIES", quantity: 2, unitCode: "BUNDLE", receivedAt: "2026-10-30T02:28:00.000Z", actor: "store" },
        { qrId: "RM_16_910_1", itemDisplayName: "UPPER — LADIES — DC1 — 6/9", categoryLabel: "UPPER — LADIES", quantity: 1, unitCode: "BUNDLE", receivedAt: "2026-10-30T02:31:00.000Z", actor: "store" },
      ],
    } as never);
    renderPage();
    const rail = screen.getByRole("complementary", { name: "Scan Material" });
    const list = await within(rail).findByRole("region", { name: "Recently Received" });
    expect(list).toHaveTextContent("Last 12 in this session");

    const [newest, older] = await within(list).findAllByRole("listitem");
    expect(within(newest).getByText("DC1")).toBeInTheDocument();
    expect(within(newest).getByText("6/9")).toBeInTheDocument();
    expect(within(newest).getByText("LADIES")).toBeInTheDocument();
    expect(within(newest).getByText("RM_16_910_1")).toBeInTheDocument();
    expect(within(newest).getByText("1 BUNDLE")).toBeInTheDocument();
    expect(within(older).getByText("DC2")).toBeInTheDocument();
    // The session card groups the same packets by category, packets and quantity said apart.
    const session = within(rail).getByRole("region", { name: "This Session" });
    expect(session).toHaveTextContent("UPPER · LADIES");
    expect(session).toHaveTextContent("1 packet");
    expect(within(session).getByTestId("session-total")).toHaveTextContent("2 packets");
    expect(within(session).getByTestId("session-total")).toHaveTextContent("3 BUNDLE");

    // No subtext under the rail's name any more.
    expect(within(rail).queryByText("Scan a QR code to receive material into stock.")).toBeNull();
  });

  it("has no Print Receipt in the rail's head before a session is open", async () => {
    installApi({ receivingOpen: false });
    renderPage();
    const rail = screen.getByRole("complementary", { name: "Scan Material" });
    await within(rail).findByRole("button", { name: /Start Session/ });
    expect(within(rail).queryByRole("button", { name: /Print receipt/i })).toBeNull();
  });

  it("says Ready, and arms the scanner's box, once a receiving session is open", async () => {
    installApi();
    renderPage();
    const rail = screen.getByRole("complementary", { name: "Scan Material" });
    await waitFor(() => expect(within(rail).getByRole("status")).toHaveTextContent(/^Ready$/));
    expect(within(rail).getByLabelText("Scanner input")).toBeEnabled();
    expect(within(rail).queryByRole("button", { name: /Start Session/ })).toBeNull();
  });

  it("offers suppliers only to receive from, by name with no code, and still finds one by its code (6 Nov 2026)", async () => {
    installApi({ receivingOpen: false });
    renderPage();
    const rail = screen.getByRole("complementary", { name: "Scan Material" });
    await act(async () => {
      // A search box: its list opens on focus.
      fireEvent.focus(await within(rail).findByRole("combobox", { name: "Supplier" }));
    });
    expect(await screen.findByRole("option", { name: /SHEHZAD RUBBER/ })).toHaveTextContent("Supplier");
    expect(screen.queryByRole("option", { name: /DANIYAL/ })).toBeNull();
    expect(screen.getByRole("option", { name: /SHEHZAD RUBBER/ })).not.toHaveTextContent("PTY-1");
    fireEvent.change(within(rail).getByRole("combobox", { name: "Supplier" }), { target: { value: "PTY-1" } });
    expect(screen.getByRole("option", { name: /SHEHZAD RUBBER/ })).toBeInTheDocument();
  });

  it("shows packets and what they hold on the switch: Open · 2/50", async () => {
    installApi();
    renderPage();
    await waitFor(() => expect(modeButton(/Move in/)).toHaveTextContent("Open · 2/50"));
  });

  it("hosts Scan Out as Move in has it: Not Ready, the party picker, Ready to Scan with Start Session inside", async () => {
    const api = Object.assign(installApi(), { startRawMaterialIssueSession: vi.fn() });
    renderPage({ start: "issuing" });
    const rail = screen.getByRole("complementary", { name: "Scan Out" });
    expect(rail).toHaveClass("sp-rail--out");
    expect(within(rail).getByRole("status")).toHaveTextContent("Not Ready");
    const panel = await within(rail).findByRole("region", { name: "Scanning station" });
    expect(within(panel).getByTestId("scan-status")).toHaveTextContent("Ready to Scan");
    expect(within(rail).queryByLabelText("Scanner input")).toBeNull();
    expect(within(rail).queryByRole("button", { name: /Print/i })).toBeNull();

    // With no party chosen it says to choose one, and starts nothing.
    await act(async () => {
      fireEvent.click(within(panel).getByRole("button", { name: /Start Session/ }));
    });
    expect(api.startRawMaterialIssueSession).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(await within(rail).findByRole("combobox", { name: "Moving out to" }));
    });
    expect(await screen.findByRole("option", { name: /DANIYAL/ })).toHaveTextContent("Contractor");
  });

  it("shows Print Receipt on Move out as soon as a session opens, before any packet, as on Move in", async () => {
    const api = installApi();
    const ISSUING = { id: "is-2", code: "RMO-000175", sessionNumber: 175, deviceId: "d1", startedBy: "store", status: "OPEN" as const, startedAt: "2026-10-30T06:00:00.000Z", closedAt: null };
    api.getOpenRawMaterialIssueSession.mockResolvedValue(ISSUING as never);
    api.getRawMaterialIssueSessionSummary.mockResolvedValue({
      session: ISSUING, partyId: "con-1", partyName: "DANIYAL", totalPackets: 0, byMaterial: [], bySection: [], scans: [],
    } as never);
    renderPage({ start: "issuing" });
    const rail = screen.getByRole("complementary", { name: "Scan Out" });
    expect(await within(rail).findByRole("button", { name: "Print Receipt" })).toBeEnabled();
  });

  it("puts an open Move out session's party, End Session, its list and Print Receipt where Move in has them", async () => {
    const api = installApi();
    const ISSUING = { id: "is-1", code: "RMO-000174", sessionNumber: 174, deviceId: "d1", startedBy: "store", status: "OPEN" as const, startedAt: "2026-10-30T05:00:00.000Z", closedAt: null };
    api.getOpenRawMaterialIssueSession.mockResolvedValue(ISSUING as never);
    api.getRawMaterialIssueSessionSummary.mockResolvedValue({
      session: ISSUING,
      partyId: "con-1",
      partyName: "DANIYAL",
      totalPackets: 1,
      byMaterial: [{ itemDisplayName: "DANA — EVA — RED", categoryLabel: "DANA — EVA", packets: 1, quantity: 25, unitCode: "KG" }],
      bySection: [],
      scans: [{ qrId: "RM_1_1_1", itemDisplayName: "DANA — EVA — RED", categoryLabel: "DANA — EVA", quantity: 25, unitCode: "KG", sectionName: null, issuedAt: "2026-10-30T05:10:00.000Z", actor: "store" }],
    } as never);
    renderPage({ start: "issuing" });
    const rail = screen.getByRole("complementary", { name: "Scan Out" });
    const panel = await within(rail).findByRole("region", { name: "Scanning station" });

    const party = await within(panel).findByTestId("scan-party");
    expect(party).toHaveTextContent("Moving out to");
    expect(party).toHaveTextContent("DANIYAL");
    expect(within(party).getByTestId("party-type-badge")).toHaveTextContent("Contractor");
    expect(within(panel).getByRole("button", { name: "End Session" })).toBeEnabled();
    expect(await within(rail).findByRole("button", { name: "Print Receipt" })).toBeEnabled();
    expect(within(rail).queryByText(/Keyboard input|Scanner ready/)).toBeNull();

    const session = within(rail).getByRole("region", { name: "This Session" });
    expect(session).toHaveTextContent("DANA · EVA");
    expect(within(session).getByTestId("session-total")).toHaveTextContent("25 KG");
    const recent = within(rail).getByRole("region", { name: "Recently Issued" });
    expect(within(recent).getByText("RM_1_1_1")).toBeInTheDocument();
  });

  it("gives the scanner's focus to the mode on screen only, and back after the Machine programs dialog", async () => {
    installApi();
    renderPage({ showMachinePrograms: true });
    const box = await within(screen.getByRole("complementary", { name: "Scan Material" })).findByLabelText("Scanner input");
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
    const box = await within(screen.getByRole("complementary", { name: "Scan Material" })).findByLabelText("Scanner input");
    await waitFor(() => expect(box).toBeEnabled());
    box.focus();
    await act(async () => {
      fireEvent.keyDown(box, { key: "2" });
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(onModeChange).not.toHaveBeenCalled();
  });
});
