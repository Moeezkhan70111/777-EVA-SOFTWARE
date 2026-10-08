import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RawMaterialInputPage } from "./RawMaterialInputPage";
import { NotificationsProvider } from "../state/NotificationsContext";
import type {
  RawMaterialReceiptResult,
  RawMaterialReceivingSession,
  RawMaterialReceivingSessionSummary,
} from "../types/desktopApi";

// The page is driven exactly as a hardware scanner drives it: the whole code appears in the
// focused input in one burst, with no Enter key — many wedge scanners are not configured to
// send a suffix. The station has to submit on its own.

vi.mock("../utils/playScanSound", () => ({ playScanSound: vi.fn() }));

const SESSION: RawMaterialReceivingSession = {
  id: "session-1",
  code: "RMI-000004",
  sessionNumber: 4,
  partyId: "party-1",
  partyName: "SHEHZAD RUBBER TOPPING",
  deviceId: "desktop-main",
  startedBy: "store-op",
  status: "OPEN",
  startedAt: "2026-09-26T08:00:00.000Z",
  closedAt: null,
};

const LABEL = "RMQR_PTY000001_RM000001_000001";

function createFakeBackend() {
  const received: RawMaterialReceivingSessionSummary["scans"] = [];
  let clock = 0;

  const summary = (): RawMaterialReceivingSessionSummary => ({
    session: SESSION,
    totalPackets: received.length,
    byMaterial: received.length
      ? [{ itemDisplayName: "RUBBER UPPER — SK6 — RED — 7/10", packets: received.length, quantity: received.length * 2, unitCode: "DOZ" }]
      : [],
    scans: [...received],
  });

  const rawMaterialReceiptScan = vi.fn(async (raw: string): Promise<RawMaterialReceiptResult> => {
    clock += 1;
    if (!raw.startsWith("RMQR_")) {
      return { accepted: false, outcome: "INVALID_FORMAT", qrId: raw, reason: "This is not a raw material QR. Finished cartons are received on Store Move In." };
    }
    if (received.some((scan) => scan.qrId === raw)) {
      return { accepted: false, outcome: "ALREADY_IN_STORE", qrId: raw, reason: "This packet has already been received." };
    }
    received.push({
      qrId: raw,
      itemDisplayName: "RUBBER UPPER — SK6 — RED — 7/10",
      quantity: 2,
      unitCode: "DOZ",
      receivedAt: `2026-09-26T08:0${clock}:00.000Z`,
      actor: "store-op",
    });
    return {
      accepted: true,
      outcome: "RECEIVED",
      qrId: raw,
      itemDisplayName: "RUBBER UPPER — SK6 — RED — 7/10",
      partyName: SESSION.partyName,
      packingQuantity: 2,
      packingUnitCode: "DOZ",
      currentStatus: "IN_STORE",
      receivedAt: `2026-09-26T08:0${clock}:00.000Z`,
      sessionId: SESSION.id,
    };
  });

  const api = {
    listParties: vi.fn(async () => ({
      rows: [{ id: "party-1", partyCode: "PTY000001", partyName: "SHEHZAD RUBBER TOPPING", partyType: "SUPPLIER" }],
      total: 1,
      page: 1,
      pageSize: 500,
    })),
    getOpenRawMaterialReceivingSession: vi.fn(async () => SESSION),
    getRawMaterialReceivingSessionSummary: vi.fn(async () => summary()),
    startRawMaterialReceivingSession: vi.fn(async () => ({ accepted: true, session: SESSION })),
    closeRawMaterialReceivingSession: vi.fn(async () => ({ ...SESSION, status: "CLOSED" as const })),
    rawMaterialReceiptScan,
    getScannerStatus: vi.fn(async () => true),
  };

  Object.defineProperty(window, "desktop", {
    value: { versions: { node: "22", chrome: "128", electron: "43" }, api },
    configurable: true,
  });

  return { api, rawMaterialReceiptScan, received };
}

