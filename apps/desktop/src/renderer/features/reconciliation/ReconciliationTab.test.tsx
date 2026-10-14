import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReconciliationTab } from "./ReconciliationTab";
import { QrGeneratorWorkspace } from "../qrGenerator/QrGeneratorWorkspace";
import { MachineProgramPage } from "../machineProgram/MachineProgramPage";
import { NotificationsProvider } from "../../state/NotificationsContext";
import type { MachineDayProgram, ProgramReconciliation, ReconcilableProgram } from "../../types/desktopApi";

// RECONCILIATION — a program's Upper Out against its Production Received, as the main process counts
// them; reached from the Machine Program, from Receive Production, or as its own tab.

function setupDesktop(api: Record<string, unknown>) {
  Object.defineProperty(window, "desktop", {
    value: { versions: { node: "22", chrome: "128", electron: "43" }, api },
    configurable: true,
  });
}

const programRef = (overrides: Partial<ReconcilableProgram> = {}): ReconcilableProgram => ({
  programId: "mp-1", code: "MP-000001", programDate: "2026-10-14", machineId: "m-1", machineName: "MACHINE 1", ...overrides,
});

const reconciliation = (overrides: Partial<ProgramReconciliation> = {}): ProgramReconciliation => ({
  program: { ...programRef(), contractorName: "ASLAM", packingContractorName: "BABAR" },
  upperOut: { packets: 4, quantities: [{ unitCode: "DOZEN", quantity: 20 }] },
  productionReceived: { cartons: 23, bCartons: 2, manualCartons: 0 },
  comparison: { upperDozens: 20, otherUpper: [], receivedDozens: 11.5, comparable: true, differenceDozens: 8.5 },
  ...overrides,
});

const dayProgram = (): MachineDayProgram => ({
  programId: "mp-1", programNumber: 1, code: "MP-000001", programDate: "2026-10-14", machineId: "m-1", machineName: "MACHINE 1",
  contractorName: "ASLAM", packingContractorName: "BABAR", cartons: 30, voidedCartons: 0, equivalentDozens: 15, lines: [],
});

function baseApi(overrides: Record<string, unknown> = {}) {
  return {
    listReconcilablePrograms: vi.fn().mockResolvedValue({ accepted: true, rows: [programRef(), programRef({ programId: "mp-2", code: "MP-000002", machineId: "m-2", machineName: "MACHINE 2" })] }),
    getProgramReconciliation: vi.fn().mockResolvedValue({ accepted: true, reconciliation: reconciliation() }),
    ...overrides,
  };
}

const renderTab = (programId: string | null = null) => {
  const onProgramChange = vi.fn();
  const view = render(
    <NotificationsProvider>
      <ReconciliationTab programId={programId} onProgramChange={onProgramChange} />
    </NotificationsProvider>
  );
  return { ...view, onProgramChange };
};

