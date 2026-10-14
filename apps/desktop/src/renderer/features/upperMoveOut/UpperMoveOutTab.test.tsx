import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UpperMoveOutTab } from "./UpperMoveOutTab";
import { QrGeneratorWorkspace } from "../qrGenerator/QrGeneratorWorkspace";
import { NotificationsProvider } from "../../state/NotificationsContext";
import type { MachineRecord, UpperIssuePage, UpperIssueResult, UpperIssueRow, UpperIssueSummary, UpperStockRow } from "../../types/desktopApi";

// UPPER MOVE OUT — choose a machine, scan or type an upper packet's code; the main process decides,
// the screen shows what it decided, and the details, summary and stock come from the database.

function setupDesktop(api: Record<string, unknown>) {
  Object.defineProperty(window, "desktop", {
    value: { versions: { node: "22", chrome: "128", electron: "43" }, api },
    configurable: true,
  });
}

const machine = (id: string, name: string): MachineRecord => ({
  id, machineCode: id.toUpperCase(), name, sectionId: "ws", sectionName: "PACKING", sortOrder: 1, status: "ACTIVE",
  contractorPartyId: null, contractorName: null, packingContractorPartyId: null, packingContractorName: null,
});
const M1 = machine("m-1", "MACHINE 1");
const M2 = machine("m-2", "MACHINE 2");
const QR = "RM_P0001_I0042_000017";

const issue = (overrides: Partial<UpperIssueRow> = {}): UpperIssueRow => ({
  eventId: "e-1", qrId: QR, itemDisplayName: "RUBBER UPPER — SK6 — RED — 7/10", article: "SK6", size: "7/10", colour: "RED",
  quantity: 5, unitCode: "DOZEN", packName: "PACKET", machineId: "m-1", machineName: "MACHINE 1",
  issuedAt: "2026-10-14T05:42:00.000Z", issuedBy: "aslam", status: "ISSUED", ...overrides,
});
const page = (rows: UpperIssueRow[], machineId = "m-1"): UpperIssuePage => ({
  machineId, date: "2026-10-14", rows, page: 1, pageSize: 25,
  totals: { packets: rows.length, quantities: rows.length ? [{ unitCode: "DOZEN", quantity: rows.length * 5 }] : [] },
});
const summary = (machineName = "MACHINE 1"): UpperIssueSummary => ({
  machineId: "m-1", machineName,
  session: { sessionNumber: 12, packets: 1, quantities: [{ unitCode: "DOZEN", quantity: 5 }] },
  day: { date: "2026-10-14", packets: 3, quantities: [{ unitCode: "DOZEN", quantity: 15 }] },
  stock: { packets: 38, quantities: [{ unitCode: "DOZEN", quantity: 190 }] },
});
const issued = (machineId = "m-1", machineName = "MACHINE 1"): UpperIssueResult => ({ accepted: true, outcome: "ISSUED", qrId: QR, issue: issue({ machineId, machineName }) });
const stockRow = (overrides: Partial<UpperStockRow> = {}): UpperStockRow => ({
  itemId: "i-1", itemCode: "RM-1", displayName: "RUBBER UPPER — SK6 — RED — 7/10", categoryName: "RUBBER UPPER",
  article: "SK6", size: "7/10", colour: "RED", type: null, onHand: 60, unitCode: "DOZEN", packetsInStore: 12, packName: "PACKET", ...overrides,
});

function baseApi(overrides: Record<string, unknown> = {}) {
  return {
    listMachines: vi.fn().mockResolvedValue([M1, M2]),
    issueUpperToMachine: vi.fn().mockResolvedValue(issued()),
    listUpperIssues: vi.fn().mockImplementation(async ({ machineId }: { machineId: string }) => ({ accepted: true, page: page([], machineId) })),
    getUpperIssueSummary: vi.fn().mockResolvedValue({ accepted: true, summary: summary() }),
    listUpperStock: vi.fn().mockResolvedValue({ accepted: true, rows: [stockRow()] }),
    findUpperIssue: vi.fn().mockResolvedValue({ accepted: true, issue: null }),
    ...overrides,
  };
}

const renderTab = () =>
  render(
    <NotificationsProvider>
      <UpperMoveOutTab />
    </NotificationsProvider>
  );

const scanBox = () => screen.getByRole("textbox", { name: "Scanner input" });
const status = () => screen.getByTestId("scan-status");
const scannerTypes = (value: string) => fireEvent.change(scanBox(), { target: { value } });
const chooseMachine = async (name: string) => {
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Machine" })).toBeEnabled());
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Machine" }), name);
};

