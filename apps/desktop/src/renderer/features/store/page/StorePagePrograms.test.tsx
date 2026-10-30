import React, { useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotificationsProvider } from "../../../state/NotificationsContext";
import { StorePage } from "./StorePage";
import type { StoreMode } from "./storeTabs";

// MACHINE PROGRAMS ON THE STORE PAGE (0.3.9): the header button's pick-list replaces the full-width
// program bar, and everything the bar reached stays reachable. The program screens themselves (the
// issue panel, Carton In, completion) have their own tests in ProgramOut.test; they are stand-ins
// here, so what is proved is what the PAGE does with a program: which screen it gets, in which
// mode, and that both stations are disarmed while it is open.

vi.mock("../../../utils/playScanSound", () => ({ playScanSound: () => undefined }));
vi.mock("../../rawMaterial/RawMaterialSection", () => ({ RawMaterialSection: () => <div>section</div> }));
vi.mock("../../rawMaterial/useRawMaterialLookups", () => ({
  useRawMaterialLookups: () => ({ loading: false, error: null, categories: [], units: [], reload: async () => undefined }),
}));
vi.mock("../sections/NewMaterialForm", () => ({ NewMaterialForm: () => <div>new material form</div> }));
vi.mock("../HandMovePanel", () => ({ HandMovePanel: () => <div>by hand</div> }));
vi.mock("../programOut/ProgramOutPanel", () => ({
  ProgramOutPanel: ({ viewOnly, onClose, state }: { viewOnly?: boolean; onClose: () => void; state: { program: { code: string } | null } }) => (
    <div data-testid="program-panel">
      {`${state.program?.code} ${viewOnly ? "read only" : "issue"}`}
      <button type="button" onClick={onClose}>
        Close program
      </button>
    </div>
  ),
}));
vi.mock("../programOut/CartonInStation", () => ({
  CartonInStation: ({ programCode }: { programCode: string }) => <div data-testid="carton-in">{`Carton In ${programCode}`}</div>,
}));
vi.mock("../programClose/useProgramClose", () => ({
  useProgramCloseFor: () => ({ reconciliation: null }),
  isProgramClosed: () => false,
}));

const PROGRAM = { id: "p-3", code: "MP-000003", status: "PROGRAMMED" };
const OPEN = [{ programId: "p-3", code: "MP-000003", programDate: "2026-10-13", machineName: "MACHINE 2", contractorName: "BABAR" }];
const RECEIVING = {
  id: "rs-1", code: "RMI-000191", sessionNumber: 191, partyId: "sup-1", partyName: "SHEHZAD RUBBER",
  deviceId: "d1", startedBy: "store", status: "OPEN" as const, startedAt: "2026-10-30T04:00:00.000Z", closedAt: null,
};

// The stations wait for the lease answer before they mount (LeasedStation, useWriteLease): one more
// hop than 0.3.9 had, which can outlast the default second when the whole suite runs at once.
const LEASE_SETTLES = { timeout: 3000 };

function installApi() {
  const api = {
    listParties: vi.fn(async () => ({ rows: [], total: 0, page: 1, pageSize: 1000 })),
    getOpenRawMaterialReceivingSession: vi.fn(async () => RECEIVING),
    getRawMaterialReceivingSessionSummary: vi.fn(async () => ({ session: RECEIVING, totalPackets: 0, byMaterial: [], scans: [] })),
    getOpenRawMaterialIssueSession: vi.fn(async () => null),
    getRawMaterialIssueSessionSummary: vi.fn(async () => null),
    listRawMaterialIssueSessions: vi.fn(async () => []),
    listOpenMachinePrograms: vi.fn(async () => ({ accepted: true, rows: OPEN })),
    openMachineProgramStoreOut: vi.fn(async () => ({ accepted: true, program: PROGRAM })),
    listMachineProgramIssueBatches: vi.fn(async () => ({ accepted: true, rows: [] })),
    listMachineProgramCartonPackets: vi.fn(async () => ({ accepted: true, rows: [], progress: [], fixRuns: [] })),
    // No lease named: this computer may write the store (useWriteLease).
    getWriteLeases: vi.fn(async () => []),
  };
  Object.defineProperty(window, "desktop", { value: { versions: { node: "22", chrome: "128", electron: "43" }, api }, configurable: true });
  return api;
}

