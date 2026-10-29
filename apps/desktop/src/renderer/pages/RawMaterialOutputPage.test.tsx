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
// Since 0.3.8 a session belongs to one party: choose the party (a supplier or a contractor), press
// Start issuing, scan, End session. The session no longer opens by itself, and the party cannot be
// changed while one runs.

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

function createFakeBackend(options: { open?: RawMaterialIssueSession | null; openParty?: string | null } = {}) {
  const issued: RawMaterialIssueSessionSummary["scans"] = [];
  let clock = 0;
  let party: string | null = options.openParty ?? null;

  const summary = (): RawMaterialIssueSessionSummary => ({
    session: SESSION,
    partyId: party,
    partyName: PARTIES.find((p) => p.id === party)?.partyName ?? null,
    totalPackets: issued.length,
    byMaterial: issued.length
      ? [{ itemDisplayName: "RUBBER UPPER — SK6 — RED — 7/10", packets: issued.length, quantity: issued.length * 2, unitCode: "DOZ" }]
      : [],
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
      party ??= opts?.issuedToPartyId ?? null;
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
    getOpenRawMaterialIssueSession: vi.fn(async () => options.open ?? null),
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

/** The page is up: the party list loaded. No session is opened on arrival. */
const ready = async () => {
  await screen.findByRole("combobox", { name: "Moving out to" });
};

const newSessionButton = () => screen.getByRole("button", { name: /Start scanning/ });
const endSessionButton = () => screen.getByRole("button", { name: /End batch/ });

/** The whole sequence: choose the party, then Start issuing. */
const startFor = async (name: RegExp) => {
  await chooseParty(name);
  await act(async () => {
    fireEvent.click(newSessionButton());
  });
  await screen.findByTestId("locked-party");
};

describe("RawMaterialOutputPage", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not open a session by itself: Start issuing waits for a party, and nothing can be scanned", async () => {
    const { api } = createFakeBackend();
    renderPage();
    await ready();

    expect(api.getOpenRawMaterialIssueSession).toHaveBeenCalled();
    expect(api.startRawMaterialIssueSession).not.toHaveBeenCalled();
    expect(newSessionButton()).toBeDisabled();
    expect(endSessionButton()).toBeDisabled();
    expect(screen.getByLabelText("Scanner input")).toBeDisabled();
  });

  it("shows each party's type in the list, while choosing", async () => {
    createFakeBackend();
    renderPage();
    await ready();

    await openPartyList();
    expect(await screen.findByRole("option", { name: /ABC UPPER/ })).toHaveTextContent("Supplier");
    expect(screen.getByRole("option", { name: /ASLAM UPPER MAKER/ })).toHaveTextContent("Contractor");
  });

  it("finds the contractors when their type is typed", async () => {
    createFakeBackend();
    renderPage();
    await ready();

    const box = screen.getByRole("combobox", { name: "Moving out to" });
    await act(async () => {
      fireEvent.click(box);
    });
    await act(async () => {
      fireEvent.change(box, { target: { value: "contractor" } });
    });
    expect(await screen.findByRole("option", { name: /ASLAM UPPER MAKER/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /ABC UPPER/ })).toBeNull();
  });

  it("shows what kind of party is chosen, before the session starts", async () => {
    createFakeBackend();
    renderPage();
    await ready();

    await chooseParty(/ABC UPPER/);
    expect(screen.getByTestId("party-type-badge")).toHaveTextContent("Supplier");
    expect(newSessionButton()).toBeEnabled();
  });

  it("Start issuing locks the session to the chosen party: the picker gives way to the party, its type and the lock", async () => {
    const { api } = createFakeBackend();
    renderPage();
    await ready();

    await startFor(/ASLAM UPPER MAKER/);

    expect(api.startRawMaterialIssueSession).toHaveBeenCalledWith(expect.objectContaining({ startNew: true }));
    const locked = screen.getByTestId("locked-party");
    expect(locked).toHaveTextContent("ASLAM UPPER MAKER");
    expect(locked).toHaveTextContent("Contractor");
    expect(screen.queryByRole("combobox", { name: "Moving out to" })).toBeNull();
    expect(newSessionButton()).toBeDisabled();
    expect(endSessionButton()).toBeEnabled();
    await waitFor(() => expect(screen.getByTestId("session-code")).toHaveTextContent("RMO-000007"));
  });

  it("every scan is sent with the session's party, and says who it went to", async () => {
    const { rawMaterialIssueScan } = createFakeBackend();
    renderPage();
    await ready();

    await startFor(/ASLAM UPPER MAKER/);
    await scanCode(LABEL);

    expect(rawMaterialIssueScan).toHaveBeenCalledTimes(1);
    expect(rawMaterialIssueScan.mock.calls[0][1]).toMatchObject({ issuedToPartyId: "party-contractor" });
    await waitFor(() => expect(screen.getByTestId("scan-zone")).toHaveAttribute("data-state", "accepted"));
    // Said in words, not by colour: Issued, the material, how much, the packet.
    expect(screen.getByTestId("scan-zone")).toHaveTextContent("Issued");
    expect(screen.getByTestId("scan-zone")).toHaveTextContent("RUBBER UPPER — SK6 — RED — 7/10");
    expect(screen.getByTestId("scan-zone")).toHaveTextContent(LABEL);
  });

  it("End session frees the party: the picker comes back and scanning stops", async () => {
    const { api } = createFakeBackend();
    renderPage();
    await ready();
    await startFor(/ABC UPPER/);

    await act(async () => {
      fireEvent.click(endSessionButton());
    });

    expect(api.closeRawMaterialIssueSession).toHaveBeenCalledWith("session-1");
    expect(await screen.findByRole("combobox", { name: "Moving out to" })).toBeInTheDocument();
    expect(screen.queryByTestId("locked-party")).toBeNull();
    expect(screen.getByLabelText("Scanner input")).toBeDisabled();
    expect(newSessionButton()).toBeEnabled();
  });

  it("after a restart mid-session, the open session comes back locked to the party of its packets", async () => {
    const { api } = createFakeBackend({ open: SESSION, openParty: "party-contractor" });
    renderPage();

    const locked = await screen.findByTestId("locked-party");
    expect(locked).toHaveTextContent("ASLAM UPPER MAKER");
    expect(api.startRawMaterialIssueSession).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Scanner input")).toBeEnabled();
  });

  it("an open session with nothing in it yet comes back unlocked: choose the party and start", async () => {
    createFakeBackend({ open: SESSION, openParty: null });
    renderPage();
    await ready();

    expect(screen.queryByTestId("locked-party")).toBeNull();
    expect(screen.getByLabelText("Scanner input")).toBeDisabled();
  });

  it("shows the main process refusing a packet for another party, and nothing moves", async () => {
    const { rawMaterialIssueScan } = createFakeBackend();
    rawMaterialIssueScan.mockResolvedValueOnce({
      accepted: false,
      outcome: "NO_PARTY",
      qrId: LABEL,
      reason: "This session's packets go to ABC UPPER. End the session and start a new one to move packets out to someone else. Nothing was moved.",
    });
    renderPage();
    await ready();
    await startFor(/ABC UPPER/);

    await scanCode(LABEL);

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Not issued"));
    expect(screen.getByRole("alert")).toHaveTextContent("Nobody is chosen to send it to");
    expect(screen.getByRole("alert")).toHaveTextContent(/End the session and start a new one/);
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

  it("submits a scanned packet on its own, with no Enter key", async () => {
    const { rawMaterialIssueScan } = createFakeBackend();
    renderPage();
    await ready();
    await startFor(/ABC UPPER/);

    await scanCode(LABEL);

    expect(rawMaterialIssueScan).toHaveBeenCalledTimes(1);
    expect(rawMaterialIssueScan.mock.calls[0][0]).toBe(LABEL);
    await waitFor(() => expect(screen.getByTestId("scan-zone")).toHaveAttribute("data-state", "accepted"));
    expect((screen.getByLabelText("Scanner input") as HTMLInputElement).value).toBe("");
  });

  it("scans arriving back to back are each submitted exactly once", async () => {
    const { rawMaterialIssueScan } = createFakeBackend();
    renderPage();
    await ready();
    await startFor(/ABC UPPER/);

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
    await startFor(/ABC UPPER/);

    await scanCode("SK6_RED_7/10_000001");

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("This is not a raw material label"));
    expect(screen.getByRole("alert")).toHaveTextContent(/Store Move Out/);
  });

  it("a packet already issued is refused and the station stays ready", async () => {
    const { rawMaterialIssueScan } = createFakeBackend();
    renderPage();
    await ready();
    await startFor(/ABC UPPER/);

    await scanCode(LABEL);
    await scanCode(LABEL);

    expect(rawMaterialIssueScan).toHaveBeenCalledTimes(2);
    // A double scan is explained by the first one, right there in the session.
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("This packet has already gone out"));
    expect(screen.getByRole("alert")).toHaveTextContent(/You scanned it at .+, as packet 1 of this batch\./);
    expect(screen.getByRole("alert")).toHaveTextContent("Put it aside and scan the next one.");
    expect((screen.getByLabelText("Scanner input") as HTMLInputElement).value).toBe("");
  });

  it("a machine program sheet scanned into a running session reaches the program lookup, and moves nothing", async () => {
    const { rawMaterialIssueScan } = createFakeBackend();
    const onMachineProgramScan = vi.fn();
    renderPage({ onMachineProgramScan });
    await ready();

    await startFor(/ASLAM UPPER MAKER/);
    await scanCode("MP-000012", 200);

    expect(onMachineProgramScan).toHaveBeenCalledWith("MP-000012");
    expect(rawMaterialIssueScan).not.toHaveBeenCalled();
  });

  it("tells Store Out which session is open, so a program batch prints on the same slip", async () => {
    createFakeBackend();
    const onSessionChange = vi.fn();
    renderPage({ onSessionChange });
    await ready();
    expect(onSessionChange).toHaveBeenLastCalledWith(null);

    await startFor(/ASLAM UPPER MAKER/);
    await waitFor(() => expect(onSessionChange).toHaveBeenLastCalledWith(expect.any(String)));

    await act(async () => {
      fireEvent.click(endSessionButton());
    });
    await waitFor(() => expect(onSessionChange).toHaveBeenLastCalledWith(null));
  });

  it("Escape clears a part-typed code without submitting it", async () => {
    const { rawMaterialIssueScan } = createFakeBackend();
    renderPage();
    await ready();
    await startFor(/ABC UPPER/);

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
