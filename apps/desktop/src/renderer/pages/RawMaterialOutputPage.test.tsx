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
// The session opens by itself. Since 0.3.6 the operator first chooses who the packets go to — a
// supplier or a contractor — and a packet scanned before that is turned away without a call.

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

const party = (id: string, partyCode: string, partyName: string, partyType: string, status = "ACTIVE") => ({
  id, partyCode, partyName, partyType, status,
});

/** Two that may receive raw material, and two that may not. */
const PARTIES = [
  party("party-supplier", "PTY-0001", "ABC UPPER", "SUPPLIER"),
  party("party-contractor", "PTY-0002", "ASLAM UPPER MAKER", "CONTRACTOR"),
  party("party-customer", "PTY-0003", "WALK-IN CUSTOMER", "CUSTOMER"),
  party("party-retired", "PTY-0004", "OLD CONTRACTOR", "CONTRACTOR", "INACTIVE"),
];

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

  const rawMaterialIssueScan = vi.fn(
    async (raw: string, opts?: { issuedToPartyId?: string }): Promise<RawMaterialIssueResult> => {
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
        issuedToPartyName: PARTIES.find((p) => p.id === opts?.issuedToPartyId)?.partyName,
        currentStatus: "ISSUED",
        issuedAt: `2026-09-26T08:0${clock}:00.000Z`,
        sessionId: SESSION.id,
      };
    }
  );

  const api = {
    startRawMaterialIssueSession: vi.fn(async () => ({ accepted: true, session: SESSION })),
    closeRawMaterialIssueSession: vi.fn(async () => ({ ...SESSION, status: "CLOSED" as const })),
    getRawMaterialIssueSessionSummary: vi.fn(async () => summary()),
    listParties: vi.fn(async () => ({ rows: PARTIES, total: PARTIES.length, page: 1, pageSize: 1000 })),
    rawMaterialIssueScan,
    getScannerStatus: vi.fn(async () => true),
  };

  Object.defineProperty(window, "desktop", {
    value: { versions: { node: "22", chrome: "128", electron: "43" }, api },
    configurable: true,
  });

  return { api, rawMaterialIssueScan, issued };
}

const renderPage = (props: Partial<React.ComponentProps<typeof RawMaterialOutputPage>> = {}) =>
  render(
    <NotificationsProvider>
      <RawMaterialOutputPage token="token-1" username="store-op" {...props} />
    </NotificationsProvider>
  );

/** A wedge scanner burst: the whole code lands in the input at once, with no Enter. */
const scanCode = async (code: string, settleMs = 60) => {
  const input = screen.getByLabelText("Scanner input") as HTMLInputElement;
  await act(async () => {
    fireEvent.change(input, { target: { value: code } });
    await vi.advanceTimersByTimeAsync(settleMs);
  });
};

/** Opens the "Moving out to" list and picks a party from it. */
const openPartyList = async () => {
  const box = await screen.findByRole("combobox", { name: "Moving out to" });
  await act(async () => {
    fireEvent.click(box);
  });
};

const chooseParty = async (name: RegExp) => {
  await openPartyList();
  const option = await screen.findByRole("option", { name });
  await act(async () => {
    fireEvent.click(option);
  });
};

/** The page is up: session open and the party list loaded. */
const ready = async () => {
  await waitFor(() => expect(screen.getByTestId("session-code")).toBeInTheDocument());
  await screen.findByRole("combobox", { name: "Moving out to" });
};