const Page: React.FC<{ start?: StoreMode; initialProgramId?: string; onOpenCartonQr?: () => void }> = ({ start = "receiving", initialProgramId, onOpenCartonQr }) => {
  const [mode, setMode] = useState<StoreMode>(start);
  return (
    <StorePage
      mode={mode}
      token="t-1"
      isAdmin={false}
      access={{ stock: true, labels: true, settings: true }}
      onModeChange={setMode}
      onNavigate={() => undefined}
      onOpenCartonQr={onOpenCartonQr}
      initialProgramId={initialProgramId}
    />
  );
};

const renderPage = (props: React.ComponentProps<typeof Page> = {}) =>
  render(
    <NotificationsProvider>
      <Page {...props} />
    </NotificationsProvider>
  );

const openFromPickList = async () => {
  fireEvent.click(screen.getByRole("button", { name: "Machine programs" }));
  const dialog = await screen.findByRole("dialog");
  await act(async () => {
    fireEvent.click(await within(dialog).findByRole("button", { name: "Open MP-000003" }));
  });
};

describe("Machine programs on the Store page", () => {
  afterEach(() => vi.restoreAllMocks());

  it("lists the open programs, keeps the lookup box, and offers the Carton QR Generator", async () => {
    installApi();
    const onOpenCartonQr = vi.fn();
    renderPage({ onOpenCartonQr });
    fireEvent.click(screen.getByRole("button", { name: "Machine programs" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("MP-000003")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Scan QR or enter Machine Program No.")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Carton QR Generator" }));
    expect(onOpenCartonQr).toHaveBeenCalled();
  });

  it("in Receiving, opens the program to read, with Carton In on the rail and Scan in disarmed", async () => {
    const api = installApi();
    renderPage();
    await waitFor(() => expect(screen.getByRole("button", { name: /Receiving/ })).toHaveTextContent("Session open"), LEASE_SETTLES);
    await openFromPickList();

    expect(api.openMachineProgramStoreOut).toHaveBeenCalledWith("p-3", expect.anything());
    expect(await screen.findByTestId("program-panel")).toHaveTextContent("MP-000003 read only");
    expect(screen.getByTestId("carton-in")).toHaveTextContent("Carton In MP-000003");
    expect(screen.queryByRole("complementary", { name: "Scan Material" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("in Issuing, opens the program to issue against, with Scan out paused", async () => {
    installApi();
    renderPage({ start: "issuing" });
    await openFromPickList();

    // Read only until the store lease is known (useWriteLease), then open for issue.
    const panel = await screen.findByTestId("program-panel");
    await waitFor(() => expect(panel).toHaveTextContent("MP-000003 issue"), LEASE_SETTLES);
    const rail = screen.getByRole("complementary", { name: "Scan Out" });
    expect(rail).toHaveTextContent("Scanning out is paused while MP-000003 is open");
    // The Scan Out panel waits behind the program, mounted: its box is not on screen.
    expect(within(rail).queryByLabelText("Scanner input")).toBeNull();
  });

  it("closing the program brings back the tabs and the rail, with the session still open", async () => {
    installApi();
    renderPage();
    await openFromPickList();
    fireEvent.click(await screen.findByRole("button", { name: "Close program" }));
    expect(screen.getByRole("tablist", { name: "Receiving sections" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Scan Material" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Receiving/ })).toHaveTextContent("Session open");
  });

  it("opens the program a notification names, on arrival", async () => {
    const api = installApi();
    renderPage({ start: "issuing", initialProgramId: "p-3" });
    // Read only until the store lease is known (useWriteLease), then open for issue.
    const panel = await screen.findByTestId("program-panel");
    await waitFor(() => expect(panel).toHaveTextContent("MP-000003 issue"), LEASE_SETTLES);
    expect(api.openMachineProgramStoreOut).toHaveBeenCalledTimes(1);
  });
});
