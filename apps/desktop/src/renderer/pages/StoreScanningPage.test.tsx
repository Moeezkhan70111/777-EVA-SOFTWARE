import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoreScanningPage } from "./StoreScanningPage";
import { NotificationsProvider } from "../state/NotificationsContext";
import type {
  StoreEntryScanResult,
  StoreReceivedRow,
  StoreReceivingSession,
  StoreReceivingSessionSummary,
} from "../types/desktopApi";

// The page is driven exactly as a scanner drives it: text typed into the focused input.
// The "business layer" here is a small in-memory store behind the mocked desktop API that
// answers like the real use case does — so the page is tested against real outcomes, not
// canned strings.

vi.mock("../utils/playScanSound", () => ({ playScanSound: vi.fn() }));

const SESSION: StoreReceivingSession = {
  id: "session-1",
  code: "SR-000184",
  sessionNumber: 184,
  deviceId: "desktop-main",
  startedBy: "store-op",
  status: "OPEN",
  startedAt: "2026-09-16T08:00:00.000Z",
  closedAt: null,
};

type UnitStatus = "PRODUCED" | "WAREHOUSE" | "DISPATCHED";

function createFakeBackend(initial: Record<string, UnitStatus>) {
  const units = new Map<string, UnitStatus>(Object.entries(initial));
  const received: StoreReceivedRow[] = [];
  let clock = 0;

  const summary = (): StoreReceivingSessionSummary => {
    const tally = new Map<string, { article: string; color: string; size: string; count: number }>();
    for (const r of received) {
      const key = `${r.article}|${r.color}|${r.size}`;
      const entry = tally.get(key) ?? { article: r.article, color: r.color, size: r.size, count: 0 };
      entry.count += 1;
      tally.set(key, entry);
    }
    const recent = [...received].reverse();
    return {
      session: SESSION,
      receivedCount: received.length,
      byProduct: [...tally.values()].sort((a, b) => b.count - a.count),
      recent,
      lastReceived: recent[0] ?? null,
    };
  };

  const storeEntryScan = vi.fn(async (raw: string): Promise<StoreEntryScanResult> => {
    const [article, color, size, serial] = raw.split("_");
    const status = units.get(raw);
    if (!status) return { accepted: false, outcome: "UNKNOWN_QR", qrId: raw, reason: "This QR is not registered.", article, color, size, serial };
    if (status === "WAREHOUSE") {
      return { accepted: false, outcome: "ALREADY_IN_STORE", qrId: raw, reason: "This carton has already been received.", article, color, size, serial, previousStatus: "WAREHOUSE", currentStatus: "WAREHOUSE" };
    }
    if (status === "DISPATCHED") {
      return { accepted: false, outcome: "NOT_ELIGIBLE", qrId: raw, reason: "This carton has already been dispatched to a customer.", article, color, size, serial, previousStatus: "DISPATCHED", currentStatus: "DISPATCHED" };
    }
    units.set(raw, "WAREHOUSE");
    clock += 1;
    const receivedAt = new Date(Date.UTC(2026, 8, 16, 8, 15, clock)).toISOString();
    const eventId = `evt-${clock}`;
    received.push({ eventId, qrId: raw, article, color, size, serial, receivedAt, actor: "store-op" });
    return { accepted: true, outcome: "RECEIVED", qrId: raw, article, color, size, serial, previousStatus: "PRODUCED", currentStatus: "WAREHOUSE", receivedAt, eventId, sessionId: SESSION.id };
  });

  const api = {
    storeEntryScan,
    getStoreReceivingSession: vi.fn(async () => ({ accepted: true, session: SESSION })),
    getStoreReceivingSessionSummary: vi.fn(async () => summary()),
    getScannerStatus: vi.fn(async () => true),
    getQrDetail: vi.fn(async (qrId: string) => ({
      qrId,
      article: "SK6",
      color: "RED",
      size: "7/10",
      serial: qrId.slice(-6),
      stage: "WAREHOUSE",
      productVariantId: "pv-1",
      sellingPrice: 550,
      stockOnHand: 12,
      registry: { status: "GENERATED", registeredAt: "2026-09-15T05:32:00.000Z", voidReason: null, voidedAt: null, voidedBy: null },
      batch: null,
      lifecycle: { currentStatus: "WAREHOUSE", locationType: "WAREHOUSE", locationId: "factory-777", firstScannedAt: "2026-09-15T06:00:00.000Z", updatedAt: "2026-09-16T08:15:01.000Z" },
      events: [
        { id: "e1", eventType: "PRODUCED", subType: null, occurredAt: "2026-09-15T06:00:00.000Z", factory: "777", workstation: "Line 1", operator: null, deviceId: "d", note: null, syncStatus: "PENDING" },
        { id: "e2", eventType: "MOVED", subType: "STORE_ENTRY", occurredAt: "2026-09-16T08:15:01.000Z", factory: "777", workstation: "Line 1", operator: null, deviceId: "d", note: "FACTORY → WAREHOUSE · by store-op", syncStatus: "PENDING" },
      ],
    })),
  };

  Object.defineProperty(window, "desktop", {
    value: { versions: { node: "22", chrome: "128", electron: "43" }, api },
    configurable: true,
  });

  return { api, units, received };
}

