import React, { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationsProvider } from "../../../state/NotificationsContext";
import { useReceivingStation } from "./useReceivingStation";
import { useIssuingStation } from "./useIssuingStation";

// TWO STATIONS, ONE SCANNER (0.3.9). The Store page holds both stations at once, as here: each keeps
// its own session whichever mode is on screen, and only the active one's box is armed, so a scan
// can only ever land in the mode the operator is looking at.

vi.mock("../../../utils/playScanSound", () => ({ playScanSound: () => undefined }));

const RECEIVING = {
  id: "rs-1", code: "RMI-000191", sessionNumber: 191, partyId: "sup-1", partyName: "SHEHZAD RUBBER",
  deviceId: "d1", startedBy: "store", status: "OPEN" as const, startedAt: "2026-10-30T04:00:00.000Z", closedAt: null,
};
const ISSUING = { id: "is-1", code: "RMO-000174", sessionNumber: 174, deviceId: "d1", startedBy: "store", status: "OPEN" as const, startedAt: "2026-10-30T04:10:00.000Z", closedAt: null };
const PARTIES = [
  { id: "sup-1", partyCode: "PTY-1", partyName: "SHEHZAD RUBBER", partyType: "SUPPLIER", status: "ACTIVE" },
  { id: "con-1", partyCode: "PTY-2", partyName: "DANIYAL", partyType: "CONTRACTOR", status: "ACTIVE" },
];
const LABEL = "RM_SHEHZAD_SK6RED_000001";

function installApi() {
  const api = {
    listParties: vi.fn(async () => ({ rows: PARTIES, total: 2, page: 1, pageSize: 1000 })),
    getOpenRawMaterialReceivingSession: vi.fn(async () => RECEIVING),
    getRawMaterialReceivingSessionSummary: vi.fn(async () => ({ session: RECEIVING, totalPackets: 0, byMaterial: [], scans: [] })),
    rawMaterialReceiptScan: vi.fn(async () => ({ accepted: true, outcome: "RECEIVED", qrId: LABEL })),
    getOpenRawMaterialIssueSession: vi.fn(async () => ISSUING),
    getRawMaterialIssueSessionSummary: vi.fn(async () => ({
      session: ISSUING, partyId: "con-1", partyName: "DANIYAL", totalPackets: 3, byMaterial: [], bySection: [], scans: [],
    })),
    listRawMaterialIssueSessions: vi.fn(async () => []),
    rawMaterialIssueScan: vi.fn(async () => ({ accepted: true, outcome: "ISSUED", qrId: LABEL })),
  };
  Object.defineProperty(window, "desktop", { value: { versions: { node: "22", chrome: "128", electron: "43" }, api }, configurable: true });
  return api;
}

/** Both stations, as the Store page holds them, with one switch between them. */
const Harness: React.FC = () => {
  const [mode, setMode] = useState<"receiving" | "issuing">("receiving");
  const receiving = useReceivingStation({ token: "t", active: mode === "receiving" });
  const issuing = useIssuingStation({ token: "t", active: mode === "issuing" });
  return (
    <>
      <button type="button" onClick={() => setMode(mode === "receiving" ? "issuing" : "receiving")}>
        switch
      </button>
      <p data-testid="states">{`${receiving.state.title} / ${issuing.state.title}`}</p>
      <div hidden={mode !== "receiving"}>
        <input aria-label="scan in" ref={receiving.scanBox.inputRef} value={receiving.scanBox.inputVal} onChange={(e) => receiving.scanBox.setInputVal(e.target.value)} onKeyDown={receiving.scanBox.onKeyDown} />
      </div>
      <div hidden={mode !== "issuing"}>
        <input aria-label="scan out" ref={issuing.scanBox.inputRef} value={issuing.scanBox.inputVal} onChange={(e) => issuing.scanBox.setInputVal(e.target.value)} onKeyDown={issuing.scanBox.onKeyDown} />
      </div>
    </>
  );
};

const renderHarness = () =>
  render(
    <NotificationsProvider>
      <Harness />
    </NotificationsProvider>
  );

const scanInto = async (label: string, code: string) => {
  await act(async () => {
    fireEvent.change(screen.getByLabelText(label), { target: { value: code } });
    await vi.advanceTimersByTimeAsync(200);
  });
};

describe("the two store stations on one page", () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("each keeps its own session, and both say where they stand", async () => {
    installApi();
    renderHarness();
    await waitFor(() => expect(screen.getByTestId("states")).toHaveTextContent("Ready / Scanning"));
  });

  it("gives the scanner's focus to the active mode's box only, and moves it on a switch", async () => {
    installApi();
    renderHarness();
    await waitFor(() => expect(screen.getByLabelText("scan in")).toHaveFocus());

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "switch" }));
    });
    await waitFor(() => expect(screen.getByLabelText("scan out")).toHaveFocus());
  });

  it("sends a scan only from the active mode's box", async () => {
    const api = installApi();
    renderHarness();
    await waitFor(() => expect(screen.getByLabelText("scan in")).toHaveFocus());

    await scanInto("scan out", LABEL);
    expect(api.rawMaterialIssueScan).not.toHaveBeenCalled();

    await scanInto("scan in", LABEL);
    expect(api.rawMaterialReceiptScan).toHaveBeenCalledTimes(1);
  });

  it("loses neither session on a switch there and back", async () => {
    const api = installApi();
    renderHarness();
    await waitFor(() => expect(screen.getByTestId("states")).toHaveTextContent("Ready / Scanning"));
    for (let i = 0; i < 2; i += 1) {
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "switch" }));
      });
    }
    expect(screen.getByTestId("states")).toHaveTextContent("Ready / Scanning");
    expect(api.getOpenRawMaterialReceivingSession).toHaveBeenCalledTimes(1);
    expect(api.getOpenRawMaterialIssueSession).toHaveBeenCalledTimes(1);
  });

  it("clears the box on Escape without the key reaching the rest of the app", async () => {
    installApi();
    renderHarness();
    const outside = vi.fn();
    window.addEventListener("keydown", outside);
    await waitFor(() => expect(screen.getByLabelText("scan in")).toHaveFocus());
    fireEvent.change(screen.getByLabelText("scan in"), { target: { value: "RM_HALF" } });
    fireEvent.keyDown(screen.getByLabelText("scan in"), { key: "Escape" });
    expect(screen.getByLabelText("scan in")).toHaveValue("");
    expect(outside).not.toHaveBeenCalled();
    window.removeEventListener("keydown", outside);
  });
});
