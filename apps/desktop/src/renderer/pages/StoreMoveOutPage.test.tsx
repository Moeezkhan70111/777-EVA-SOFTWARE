import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoreMoveOutPage } from "./StoreMoveOutPage";
import { NotificationsProvider } from "../state/NotificationsContext";
import type {
  StoreExitScanResult,
  StoreMovedOutRow,
  StoreMoveOutSession,
  StoreMoveOutSessionSummary,
} from "../types/desktopApi";

// Driven exactly as a scanner drives it: text typed into the focused input. The fake
// backend answers like the real StoreExitScanUseCase does, so the page is tested against
// real outcomes rather than canned strings.

vi.mock("../utils/playScanSound", () => ({ playScanSound: vi.fn() }));

const SESSION: StoreMoveOutSession = {
  id: "session-out-1",
  code: "SO-000042",
  sessionNumber: 42,
  deviceId: "desktop-main",
  startedBy: "store-op",
  status: "OPEN",
  startedAt: "2026-09-16T14:00:00.000Z",
  closedAt: null,
};

type UnitStatus = "PRODUCED" | "WAREHOUSE" | "TO_GATE" | "DISPATCHED";

function createFakeBackend(initial: Record<string, UnitStatus>) {
  const units = new Map<string, UnitStatus>(Object.entries(initial));
  const movedOut: StoreMovedOutRow[] = [];
  let clock = 0;

  const summary = (): StoreMoveOutSessionSummary => {
    const tally = new Map<string, { article: string; color: string; size: string; count: number }>();
    for (const r of movedOut) {
      const key = `${r.article}|${r.color}|${r.size}`;
      const entry = tally.get(key) ?? { article: r.article, color: r.color, size: r.size, count: 0 };
      entry.count += 1;
      tally.set(key, entry);
    }
    const recent = [...movedOut].reverse();
    return {
      session: SESSION,
      movedOutCount: movedOut.length,
      byProduct: [...tally.values()].sort((a, b) => b.count - a.count),
      recent,
      lastMovedOut: recent[0] ?? null,
    };
  };

  const storeExitScan = vi.fn(async (raw: string): Promise<StoreExitScanResult> => {
    const [article, color, size, serial] = raw.split("_");
    const status = units.get(raw);
    if (!status) return { accepted: false, outcome: "UNKNOWN_QR", qrId: raw, reason: "This QR is not registered.", article, color, size, serial };
    if (status === "TO_GATE") {
      return { accepted: false, outcome: "ALREADY_AT_GATE", qrId: raw, reason: "This carton has already been moved out to the gate.", article, color, size, serial, previousStatus: "TO_GATE", currentStatus: "TO_GATE" };
    }
    if (status === "PRODUCED") {
      return { accepted: false, outcome: "NOT_IN_STORE", qrId: raw, reason: "This carton has not been received into the store. Move it in first.", article, color, size, serial, previousStatus: "PRODUCED", currentStatus: "PRODUCED" };
    }
    if (status === "DISPATCHED") {
      return { accepted: false, outcome: "NOT_ELIGIBLE", qrId: raw, reason: "This carton has already been dispatched to a customer.", article, color, size, serial, previousStatus: "DISPATCHED", currentStatus: "DISPATCHED" };
    }
    units.set(raw, "TO_GATE");
    clock += 1;
    const movedOutAt = new Date(Date.UTC(2026, 8, 16, 14, 5, clock)).toISOString();
    const eventId = `evt-out-${clock}`;
    movedOut.push({ eventId, qrId: raw, article, color, size, serial, movedOutAt, actor: "store-op" });
    return { accepted: true, outcome: "MOVED_OUT", qrId: raw, article, color, size, serial, previousStatus: "WAREHOUSE", currentStatus: "TO_GATE", movedOutAt, eventId, sessionId: SESSION.id };
  });

  const api = {
    storeExitScan,
    getStoreMoveOutSession: vi.fn(async () => ({ accepted: true, session: SESSION })),
    getStoreMoveOutSessionSummary: vi.fn(async () => summary()),
    getScannerStatus: vi.fn(async () => true),
    getQrDetail: vi.fn(async (qrId: string) => ({
      qrId,
      article: "SK6",
      color: "RED",
      size: "7/10",
      serial: qrId.slice(-6),
      stage: "TO_GATE",
      productVariantId: "pv-1",
      sellingPrice: 550,
      stockOnHand: 12,
      registry: { status: "GENERATED", registeredAt: "2026-09-15T05:32:00.000Z", voidReason: null, voidedAt: null, voidedBy: null },
      batch: null,
      lifecycle: { currentStatus: "TO_GATE", locationType: "GATE", locationId: "factory-777", firstScannedAt: "2026-09-15T06:00:00.000Z", updatedAt: "2026-09-16T14:05:01.000Z" },
      events: [
        { id: "e1", eventType: "PRODUCED", subType: null, occurredAt: "2026-09-15T06:00:00.000Z", factory: "777", workstation: "Line 1", operator: null, deviceId: "d", note: null, syncStatus: "PENDING" },
        { id: "e2", eventType: "MOVED", subType: "STORE_ENTRY", occurredAt: "2026-09-16T08:15:01.000Z", factory: "777", workstation: "Line 1", operator: null, deviceId: "d", note: "FACTORY → WAREHOUSE · by store-op", syncStatus: "PENDING" },
        { id: "e3", eventType: "MOVED", subType: "STORE_EXIT", occurredAt: "2026-09-16T14:05:01.000Z", factory: "777", workstation: "Line 1", operator: null, deviceId: "d", note: "WAREHOUSE → GATE · by store-op", syncStatus: "PENDING" },
      ],
    })),
  };

  Object.defineProperty(window, "desktop", {
    value: { versions: { node: "22", chrome: "128", electron: "43" }, api },
    configurable: true,
  });

  return { api, units, movedOut };
}

