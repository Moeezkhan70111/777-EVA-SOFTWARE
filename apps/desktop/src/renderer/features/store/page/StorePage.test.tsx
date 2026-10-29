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
const Page: React.FC<{ start?: StoreMode; access?: StoreAccess; onModeChange?: (mode: StoreMode) => void }> = ({ start = "receiving", access = ALL, onModeChange }) => {
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

  it("is titled Store, with Daily report in the header", async () => {
    installApi();
    renderPage();
    expect(screen.getByRole("heading", { level: 1, name: "Store" })).toBeInTheDocument();
    expect(screen.getByText("Raw material in and out")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Daily report" })).toBeInTheDocument();
  });

  it("shows each mode's session in words, the inactive one too", async () => {
    installApi();
    renderPage();
    await waitFor(() => expect(modeButton(/Receiving/)).toHaveTextContent("Batch open · 2 packets"));
    expect(modeButton(/Receiving/)).toHaveAttribute("aria-pressed", "true");
    expect(modeButton(/Issuing/)).toHaveTextContent("Nothing started");
    expect(modeButton(/Issuing/)).toHaveAttribute("aria-pressed", "false");
  });

  it("offers Receiving's six tabs, and Issuing's three, in order", async () => {
    installApi();
    renderPage();
    const tabsOf = (label: string) => within(screen.getByRole("tablist", { name: label })).getAllByRole("tab").map((tab) => tab.textContent);
    expect(tabsOf("Receiving sections")).toEqual(["Add material", "Labels", "Stock", "Receipts", "By hand", "Setup"]);
    // The inactive mode is hidden, from assistive technology too: Issuing's tabs appear with Issuing.
    expect(screen.queryByRole("tablist", { name: "Issuing sections" })).toBeNull();
    fireEvent.click(modeButton(/Issuing/));
    expect(tabsOf("Issuing sections")).toEqual(["By hand", "Issued today", "Stock"]);
  });

  it("shows only the tabs the account may open", async () => {
    installApi();
    renderPage({ access: { stock: false, labels: false, settings: false } });
    const receivingTabs = within(screen.getByRole("tablist", { name: "Receiving sections" })).getAllByRole("tab").map((tab) => tab.textContent);
    expect(receivingTabs).toEqual(["By hand"]);
    expect(screen.getByTestId("hand-IN")).toBeInTheDocument();
  });
});

describe("Store page — the two modes", () => {
  afterEach(() => vi.restoreAllMocks());

  it("switches to Issuing: Scan out on the right, Scan in hidden, and neither session lost", async () => {
    const api = installApi();
    renderPage();
    await waitFor(() => expect(modeButton(/Receiving/)).toHaveTextContent("Batch open"));

    fireEvent.click(modeButton(/Issuing/));
    expect(screen.getByRole("complementary", { name: "Issuing scanner" })).toBeVisible();
    expect(screen.queryByRole("complementary", { name: "Receiving scanner" })).toBeNull();

    fireEvent.click(modeButton(/Receiving/));
    expect(screen.getByRole("complementary", { name: "Receiving scanner" })).toBeVisible();
    expect(modeButton(/Receiving/)).toHaveTextContent("Batch open · 2 packets");
    expect(api.getOpenRawMaterialReceivingSession).toHaveBeenCalledTimes(1);
  });

  it("opens the Daily report for the mode on screen, in place of its tabs", async () => {
    installApi();
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Daily report" }));
    expect(screen.getAllByTestId("daily-report").map((node) => node.textContent)).toEqual(["report:IN"]);

    fireEvent.click(modeButton(/Issuing/));
    fireEvent.click(screen.getByRole("button", { name: "Daily report" }));
    expect(screen.getAllByTestId("daily-report").map((node) => node.textContent)).toEqual(["report:IN", "report:OUT"]);

    fireEvent.click(within(screen.getByRole("tablist", { name: "Issuing sections" })).getByRole("tab", { name: "By hand" }));
    expect(screen.getAllByTestId("daily-report").map((node) => node.textContent)).toEqual(["report:IN"]);
  });

  it("lists every session issued today, with its party, packets, and a reprint", async () => {
    const api = installApi();
    renderPage({ start: "issuing" });
    fireEvent.click(within(screen.getByRole("tablist", { name: "Issuing sections" })).getByRole("tab", { name: "Issued today" }));
    const list = await screen.findByRole("list");
    const row = within(list).getByText("RMO-000173").closest("li") as HTMLElement;
    expect(row).toHaveTextContent("DANIYAL");
    expect(row).toHaveTextContent("5 packets");
    expect(row).toHaveTextContent("Closed");
    expect(api.listRawMaterialIssueSessions).toHaveBeenCalledWith(expect.objectContaining({ dateFrom: expect.any(String), dateTo: expect.any(String) }));
    expect(screen.getByRole("button", { name: "Reprint slip for RMO-000173" })).toBeEnabled();
  });
});