const renderPage = () =>
  render(
    <NotificationsProvider>
      <RawMaterialInputPage token="token-1" username="store-op" />
    </NotificationsProvider>
  );

/** A wedge scanner burst: the whole code lands in the input at once, with no Enter. */
const scanCode = async (code: string) => {
  const input = screen.getByLabelText("Scanner input") as HTMLInputElement;
  await act(async () => {
    fireEvent.change(input, { target: { value: code } });
    await vi.advanceTimersByTimeAsync(60);
  });
};

describe("RawMaterialInputPage", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("submits a scanned packet on its own, with no Enter key", async () => {
    const { rawMaterialReceiptScan } = createFakeBackend();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("session-code")).toHaveTextContent("RMI-000004"));

    await scanCode(LABEL);

    expect(rawMaterialReceiptScan).toHaveBeenCalledTimes(1);
    expect(rawMaterialReceiptScan.mock.calls[0][0]).toBe(LABEL);
    await waitFor(() => expect(screen.getByTestId("scan-status")).toHaveTextContent("RECEIVED"));
    // The input clears itself so the next packet can be scanned straight away.
    expect((screen.getByLabelText("Scanner input") as HTMLInputElement).value).toBe("");
  });

  it("lower-case and stray control characters from the wedge are normalised", async () => {
    const { rawMaterialReceiptScan } = createFakeBackend();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("session-code")).toBeInTheDocument());

    await scanCode(`\u0002${LABEL.toLowerCase()}\r`);

    expect(rawMaterialReceiptScan).toHaveBeenCalledWith(LABEL, expect.anything());
  });

  it("scans arriving back to back are each submitted exactly once", async () => {
    const { rawMaterialReceiptScan } = createFakeBackend();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("session-code")).toBeInTheDocument());

    await scanCode("RMQR_PTY000001_RM000001_000001");
    await scanCode("RMQR_PTY000001_RM000001_000002");
    await scanCode("RMQR_PTY000001_RM000001_000003");

    expect(rawMaterialReceiptScan).toHaveBeenCalledTimes(3);
    expect(rawMaterialReceiptScan.mock.calls.map((call) => call[0])).toEqual([
      "RMQR_PTY000001_RM000001_000001",
      "RMQR_PTY000001_RM000001_000002",
      "RMQR_PTY000001_RM000001_000003",
    ]);
    await waitFor(() => expect(screen.getByTestId("received-count")).toHaveTextContent("3"));
  });

  it("Enter still submits, for a supervisor typing a code by hand", async () => {
    const { rawMaterialReceiptScan } = createFakeBackend();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("session-code")).toBeInTheDocument());

    const input = screen.getByLabelText("Scanner input") as HTMLInputElement;
    await act(async () => {
      // Four characters: below the length the quiet-period fallback acts on.
      fireEvent.change(input, { target: { value: "RMQR" } });
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(rawMaterialReceiptScan).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.change(input, { target: { value: LABEL } });
      fireEvent.keyDown(input, { key: "Enter" });
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(rawMaterialReceiptScan).toHaveBeenCalledTimes(1);
  });

  it("Escape clears a part-typed code without submitting it", async () => {
    const { rawMaterialReceiptScan } = createFakeBackend();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("session-code")).toBeInTheDocument());

    const input = screen.getByLabelText("Scanner input") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "RMQ" } });
      fireEvent.keyDown(input, { key: "Escape" });
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(input.value).toBe("");
    expect(rawMaterialReceiptScan).not.toHaveBeenCalled();
  });

  it("a refused scan is shown and the station stays ready for the next packet", async () => {
    const { rawMaterialReceiptScan } = createFakeBackend();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("session-code")).toBeInTheDocument());

    await scanCode(LABEL);
    await scanCode(LABEL);

    expect(rawMaterialReceiptScan).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.getByTestId("scan-status")).toHaveTextContent("ALREADY RECEIVED"));
    expect((screen.getByLabelText("Scanner input") as HTMLInputElement).value).toBe("");
  });
});