const renderPage = () =>
  render(
    <NotificationsProvider>
      <StoreScanningPage token="token-1" username="store-op" />
    </NotificationsProvider>
  );

/** Types a code into the scanner input and lets the auto-submit fire. */
const scanCode = async (code: string) => {
  const input = screen.getByLabelText("Scanner input") as HTMLInputElement;
  await act(async () => {
    fireEvent.change(input, { target: { value: code } });
    await vi.advanceTimersByTimeAsync(60);
  });
};

describe("StoreScanningPage", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("opens ready to scan with the session, a zero counter and the scanner focused", async () => {
    createFakeBackend({});
    renderPage();

    await waitFor(() => expect(screen.getByTestId("session-code")).toHaveTextContent("SR-000184"));
    expect(screen.getByTestId("scan-status")).toHaveTextContent("READY TO SCAN");
    expect(screen.getByText("Scan the production carton")).toBeInTheDocument();
    expect(screen.getByTestId("received-count")).toHaveTextContent("0");
    expect(screen.getByTestId("last-received")).toHaveTextContent("—");
    // Focus is applied in an effect once the session is ready.
    await waitFor(() => expect(screen.getByLabelText("Scanner input")).toHaveFocus());

    // No manual controls that would bypass traceability.
    expect(screen.queryByRole("button", { name: /\+ ?stock|- ?stock|save/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("TEST 1 — a valid scan is received, shown with its identity and transition, then returns to ready by itself", async () => {
    const backend = createFakeBackend({ "SK6_RED_7/10_000037": "PRODUCED" });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("session-code")).toHaveTextContent("SR-000184"));

    await scanCode("SK6_RED_7/10_000037");

    await waitFor(() => expect(screen.getByTestId("scan-status")).toHaveTextContent("✓ RECEIVED"));
    expect(backend.api.storeEntryScan).toHaveBeenCalledWith("SK6_RED_7/10_000037", { token: "token-1", sessionId: "session-1" });
    expect(backend.units.get("SK6_RED_7/10_000037")).toBe("WAREHOUSE");

    const station = screen.getByLabelText("Scanning station");
    expect(within(station).getByText("SK6 · RED · 7/10")).toBeInTheDocument();
    expect(within(station).getByText("SK6_RED_7/10_000037")).toBeInTheDocument();
    const transition = within(station).getByLabelText("Status change");
    expect(transition).toHaveTextContent("Production / Stock");
    expect(transition).toHaveTextContent("In Store");

    expect(screen.getByTestId("received-count")).toHaveTextContent("1");
    expect(screen.getByTestId("last-received")).toHaveTextContent("SK6 · RED · 7/10");
    expect(screen.getByTestId("last-received")).toHaveTextContent("SK6_RED_7/10_000037");

    // The input was cleared and refocused — the next carton can be scanned immediately.
    expect(screen.getByLabelText("Scanner input")).toHaveValue("");
    expect(screen.getByLabelText("Scanner input")).toHaveFocus();

    // …and the station returns to READY on its own, no OK / New / modal to dismiss.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2600);
    });
    expect(screen.getByTestId("scan-status")).toHaveTextContent("READY TO SCAN");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("TEST 2 — a duplicate scan warns ALREADY IN STORE and does not count again", async () => {
    const backend = createFakeBackend({ "SK6_RED_7/10_000037": "PRODUCED" });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("session-code")).toHaveTextContent("SR-000184"));

    await scanCode("SK6_RED_7/10_000037");
    await waitFor(() => expect(screen.getByTestId("received-count")).toHaveTextContent("1"));

    await scanCode("SK6_RED_7/10_000037");
    await waitFor(() => expect(screen.getByTestId("scan-status")).toHaveTextContent("⚠ ALREADY IN STORE"));

    const station = screen.getByLabelText("Scanning station");
    expect(within(station).getByText("This carton has already been received.")).toBeInTheDocument();
    expect(within(station).getByLabelText("Current status")).toHaveTextContent("In Store");
    expect(screen.getByTestId("received-count")).toHaveTextContent("1");
    expect(backend.received).toHaveLength(1);
  });

  it("TEST 3 — an unknown QR is refused with a clear message and no count", async () => {
    createFakeBackend({});
    renderPage();
    await waitFor(() => expect(screen.getByTestId("session-code")).toHaveTextContent("SR-000184"));

    await scanCode("SK6_RED_7/10_999999");

    await waitFor(() => expect(screen.getByTestId("scan-status")).toHaveTextContent("✕ UNKNOWN QR"));
    const station = screen.getByLabelText("Scanning station");
    expect(within(station).getByText("This QR is not registered.")).toBeInTheDocument();
    expect(within(station).getByText("SK6_RED_7/10_999999")).toBeInTheDocument();
    expect(screen.getByTestId("received-count")).toHaveTextContent("0");
  });

  it("TEST 6 — a dispatched carton shows CANNOT RECEIVE with its current status", async () => {
    createFakeBackend({ "SK6_RED_7/10_000041": "DISPATCHED" });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("session-code")).toHaveTextContent("SR-000184"));

    await scanCode("SK6_RED_7/10_000041");

    await waitFor(() => expect(screen.getByTestId("scan-status")).toHaveTextContent("✕ CANNOT RECEIVE"));
    const station = screen.getByLabelText("Scanning station");
    expect(within(station).getByLabelText("Current status")).toHaveTextContent("Dispatched");
    expect(screen.getByTestId("received-count")).toHaveTextContent("0");
  });

  it("TEST 7 / 8 — continuous mixed scanning keeps the station working and the summary honest", async () => {
    const backend = createFakeBackend({
      "SK6_RED_7/10_000001": "PRODUCED",
      "SK6_RED_7/10_000002": "PRODUCED",
      "SK6_BLUE_7/10_000001": "PRODUCED",
      "SK12_RED_4/6_000001": "PRODUCED",
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("session-code")).toHaveTextContent("SR-000184"));

    const sequence = [
      "SK6_RED_7/10_000001", // valid
      "SK6_RED_7/10_000002", // valid
      "SK6_RED_7/10_999999", // unknown
      "SK6_BLUE_7/10_000001", // valid
      "SK6_RED_7/10_000001", // duplicate
      "SK12_RED_4/6_000001", // valid
    ];
    for (const code of sequence) {
      await scanCode(code);
      await waitFor(() => expect(screen.getByTestId("scan-status")).not.toHaveTextContent("READY TO SCAN"));
    }

    expect(backend.api.storeEntryScan.mock.calls.map((c) => c[0])).toEqual(sequence);
    await waitFor(() => expect(screen.getByTestId("received-count")).toHaveTextContent("4"));
    expect(screen.getByTestId("session-total")).toHaveTextContent("4");

    const summaryCard = screen.getByLabelText("This session");
    expect(within(summaryCard).getByText("SK6 · RED · 7/10").nextElementSibling).toHaveTextContent("2");
    expect(within(summaryCard).getByText("SK6 · BLUE · 7/10").nextElementSibling).toHaveTextContent("1");
    expect(within(summaryCard).getByText("SK12 · RED · 4/6").nextElementSibling).toHaveTextContent("1");

    const recent = screen.getByLabelText("Recently received");
    const rows = within(recent).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveTextContent("SK12_RED_4/6_000001");
    expect(rows[3]).toHaveTextContent("SK6_RED_7/10_000001");

    // The station is still live after the failures.
    expect(screen.getByLabelText("Scanner input")).not.toBeDisabled();
    expect(screen.getByLabelText("Scanner input")).toHaveFocus();
  });

  it("queues a burst of scans so none is dropped while one is in flight", async () => {
    const backend = createFakeBackend({ "SK6_RED_7/10_000001": "PRODUCED", "SK6_RED_7/10_000002": "PRODUCED" });
    const original = backend.api.storeEntryScan.getMockImplementation()!;
    let release: () => void = () => undefined;
    backend.api.storeEntryScan.mockImplementationOnce(async (raw: string) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return original(raw);
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("session-code")).toHaveTextContent("SR-000184"));

    await scanCode("SK6_RED_7/10_000001"); // held in flight
    await scanCode("SK6_RED_7/10_000002"); // arrives while the first is pending
    expect(backend.api.storeEntryScan).toHaveBeenCalledTimes(1);

    await act(async () => {
      release();
      await vi.advanceTimersByTimeAsync(10);
    });

    await waitFor(() => expect(backend.api.storeEntryScan).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId("received-count")).toHaveTextContent("2"));
  });

  it("returns focus to the scanner after a stray click, and Escape clears typed text", async () => {
    createFakeBackend({});
    renderPage();
    await waitFor(() => expect(screen.getByTestId("session-code")).toHaveTextContent("SR-000184"));
    const input = screen.getByLabelText("Scanner input") as HTMLInputElement;

    screen.getByRole("heading", { name: "Store Receiving" }).focus();
    fireEvent.click(screen.getByRole("heading", { name: "Store Receiving" }));
    expect(input).toHaveFocus();

    fireEvent.change(input, { target: { value: "SK6" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input).toHaveValue("");
  });

  it("opens the existing QR detail drawer, read-only, from a recently received row", async () => {
    const backend = createFakeBackend({ "SK6_RED_7/10_000037": "PRODUCED" });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("session-code")).toHaveTextContent("SR-000184"));
    await scanCode("SK6_RED_7/10_000037");
    await waitFor(() => expect(screen.getByTestId("received-count")).toHaveTextContent("1"));

    const recent = screen.getByLabelText("Recently received");
    fireEvent.click(within(recent).getAllByRole("row")[1]);

    const dialog = await screen.findByRole("dialog");
    expect(backend.api.getQrDetail).toHaveBeenCalledWith("SK6_RED_7/10_000037");
    await waitFor(() => expect(within(dialog).getByText("Store entry (In Store)")).toBeInTheDocument());
    expect(within(dialog).getByText("Production scan (+IN)")).toBeInTheDocument();
    // Corrections belong to QR Management, not the store operator.
    expect(within(dialog).queryByRole("button", { name: /mark damaged/i })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /void/i })).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByLabelText("Scanner input")).toHaveFocus();
  });

  it("blocks scanning with a clear message when the session cannot be authorised", async () => {
    const backend = createFakeBackend({});
    backend.api.getStoreReceivingSession.mockResolvedValue({ accepted: false, reason: "Your account does not have Store Scanning access." } as never);
    renderPage();

    expect(await screen.findByRole("alert")).toHaveTextContent("Your account does not have Store Scanning access.");
    expect(screen.queryByLabelText("Scanner input")).not.toBeInTheDocument();
  });
});