describe("UpperMoveOutTab", () => {
  beforeEach(() => vi.clearAllMocks());

  it("A: until a machine is chosen it says SELECT MACHINE and nothing can be scanned", async () => {
    const api = baseApi();
    setupDesktop(api);
    renderTab();
    expect(screen.getByRole("tab", { name: "Move Out" })).toHaveAttribute("aria-selected", "true");
    expect(status()).toHaveTextContent("SELECT MACHINE");
    expect(screen.getByText("Choose a machine before issuing upper cartons.")).toBeInTheDocument();
    expect(scanBox()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Enter" })).toBeDisabled();
    expect(api.issueUpperToMachine).not.toHaveBeenCalled();
    expect(api.listUpperIssues).not.toHaveBeenCalled();
  });

  it("B: a scan for the chosen machine is ISSUED, and the details and summary come back from the database", async () => {
    const listUpperIssues = vi.fn().mockResolvedValueOnce({ accepted: true, page: page([]) }).mockResolvedValue({ accepted: true, page: page([issue()]) });
    const api = baseApi({ listUpperIssues });
    setupDesktop(api);
    renderTab();
    await chooseMachine("MACHINE 1");
    expect(await screen.findByText("Issuing to MACHINE 1")).toBeInTheDocument();
    expect(await screen.findByText("Nothing issued to this machine today")).toBeInTheDocument();

    scannerTypes(QR);

    await waitFor(() => expect(status()).toHaveTextContent("ISSUED"));
    expect(api.issueUpperToMachine).toHaveBeenCalledWith(QR, "m-1");
    const table = await screen.findByRole("table", { name: "Upper packets issued to MACHINE 1 today" });
    expect(within(table).getAllByRole("row")[1]).toHaveTextContent(`${QR} (Latest)SK67/10RED5 DOZEN`);
    expect(screen.getByText("This session (#12)")).toBeInTheDocument();
    expect(screen.getByText("190 DOZEN")).toBeInTheDocument();
    expect(screen.getByText("Upper stock in store")).toBeInTheDocument();
  });

  it("C/D: a fabricated code, a finished carton and a non-upper are each named", async () => {
    const issueUpperToMachine = vi
      .fn()
      .mockResolvedValueOnce({ accepted: false, outcome: "UNKNOWN_QR", qrId: "RM_P0001_I0042_000999", reason: "This QR was never generated." })
      .mockResolvedValueOnce({ accepted: false, outcome: "FINISHED_CARTON", qrId: "SK6_RED_7/10_000001", reason: "This is a finished carton QR, not an upper." })
      .mockResolvedValueOnce({ accepted: false, outcome: "NOT_UPPER", qrId: "RM_P0001_I0050_000001", reason: "POLY BAG is not an upper." });
    setupDesktop(baseApi({ issueUpperToMachine }));
    renderTab();
    await chooseMachine("MACHINE 1");
    for (const [code, title] of [["RM_P0001_I0042_000999", "QR NOT GENERATED"], ["SK6_RED_7/10_000001", "FINISHED CARTON"], ["RM_P0001_I0050_000001", "NOT AN UPPER"]]) {
      scannerTypes(code);
      await waitFor(() => expect(status()).toHaveTextContent(title));
    }
  });

  it("E: a packet already issued says ALREADY ISSUED, with the machine and when", async () => {
    setupDesktop(baseApi({ issueUpperToMachine: vi.fn().mockResolvedValue({ accepted: false, outcome: "ALREADY_ISSUED", qrId: QR, issue: issue() }) }));
    renderTab();
    await chooseMachine("MACHINE 2");
    scannerTypes(QR);
    await waitFor(() => expect(status()).toHaveTextContent("ALREADY ISSUED"));
    expect(screen.getByText(/already issued to MACHINE 1/)).toBeInTheDocument();
  });

  it("G: a code typed by hand goes the same way with Enter or the button — with the machine", async () => {
    const api = baseApi();
    setupDesktop(api);
    renderTab();
    await chooseMachine("MACHINE 1");
    const user = userEvent.setup({ delay: 90 });
    await user.type(scanBox(), QR);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(api.issueUpperToMachine, "nothing is sent half-typed").not.toHaveBeenCalled();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(api.issueUpperToMachine).toHaveBeenCalledWith(QR, "m-1"));
    await user.type(scanBox(), QR);
    await user.click(screen.getByRole("button", { name: "Enter" }));
    await waitFor(() => expect(api.issueUpperToMachine).toHaveBeenCalledTimes(2));
    expect(api.issueUpperToMachine.mock.calls[1]).toEqual(api.issueUpperToMachine.mock.calls[0]);
  }, 15000);

  it("H: switching machine reads the new machine's issues — the old machine's are never shown under it", async () => {
    const listUpperIssues = vi.fn().mockImplementation(async ({ machineId }: { machineId: string }) => ({
      accepted: true,
      page: page(machineId === "m-1" ? [issue()] : [issue({ eventId: "e-2", qrId: "RM_P0001_I0042_000018", machineId: "m-2", machineName: "MACHINE 2" })], machineId),
    }));
    const api = baseApi({ listUpperIssues, issueUpperToMachine: vi.fn().mockResolvedValue(issued("m-2", "MACHINE 2")) });
    setupDesktop(api);
    renderTab();
    await chooseMachine("MACHINE 1");
    expect(await screen.findByText(QR)).toBeInTheDocument();

    await chooseMachine("MACHINE 2");
    expect(await screen.findByText("RM_P0001_I0042_000018")).toBeInTheDocument();
    expect(screen.queryByText(QR)).not.toBeInTheDocument();
    scannerTypes("RM_P0001_I0042_000019");
    await waitFor(() => expect(api.issueUpperToMachine).toHaveBeenCalledWith("RM_P0001_I0042_000019", "m-2"));
  });

  it("when the call itself fails, the database decides — issued to this machine after all", async () => {
    const api = baseApi({
      issueUpperToMachine: vi.fn().mockRejectedValue(new Error("IPC timeout")),
      findUpperIssue: vi.fn().mockResolvedValue({ accepted: true, issue: issue() }),
    });
    setupDesktop(api);
    renderTab();
    await chooseMachine("MACHINE 1");
    scannerTypes(QR);
    await waitFor(() => expect(status()).toHaveTextContent("ISSUED"));
    expect(screen.getByText("Issued to MACHINE 1 — confirmed after a connection problem.")).toBeInTheDocument();
    expect(api.issueUpperToMachine, "never retried blindly").toHaveBeenCalledTimes(1);
  });

  it("I/J: Stock lists the upper stock from the database, and searches in the main process", async () => {
    const api = baseApi();
    setupDesktop(api);
    renderTab();
    await userEvent.click(screen.getByRole("tab", { name: "Stock" }));
    const table = await screen.findByRole("table", { name: "Upper stock in the store" });
    expect(within(table).getAllByRole("row")[1]).toHaveTextContent("SK67/10REDRUBBER UPPER1260 DOZEN");

    await userEvent.type(screen.getByRole("searchbox", { name: "Search article, size or colour" }), "red");
    await waitFor(() => expect(api.listUpperStock).toHaveBeenLastCalledWith({ search: "red" }));
    expect(api.issueUpperToMachine).not.toHaveBeenCalled();
  });

  it("keeps the chosen machine when Stock is opened and closed", async () => {
    setupDesktop(baseApi());
    renderTab();
    await chooseMachine("MACHINE 2");
    await userEvent.click(screen.getByRole("tab", { name: "Stock" }));
    await userEvent.click(screen.getByRole("tab", { name: "Move Out" }));
    expect(screen.getByRole("combobox", { name: "Machine" })).toHaveValue("m-2");
  });
});