const renderPage = (onBack?: () => void) =>
  render(
    <NotificationsProvider>
      <StoreMoveOutPage token="token-1" username="store-op" onBack={onBack} />
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

describe("StoreMoveOutPage", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("opens ready to scan with the move-out session, a zero counter and the scanner focused — nothing gatepass-specific on the station", async () => {
    createFakeBackend({});
    renderPage();

    await waitFor(() => expect(screen.getByTestId("session-code")).toHaveTextContent("SO-000042"));
    expect(screen.getByRole("heading", { name: "Store Move Out" })).toBeInTheDocument();
    expect(screen.getByTestId("scan-status")).toHaveTextContent("READY TO SCAN");
    expect(screen.getByText("Scan the carton leaving the store")).toBeInTheDocument();
    expect(screen.getByTestId("moved-out-count")).toHaveTextContent("0");
    expect(screen.getByTestId("last-moved-out")).toHaveTextContent("—");
    await waitFor(() => expect(screen.getByLabelText("Scanner input")).toHaveFocus());

    // No manual controls that would bypass traceability, and no Gatepass to choose: the
    // station is a generic store OUT; reservations are reconciled behind the scan.
    expect(screen.queryByRole("button", { name: /\+ ?stock|- ?stock|save/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByText(/gatepass/i)).not.toBeInTheDocument();
  });

  it("a valid scan is moved out, shown as In Store → To Gate, then returns to ready by itself", async () => {
    const backend = createFakeBackend({ "SK6_RED_7/10_000037": "WAREHOUSE" });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("session-code")).toHaveTextContent("SO-000042"));

    await scanCode("SK6_RED_7/10_000037");

    await waitFor(() => expect(screen.getByTestId("scan-status")).toHaveTextContent("✓ MOVED OUT"));
    expect(backend.api.storeExitScan).toHaveBeenCalledWith("SK6_RED_7/10_000037", { token: "token-1", sessionId: "session-out-1" });
    expect(backend.units.get("SK6_RED_7/10_000037")).toBe("TO_GATE");

    const station = screen.getByLabelText("Scanning station");
    expect(within(station).getByText(/ready to be dispatched/i)).toBeInTheDocument();
    expect(within(station).getByText("SK6 · RED · 7/10")).toBeInTheDocument();
    expect(within(station).getByText("SK6_RED_7/10_000037")).toBeInTheDocument();
    const transition = within(station).getByLabelText("Status change");
    expect(transition).toHaveTextContent("In Store");
    expect(transition).toHaveTextContent("To Gate");

    expect(screen.getByTestId("moved-out-count")).toHaveTextContent("1");
    expect(screen.getByTestId("last-moved-out")).toHaveTextContent("SK6 · RED · 7/10");
    expect(screen.getByTestId("last-moved-out")).toHaveTextContent("SK6_RED_7/10_000037");

    // The input was cleared and refocused — the next carton can be scanned immediately.
    expect(screen.getByLabelText("Scanner input")).toHaveValue("");
    expect(screen.getByLabelText("Scanner input")).toHaveFocus();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2600);
    });
    expect(screen.getByTestId("scan-status")).toHaveTextContent("READY TO SCAN");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("a duplicate scan warns ALREADY AT GATE and does not count again", async () => {
    const backend = createFakeBackend({ "SK6_RED_7/10_000037": "WAREHOUSE" });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("session-code")).toHaveTextContent("SO-000042"));

    await scanCode("SK6_RED_7/10_000037");
    await waitFor(() => expect(screen.getByTestId("moved-out-count")).toHaveTextContent("1"));

    await scanCode("SK6_RED_7/10_000037");
    await waitFor(() => expect(screen.getByTestId("scan-status")).toHaveTextContent("⚠ ALREADY AT GATE"));

    const station = screen.getByLabelText("Scanning station");
    expect(within(station).getByLabelText("Current status")).toHaveTextContent("To Gate");
    expect(screen.getByTestId("moved-out-count")).toHaveTextContent("1");
    expect(backend.movedOut).toHaveLength(1);
  });

  it("a carton that was never received into the store is refused as NOT IN STORE", async () => {
    const backend = createFakeBackend({ "SK6_RED_7/10_000041": "PRODUCED" });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("session-code")).toHaveTextContent("SO-000042"));

    await scanCode("SK6_RED_7/10_000041");

    await waitFor(() => expect(screen.getByTestId("scan-status")).toHaveTextContent("✕ NOT IN STORE"));
    const station = screen.getByLabelText("Scanning station");
    expect(within(station).getByText(/Move it in first/)).toBeInTheDocument();
    expect(within(station).getByLabelText("Current status")).toHaveTextContent("Production / Stock");
    expect(screen.getByTestId("moved-out-count")).toHaveTextContent("0");
    expect(backend.units.get("SK6_RED_7/10_000041")).toBe("PRODUCED");
  });

  it("unknown and dispatched cartons are refused with a clear message and no count", async () => {
    createFakeBackend({ "SK6_RED_7/10_000042": "DISPATCHED" });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("session-code")).toHaveTextContent("SO-000042"));

    await scanCode("SK6_RED_7/10_999999");
    await waitFor(() => expect(screen.getByTestId("scan-status")).toHaveTextContent("✕ UNKNOWN QR"));
    expect(within(screen.getByLabelText("Scanning station")).getByText("This QR is not registered.")).toBeInTheDocument();

    await scanCode("SK6_RED_7/10_000042");
    await waitFor(() => expect(screen.getByTestId("scan-status")).toHaveTextContent("✕ CANNOT MOVE OUT"));
    expect(within(screen.getByLabelText("Scanning station")).getByLabelText("Current status")).toHaveTextContent("Dispatched");
    expect(screen.getByTestId("moved-out-count")).toHaveTextContent("0");
  });

  it("continuous mixed scanning keeps the station working and the summary honest", async () => {
    const backend = createFakeBackend({
      "SK6_RED_7/10_000001": "WAREHOUSE",
      "SK6_RED_7/10_000002": "WAREHOUSE",
      "SK6_BLUE_7/10_000001": "WAREHOUSE",
      "SK12_RED_4/6_000001": "WAREHOUSE",
      "SK12_RED_4/6_000002": "PRODUCED",
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("session-code")).toHaveTextContent("SO-000042"));

    const sequence = [
      "SK6_RED_7/10_000001", // valid
      "SK6_RED_7/10_000002", // valid
      "SK6_RED_7/10_999999", // unknown
      "SK6_BLUE_7/10_000001", // valid
      "SK6_RED_7/10_000001", // duplicate
      "SK12_RED_4/6_000002", // never entered the store
      "SK12_RED_4/6_000001", // valid
    ];
    for (const code of sequence) {
      await scanCode(code);
      await waitFor(() => expect(screen.getByTestId("scan-status")).not.toHaveTextContent("READY TO SCAN"));
    }

    expect(backend.api.storeExitScan.mock.calls.map((c) => c[0])).toEqual(sequence);
    await waitFor(() => expect(screen.getByTestId("moved-out-count")).toHaveTextContent("4"));
    expect(screen.getByTestId("session-total")).toHaveTextContent("4");

    const summaryCard = screen.getByLabelText("This session");
    expect(within(summaryCard).getByText("SK6 · RED · 7/10").nextElementSibling).toHaveTextContent("2");
    expect(within(summaryCard).getByText("SK6 · BLUE · 7/10").nextElementSibling).toHaveTextContent("1");
    expect(within(summaryCard).getByText("SK12 · RED · 4/6").nextElementSibling).toHaveTextContent("1");

    const recent = screen.getByLabelText("Recently moved out");
    const rows = within(recent).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveTextContent("SK12_RED_4/6_000001");
    expect(rows[0]).toHaveTextContent("To Gate");
    expect(rows[3]).toHaveTextContent("SK6_RED_7/10_000001");

    expect(screen.getByLabelText("Scanner input")).not.toBeDisabled();
    expect(screen.getByLabelText("Scanner input")).toHaveFocus();
  });

  it("queues a burst of scans so none is dropped while one is in flight", async () => {
    const backend = createFakeBackend({ "SK6_RED_7/10_000001": "WAREHOUSE", "SK6_RED_7/10_000002": "WAREHOUSE" });
    const original = backend.api.storeExitScan.getMockImplementation()!;
    let release: () => void = () => undefined;
    backend.api.storeExitScan.mockImplementationOnce(async (raw: string) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return original(raw);
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("session-code")).toHaveTextContent("SO-000042"));

    await scanCode("SK6_RED_7/10_000001"); // held in flight
    await scanCode("SK6_RED_7/10_000002"); // arrives while the first is pending
    expect(backend.api.storeExitScan).toHaveBeenCalledTimes(1);

    await act(async () => {
      release();
      await vi.advanceTimersByTimeAsync(10);
    });

    await waitFor(() => expect(backend.api.storeExitScan).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId("moved-out-count")).toHaveTextContent("2"));
  });

  it("returns focus to the scanner after a stray click, Escape clears typed text, and ← Store goes back", async () => {
    createFakeBackend({});
    const onBack = vi.fn();
    renderPage(onBack);
    await waitFor(() => expect(screen.getByTestId("session-code")).toHaveTextContent("SO-000042"));
    const input = screen.getByLabelText("Scanner input") as HTMLInputElement;

    screen.getByRole("heading", { name: "Store Move Out" }).focus();
    fireEvent.click(screen.getByRole("heading", { name: "Store Move Out" }));
    expect(input).toHaveFocus();

    fireEvent.change(input, { target: { value: "SK6" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input).toHaveValue("");

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("opens the existing QR detail drawer, read-only, from a recently moved out row", async () => {
    const backend = createFakeBackend({ "SK6_RED_7/10_000037": "WAREHOUSE" });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("session-code")).toHaveTextContent("SO-000042"));
    await scanCode("SK6_RED_7/10_000037");
    await waitFor(() => expect(screen.getByTestId("moved-out-count")).toHaveTextContent("1"));

    const recent = screen.getByLabelText("Recently moved out");
    fireEvent.click(within(recent).getAllByRole("row")[1]);

    const dialog = await screen.findByRole("dialog");
    expect(backend.api.getQrDetail).toHaveBeenCalledWith("SK6_RED_7/10_000037");
    await waitFor(() => expect(within(dialog).getByText("Store move out (To Gate)")).toBeInTheDocument());
    expect(within(dialog).getByText("Store entry (In Store)")).toBeInTheDocument();
    // Corrections belong to QR Management, not the store operator.
    expect(within(dialog).queryByRole("button", { name: /mark damaged/i })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /void/i })).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByLabelText("Scanner input")).toHaveFocus();
  });

  it("blocks scanning with a clear message when the session cannot be authorised", async () => {
    const backend = createFakeBackend({});
    backend.api.getStoreMoveOutSession.mockResolvedValue({ accepted: false, reason: "Your account does not have Store Scanning access." } as never);
    renderPage();

    expect(await screen.findByRole("alert")).toHaveTextContent("Your account does not have Store Scanning access.");
    expect(screen.queryByLabelText("Scanner input")).not.toBeInTheDocument();
  });
});