describe("ReconciliationTab", () => {
  beforeEach(() => vi.clearAllMocks());

  it("opened with no program, asks for one and reads nothing program-specific", async () => {
    const api = baseApi();
    setupDesktop(api);
    const { onProgramChange } = renderTab(null);
    expect(screen.getByText("Choose a machine program")).toBeInTheDocument();
    const select = screen.getByRole("combobox", { name: "Machine program" });
    await waitFor(() => expect(select).toBeEnabled());
    expect(api.getProgramReconciliation).not.toHaveBeenCalled();
    await userEvent.selectOptions(select, "MP-000002 · MACHINE 2");
    expect(onProgramChange).toHaveBeenCalledWith("mp-2");
  });

  it("shows the two figures side by side, the counts and the difference", async () => {
    const api = baseApi();
    setupDesktop(api);
    renderTab("mp-1");
    const table = await screen.findByRole("table", { name: "Reconciliation of MP-000001" });
    expect(api.getProgramReconciliation).toHaveBeenCalledWith("mp-1");
    const rows = within(table).getAllByRole("row").map((row) => row.textContent);
    expect(rows).toEqual([
      "MeasureUpper OutProduction Received",
      "Quantity (dozens)20 DZN11.5 DZN",
      "Count4 packets23 cartonsincl. 2 B",
      "Difference (Upper Out − Production Received)8.5 DZN",
    ]);
    expect(screen.getByRole("heading", { name: "MACHINE 1" })).toBeInTheDocument();
    expect(screen.getByText(/Upper Out: upper packets issued to MACHINE 1/)).toBeInTheDocument();
  });

  it("an upper in another unit is listed, and no difference is given", async () => {
    setupDesktop(baseApi({
      getProgramReconciliation: vi.fn().mockResolvedValue({
        accepted: true,
        reconciliation: reconciliation({
          upperOut: { packets: 2, quantities: [{ unitCode: "DOZEN", quantity: 5 }, { unitCode: "PAIR", quantity: 24 }] },
          comparison: { upperDozens: 5, otherUpper: [{ unitCode: "PAIR", quantity: 24 }], receivedDozens: 2, comparable: false, differenceDozens: null },
        }),
      }),
    }));
    renderTab("mp-1");
    const table = await screen.findByRole("table", { name: "Reconciliation of MP-000001" });
    expect(within(table).getByText("Other units (not compared)")).toBeInTheDocument();
    expect(within(table).getByText("24 PAIR")).toBeInTheDocument();
    expect(within(table).getByText(/Not shown — some uppers are counted in a unit/)).toBeInTheDocument();
  });

  it("shows loading, then the error with a retry that works", async () => {
    let answer: (value: unknown) => void = () => undefined;
    const getProgramReconciliation = vi
      .fn()
      .mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
      .mockResolvedValue({ accepted: true, reconciliation: reconciliation() });
    setupDesktop(baseApi({ getProgramReconciliation }));
    renderTab("mp-1");
    expect(screen.getByText("Loading the reconciliation…")).toBeInTheDocument();
    answer({ accepted: false, reconciliation: null, reason: "That machine program no longer exists." });
    expect(await screen.findByText("That machine program no longer exists.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("table", { name: "Reconciliation of MP-000001" })).toBeInTheDocument();
  });
});

describe("Opening Reconciliation", () => {
  beforeEach(() => vi.clearAllMocks());

  const workspaceApi = () => ({
    ...baseApi(),
    listMachines: vi.fn().mockResolvedValue([]),
    listMachineDayPrograms: vi.fn().mockResolvedValue({ accepted: true, rows: [dayProgram()] }),
    listProductionReceipts: vi.fn().mockResolvedValue({ accepted: true, page: null }),
    receiveProduction: vi.fn(),
    findProductionReceipt: vi.fn(),
    listProducts: vi.fn().mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: 1000 }),
    listQrColors: vi.fn().mockResolvedValue([]),
    listQrBatches: vi.fn().mockResolvedValue([]),
  });

  const renderWorkspace = (props: Partial<React.ComponentProps<typeof QrGeneratorWorkspace>> = {}) =>
    render(
      <NotificationsProvider>
        <QrGeneratorWorkspace username="admin" onNavigate={vi.fn()} canMachineProgram canReceiveProduction {...props} />
      </NotificationsProvider>
    );

  it("is the workspace's last tab, and opening it with nothing chosen asks for a program", async () => {
    const api = workspaceApi();
    setupDesktop(api);
    renderWorkspace();
    expect(screen.getAllByRole("tab").at(-1)).toHaveTextContent("Reconciliation");
    await userEvent.click(screen.getByRole("tab", { name: "Reconciliation" }));
    expect(screen.getByText("Choose a machine program")).toBeInTheDocument();
    expect(api.getProgramReconciliation).not.toHaveBeenCalled();
  });

  it("Start Reconciliation on a Machine Program card opens that program", async () => {
    const api = workspaceApi();
    setupDesktop(api);
    renderWorkspace();
    await userEvent.click(await screen.findByRole("button", { name: "Start reconciliation of MP-000001" }));
    expect(screen.getByRole("tab", { name: "Reconciliation" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByRole("table", { name: "Reconciliation of MP-000001" })).toBeInTheDocument();
    expect(api.getProgramReconciliation).toHaveBeenCalledWith("mp-1");
  });

  it("Start Reconciliation on Receive Production opens it to choose a program — it never guesses one", async () => {
    const api = workspaceApi();
    setupDesktop(api);
    renderWorkspace({ initialTab: "receive" });
    await userEvent.click(screen.getByRole("button", { name: "Start Reconciliation" }));
    expect(screen.getByRole("tab", { name: "Reconciliation" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Choose a machine program")).toBeInTheDocument();
    expect(api.getProgramReconciliation).not.toHaveBeenCalled();
  });

  it("a program brought from the Machine Program page opens straight on it", async () => {
    const api = workspaceApi();
    setupDesktop(api);
    renderWorkspace({ initialTab: "reconcile", reconcileProgramId: "mp-1" });
    expect(await screen.findByRole("table", { name: "Reconciliation of MP-000001" })).toBeInTheDocument();
  });

  it("the stand-alone Machine Program page hands the program on", async () => {
    setupDesktop(workspaceApi());
    const onStartReconciliation = vi.fn();
    render(
      <NotificationsProvider>
        <MachineProgramPage onStartReconciliation={onStartReconciliation} />
      </NotificationsProvider>
    );
    await userEvent.click(await screen.findByRole("button", { name: "Start reconciliation of MP-000001" }));
    expect(onStartReconciliation).toHaveBeenCalledWith("mp-1");
  });

  it("is not offered without the Machine Program", () => {
    setupDesktop(workspaceApi());
    renderWorkspace({ canMachineProgram: false });
    expect(screen.queryByRole("tab", { name: "Reconciliation" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start Reconciliation" })).not.toBeInTheDocument();
  });
});