describe("Upper Move Out in the QR Generator", () => {
  beforeEach(() => vi.clearAllMocks());

  const workspaceApi = () => ({
    ...baseApi(),
    listProducts: vi.fn().mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: 1000 }),
    listQrColors: vi.fn().mockResolvedValue([]),
    listQrBatches: vi.fn().mockResolvedValue([]),
    listProductionReceipts: vi.fn().mockResolvedValue({ accepted: true, page: null }),
    generateQrBatch: vi.fn(),
  });

  it("comes after Receive Production and Manual Production, and shows its own machine choice", async () => {
    const api = workspaceApi();
    setupDesktop(api);
    render(
      <NotificationsProvider>
        <QrGeneratorWorkspace username="admin" onNavigate={vi.fn()} canReceiveProduction canUpperMoveOut />
      </NotificationsProvider>
    );
    expect(screen.getAllByRole("tab").slice(0, 5).map((tab) => tab.textContent)).toEqual(["Carton QR", "B-Carton Labels", "Receive Production", "Manual Production", "Upper Move Out"]);
    await userEvent.click(screen.getByRole("tab", { name: "Upper Move Out" }));
    expect(await screen.findByRole("heading", { name: "Upper Move Out" })).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "Machine" })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Machine" })).toBeInTheDocument();
    expect(api.issueUpperToMachine).not.toHaveBeenCalled();
    expect(api.generateQrBatch).not.toHaveBeenCalled();
  });

  it("is not offered to a user who may not issue raw material", () => {
    setupDesktop(workspaceApi());
    render(
      <NotificationsProvider>
        <QrGeneratorWorkspace username="admin" onNavigate={vi.fn()} canReceiveProduction />
      </NotificationsProvider>
    );
    expect(screen.queryByRole("tab", { name: "Upper Move Out" })).not.toBeInTheDocument();
  });
});