describe("RawMaterialOutputPage", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("opens its session by itself", async () => {
    const { api } = createFakeBackend();
    renderPage();

    await waitFor(() => expect(screen.getByTestId("session-code")).toHaveTextContent("RMO-000007"));
    expect(api.startRawMaterialIssueSession).toHaveBeenCalled();
  });

  it("a packet scanned before a party is chosen is turned away, and nothing is sent", async () => {
    const { rawMaterialIssueScan } = createFakeBackend();
    renderPage();
    await ready();

    await scanCode(LABEL);

    await waitFor(() => expect(screen.getByTestId("scan-status")).toHaveTextContent("CHOOSE A PARTY FIRST"));
    expect(rawMaterialIssueScan).not.toHaveBeenCalled();
  });

  it("offers only active suppliers and contractors to move out to", async () => {
    createFakeBackend();
    renderPage();
    await ready();

    await openPartyList();

    expect(await screen.findByRole("option", { name: /ABC UPPER/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /ASLAM UPPER MAKER/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /WALK-IN CUSTOMER/ })).toBeNull();
    expect(screen.queryByRole("option", { name: /OLD CONTRACTOR/ })).toBeNull();
  });

  it("every scan is sent with the chosen party, and says who it went to", async () => {
    const { rawMaterialIssueScan } = createFakeBackend();
    renderPage();
    await ready();

    await chooseParty(/ASLAM UPPER MAKER/);
    await scanCode(LABEL);

    expect(rawMaterialIssueScan).toHaveBeenCalledTimes(1);
    expect(rawMaterialIssueScan.mock.calls[0][1]).toMatchObject({ issuedToPartyId: "party-contractor" });
    await waitFor(() => expect(screen.getByTestId("scan-status")).toHaveTextContent("ISSUED"));
    expect(screen.getByText(/sent to ASLAM UPPER MAKER/i)).toBeInTheDocument();
  });

  it("submits a scanned packet on its own, with no Enter key", async () => {
    const { rawMaterialIssueScan } = createFakeBackend();
    renderPage();
    await ready();
    await chooseParty(/ABC UPPER/);

    await scanCode(LABEL);

    expect(rawMaterialIssueScan).toHaveBeenCalledTimes(1);
    expect(rawMaterialIssueScan.mock.calls[0][0]).toBe(LABEL);
    await waitFor(() => expect(screen.getByTestId("scan-status")).toHaveTextContent("ISSUED"));
    expect((screen.getByLabelText("Scanner input") as HTMLInputElement).value).toBe("");
  });

  it("scans arriving back to back are each submitted exactly once", async () => {
    const { rawMaterialIssueScan } = createFakeBackend();
    renderPage();
    await ready();
    await chooseParty(/ABC UPPER/);

    await scanCode("RMQR_PTY000001_RM000001_000001");
    await scanCode("RMQR_PTY000001_RM000001_000002");
    await scanCode("RMQR_PTY000001_RM000001_000003");

    expect(rawMaterialIssueScan).toHaveBeenCalledTimes(3);
    await waitFor(() => expect(screen.getByTestId("received-count")).toHaveTextContent("3"));
  });

  it("a carton scanned here is turned away with a pointer to Store Move Out", async () => {
    createFakeBackend();
    renderPage();
    await ready();
    await chooseParty(/ABC UPPER/);

    await scanCode("SK6_RED_7/10_000001");

    await waitFor(() => expect(screen.getByTestId("scan-status")).toHaveTextContent("NOT A RAW MATERIAL QR"));
    expect(screen.getByText(/Store Move Out/)).toBeInTheDocument();
  });

  it("a packet already issued is refused and the station stays ready", async () => {
    const { rawMaterialIssueScan } = createFakeBackend();
    renderPage();
    await ready();
    await chooseParty(/ABC UPPER/);

    await scanCode(LABEL);
    await scanCode(LABEL);

    expect(rawMaterialIssueScan).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.getByTestId("scan-status")).toHaveTextContent("NOT IN STORE"));
    expect((screen.getByLabelText("Scanner input") as HTMLInputElement).value).toBe("");
  });

  it("a machine program sheet still reaches the program lookup, with no party chosen", async () => {
    const { rawMaterialIssueScan } = createFakeBackend();
    const onMachineProgramScan = vi.fn();
    renderPage({ onMachineProgramScan });
    await ready();

    await scanCode("MP-000012", 200);

    expect(onMachineProgramScan).toHaveBeenCalledWith("MP-000012");
    expect(rawMaterialIssueScan).not.toHaveBeenCalled();
  });

  it("Escape clears a part-typed code without submitting it", async () => {
    const { rawMaterialIssueScan } = createFakeBackend();
    renderPage();
    await ready();

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