describe("Store page — the scan rail, in three zones", () => {
  afterEach(() => vi.restoreAllMocks());

  it("waits with a question while nothing is started: who, the supplier picker, and a large Start", async () => {
    installApi({ receivingOpen: false });
    renderPage();
    const rail = screen.getByRole("complementary", { name: "Receiving scanner" });
    await waitFor(() => expect(within(rail).getByTestId("scan-zone")).toHaveAttribute("data-state", "waiting"));
    expect(within(rail).getByTestId("who-strip")).toHaveTextContent("FromNot chosen yet");
    expect(within(rail).getByTestId("scan-state")).toHaveTextContent("Whose delivery is this?");
    expect(within(rail).getByText("Choose the supplier, then press Start scanning.")).toBeInTheDocument();
    // Nothing says "ready" while the screen waits for the operator.
    expect(rail).not.toHaveTextContent(/ready/i);
    expect(within(rail).getByRole("button", { name: "Start scanning" })).toBeDisabled();
    expect(within(rail).getByLabelText("Scanner input")).toBeDisabled();
    // No session, nothing to count, nothing to end.
    expect(within(rail).queryByTestId("scan-count")).toBeNull();
    expect(within(rail).queryByRole("button", { name: "End batch" })).toBeNull();
  });

  it("with a session open: FROM the supplier and its type, ready, the count, and a quiet footer", async () => {
    installApi();
    renderPage();
    const rail = screen.getByRole("complementary", { name: "Receiving scanner" });
    await waitFor(() => expect(within(rail).getByTestId("scan-count")).toHaveTextContent("2"));
    const who = within(rail).getByTestId("who-strip");
    expect(who).toHaveTextContent("From");
    expect(who).toHaveTextContent("SHEHZAD RUBBER");
    expect(within(who).getByTestId("party-type-badge")).toHaveTextContent("Supplier");
    expect(within(rail).getByTestId("scan-state")).toHaveTextContent("Scan the next packet");
    expect(within(rail).getByText("Each packet is counted as received from SHEHZAD RUBBER.")).toBeInTheDocument();
    expect(rail).not.toHaveTextContent(/ready/i);
    // One compact row: the number, what it counts, the quantity total.
    expect(within(rail).getByTestId("scan-count")).toHaveTextContent("2packets in this batch50 KG");
    // The batch's number belongs to the footer, not the scanning view.
    expect(within(rail).getByTestId("session-line")).toHaveTextContent("RMI-000191");
    expect(within(rail).queryByRole("button", { name: "Print slip" })).toBeNull();
  });

  it("answers a scan in the half-second: accepted, then the double scan refused with the count unchanged", async () => {
    installApi();
    renderPage();
    const rail = screen.getByRole("complementary", { name: "Receiving scanner" });
    const box = await within(rail).findByLabelText("Scanner input");
    await waitFor(() => expect(box).toBeEnabled());

    await act(async () => {
      fireEvent.change(box, { target: { value: "RM_SHEHZAD_DANARED_000012" } });
      fireEvent.keyDown(box, { key: "Enter" });
    });
    await waitFor(() => expect(within(rail).getByTestId("scan-zone")).toHaveAttribute("data-state", "accepted"));
    // The category on the small line, the distinguishing part as the headline.
    expect(within(rail).getByTestId("scan-zone")).toHaveTextContent("ReceivedDana · EvaRED25 KGRM_SHEHZAD_DANARED_000012");
    // The box clears on a completed scan and keeps the focus.
    expect(box).toHaveValue("");
    expect(box).toHaveFocus();

    await act(async () => {
      fireEvent.change(box, { target: { value: "RM_SHEHZAD_DANARED_000012" } });
      fireEvent.keyDown(box, { key: "Enter" });
    });
    const alert = await within(rail).findByRole("alert");
    expect(alert).toHaveTextContent("Not received");
    expect(alert).toHaveTextContent("This packet is already in");
    expect(alert).toHaveTextContent("Put it aside and scan the next one.");
    expect(within(rail).getByTestId("scan-count")).toHaveTextContent("packets in this batch — unchanged");
  });

  it("puts Print slip in the End session step, and ends only when asked", async () => {
    const api = installApi();
    const closeRawMaterialReceivingSession = vi.fn(async () => ({ ...RECEIVING, status: "CLOSED" as const }));
    Object.assign(api, { closeRawMaterialReceivingSession });
    renderPage();
    const rail = screen.getByRole("complementary", { name: "Receiving scanner" });
    fireEvent.click(await within(rail).findByRole("button", { name: "End batch" }));

    const step = within(rail).getByRole("region", { name: "End batch RMI-000191?" });
    expect(within(step).getByRole("button", { name: "Print slip" })).toBeEnabled();
    fireEvent.click(within(step).getByRole("button", { name: "Keep scanning" }));
    expect(closeRawMaterialReceivingSession).not.toHaveBeenCalled();

    fireEvent.click(within(rail).getByRole("button", { name: "End batch" }));
    await act(async () => {
      fireEvent.click(within(within(rail).getByRole("region", { name: "End batch RMI-000191?" })).getByRole("button", { name: "End batch" }));
    });
    expect(closeRawMaterialReceivingSession).toHaveBeenCalledWith("rs-1");
  });

  it("keeps the scanner's box in view under the strip: off and saying why until a batch starts, then live", async () => {
    installApi({ receivingOpen: false });
    renderPage();
    const rail = screen.getByRole("complementary", { name: "Receiving scanner" });
    const box = within(rail).getByLabelText("Scanner input");
    expect(box).toBeVisible();
    expect(box).toBeDisabled();
    expect(box).toHaveAttribute("placeholder", "Choose the supplier first");
    expect(within(rail).queryByRole("button", { name: "Type a code" })).toBeNull();
  });

  it("gives the box the focus by itself when a batch is open, and back after the Machine programs dialog", async () => {
    installApi();
    renderPage();
    const rail = screen.getByRole("complementary", { name: "Receiving scanner" });
    const box = within(rail).getByLabelText("Scanner input");
    await waitFor(() => expect(box).toHaveFocus());
    expect(box).toHaveAttribute("placeholder", "Scan a packet");

    fireEvent.click(screen.getByRole("button", { name: "Machine programs" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getAllByRole("button", { name: /close|cancel/i })[0]);
    await waitFor(() => expect(box).toHaveFocus());
  });

  it("says one packet, not 1 packets", async () => {
    installApi({ receivedPackets: 1 });
    renderPage();
    const rail = screen.getByRole("complementary", { name: "Receiving scanner" });
    await waitFor(() => expect(within(rail).getByTestId("scan-count")).toHaveTextContent("1packet in this batch"));
  });

  it("on Scan out waits asking who it is for, with the type against each party, Start issuing, and the last session to reprint", async () => {
    const api = installApi();
    api.listRawMaterialIssueSessions.mockImplementation(async () => [ISSUE_ROW]);
    renderPage({ start: "issuing" });
    const rail = screen.getByRole("complementary", { name: "Issuing scanner" });
    expect(within(rail).getByTestId("who-strip")).toHaveTextContent("Going toNot chosen yet");
    expect(within(rail).getByTestId("scan-state")).toHaveTextContent("Who is this material for?");
    expect(within(rail).getByText("Choose who the packets are going to, then press Start scanning.")).toBeInTheDocument();
    expect(within(rail).getByRole("button", { name: "Start scanning" })).toBeDisabled();
    expect(await within(rail).findByText(/RMO-000173/)).toBeInTheDocument();
    expect(within(rail).getByRole("button", { name: "Reprint slip" })).toBeInTheDocument();
    expect(within(rail).getByRole("contentinfo", { name: "Last batch" })).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(within(rail).getByRole("combobox", { name: "Moving out to" }));
    });
    expect(await screen.findByRole("option", { name: /DANIYAL/ })).toHaveTextContent("Contractor");
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
    const box = within(screen.getByRole("complementary", { name: "Receiving scanner" })).getByLabelText("Scanner input");
    await waitFor(() => expect(box).toBeEnabled());
    box.focus();
    await act(async () => {
      fireEvent.keyDown(box, { key: "2" });
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(onModeChange).not.toHaveBeenCalled();
  });
});
