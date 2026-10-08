import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RawMaterialOutputPage } from "./RawMaterialOutputPage";
import { NotificationsProvider } from "../state/NotificationsContext";
import type {
  RawMaterialIssueResult,
  RawMaterialIssueSession,
  RawMaterialIssueSessionSummary,
} from "../types/desktopApi";

// Same station contract as Raw Material Input: a hardware scanner drops the whole code into
// the focused input in one burst with no Enter, and the page has to submit on its own.
// The session opens by itself here, because there is nothing for the operator to choose.

vi.mock("../utils/playScanSound", () => ({ playScanSound: vi.fn() }));

const SESSION: RawMaterialIssueSession = {
  id: "session-1",
  code: "RMO-000007",
  sessionNumber: 7,
  deviceId: "desktop-main",
  startedBy: "store-op",
  status: "OPEN",
  startedAt: "2026-09-26T08:00:00.000Z",
  closedAt: null,
};

const LABEL = "RMQR_PTY000001_RM000001_000001";

function createFakeBackend() {
  const issued: RawMaterialIssueSessionSummary["scans"] = [];
  let clock = 0;

  const summary = (): RawMaterialIssueSessionSummary => ({
    session: SESSION,
    totalPackets: issued.length,
    bySection: issued.length
      ? [
          {
            sectionName: "PACKING",
            packets: issued.length,
            materials: [
              { itemDisplayName: "RUBBER UPPER — SK6 — RED — 7/10", packets: issued.length, quantity: issued.length * 2, unitCode: "DOZ" },
            ],
          },
        ]
      : [],
    scans: [...issued],
  });

  const rawMaterialIssueScan = vi.fn(async (raw: string): Promise<RawMaterialIssueResult> => {
    clock += 1;
    if (!raw.startsWith("RMQR_")) {
      return {
        accepted: false,
        outcome: "INVALID_FORMAT",
        qrId: raw,
        reason: "This is not a raw material QR. Finished cartons leave the store on Store Move Out.",
      };
    }
    if (issued.some((scan) => scan.qrId === raw)) {
      return { accepted: false, outcome: "NOT_IN_STORE", qrId: raw, reason: "This packet has already been issued to PACKING." };
    }
    issued.push({
      qrId: raw,
      itemDisplayName: "RUBBER UPPER — SK6 — RED — 7/10",
      quantity: 2,
      unitCode: "DOZ",
      sectionName: "PACKING",
      issuedAt: `2026-09-26T08:0${clock}:00.000Z`,
      actor: "store-op",
    });
    return {
      accepted: true,
      outcome: "ISSUED",
      qrId: raw,
      itemDisplayName: "RUBBER UPPER — SK6 — RED — 7/10",
      packingQuantity: 2,
      packingUnitCode: "DOZ",
      sectionName: "PACKING",
      currentStatus: "ISSUED",
      issuedAt: `2026-09-26T08:0${clock}:00.000Z`,
      sessionId: SESSION.id,
    };
  });

  const api = {
    startRawMaterialIssueSession: vi.fn(async () => ({ accepted: true, session: SESSION })),
    closeRawMaterialIssueSession: vi.fn(async () => ({ ...SESSION, status: "CLOSED" as const })),
    getRawMaterialIssueSessionSummary: vi.fn(async () => summary()),
    rawMaterialIssueScan,
    getScannerStatus: vi.fn(async () => true),
  };

  Object.defineProperty(window, "desktop", {
    value: { versions: { node: "22", chrome: "128", electron: "43" }, api },
    configurable: true,
  });

  return { api, rawMaterialIssueScan, issued };
}

const renderPage = () =>
  render(
    <NotificationsProvider>
      <RawMaterialOutputPage token="token-1" username="store-op" />
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

describe("RawMaterialOutputPage", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("opens its session by itself — there is nothing for the operator to choose", async () => {
    const { api } = createFakeBackend();
    renderPage();

    await waitFor(() => expect(screen.getByTestId("session-code")).toHaveTextContent("RMO-000007"));
    expect(api.startRawMaterialIssueSession).toHaveBeenCalled();
  });

  it("submits a scanned packet on its own, with no Enter key, and names the destination", async () => {
    const { rawMaterialIssueScan } = createFakeBackend();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("session-code")).toBeInTheDocument());

    await scanCode(LABEL);

    expect(rawMaterialIssueScan).toHaveBeenCalledTimes(1);
    expect(rawMaterialIssueScan.mock.calls[0][0]).toBe(LABEL);
    await waitFor(() => expect(screen.getByTestId("scan-status")).toHaveTextContent("ISSUED"));
    expect(screen.getByText(/sent to PACKING/i)).toBeInTheDocument();
    expect((screen.getByLabelText("Scanner input") as HTMLInputElement).value).toBe("");
  });

  it("scans arriving back to back are each submitted exactly once", async () => {
    const { rawMaterialIssueScan } = createFakeBackend();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("session-code")).toBeInTheDocument());

    await scanCode("RMQR_PTY000001_RM000001_000001");
    await scanCode("RMQR_PTY000001_RM000001_000002");
    await scanCode("RMQR_PTY000001_RM000001_000003");

    expect(rawMaterialIssueScan).toHaveBeenCalledTimes(3);
    await waitFor(() => expect(screen.getByTestId("received-count")).toHaveTextContent("3"));
  });

  it("a carton scanned here is turned away with a pointer to Store Move Out", async () => {
    createFakeBackend();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("session-code")).toBeInTheDocument());

    await scanCode("SK6_RED_7/10_000001");

    await waitFor(() => expect(screen.getByTestId("scan-status")).toHaveTextContent("NOT A RAW MATERIAL QR"));
    expect(screen.getByText(/Store Move Out/)).toBeInTheDocument();
  });

  it("a packet already issued is refused and the station stays ready", async () => {
    const { rawMaterialIssueScan } = createFakeBackend();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("session-code")).toBeInTheDocument());

    await scanCode(LABEL);
    await scanCode(LABEL);

    expect(rawMaterialIssueScan).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.getByTestId("scan-status")).toHaveTextContent("NOT IN STORE"));
    expect((screen.getByLabelText("Scanner input") as HTMLInputElement).value).toBe("");
  });

  it("Escape clears a part-typed code without submitting it", async () => {
    const { rawMaterialIssueScan } = createFakeBackend();
    renderPage();
    await waitFor(() => expect(screen.getByTestId("session-code")).toBeInTheDocument());

    const input = screen.getByLabelText("Scanner input") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "RMQ" } });
      fireEvent.keyDown(input, { key: "Escape" });
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(input.value).toBe("");
    expect(rawMaterialIssueScan).not.toHaveBeenCalled();
  });
});
