import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MachineProgramPage } from "./MachineProgramPage";
import { NotificationsProvider } from "../../state/NotificationsContext";
import type { CartonProgramBatch, CartonProgramLine, MachineDayProgram, MachineRecord } from "../../types/desktopApi";

// MACHINE PROGRAM — the machines with their two contractors, and each machine's program for a
// day (MP-000123), made of the carton QRs generated for it. The page sets machines up and reads
// programs; it never generates a code or opens a program.

function setupDesktop(api: Record<string, unknown>) {
  Object.defineProperty(window, "desktop", {
    value: { versions: { node: "22", chrome: "128", electron: "43" }, api },
    configurable: true,
  });
}

const machine = (overrides: Partial<MachineRecord> = {}): MachineRecord => ({
  id: "m-1",
  machineCode: "M-001",
  name: "MACHINE 1",
  sectionId: "ws-1",
  sectionName: "PACKING",
  sortOrder: 1,
  status: "ACTIVE",
  contractorPartyId: "p-aslam",
  contractorName: "ASLAM",
  packingContractorPartyId: "p-babar",
  packingContractorName: "BABAR",
  ...overrides,
});

const line = (overrides: Partial<CartonProgramLine> = {}): CartonProgramLine => ({
  articleSizeId: "as-sk6",
  productVariantId: "pv-sk6-bg",
  article: "SK6",
  size: "7/10",
  color: "BLACKGREY",
  grade: null,
  cartons: 10,
  voidedCartons: 0,
  equivalentDozens: 5,
  batchCount: 1,
  lastGeneratedAt: "2026-10-13T05:42:00.000Z",
  ...overrides,
});

const program = (overrides: Partial<MachineDayProgram> = {}): MachineDayProgram => ({
  programId: "mp-123",
  programNumber: 123,
  code: "MP-000123",
  programDate: "2026-10-13",
  machineId: "m-1",
  machineName: "MACHINE 1",
  contractorName: "ASLAM",
  packingContractorName: "BABAR",
  cartons: 10,
  voidedCartons: 0,
  equivalentDozens: 5,
  lines: [line()],
  ...overrides,
});

const run = (overrides: Partial<CartonProgramBatch> = {}): CartonProgramBatch => ({
  id: "batch-1",
  firstQrId: "SK6_BLACKGREY_7/10_000001",
  lastQrId: "SK6_BLACKGREY_7/10_000010",
  cartons: 10,
  voidedCartons: 0,
  equivalentDozens: 5,
  createdAt: "2026-10-13T04:05:00.000Z",
  createdBy: "admin",
  requestedBy: null,
  ...overrides,
});

const contractor = (id: string, partyName: string) => ({ id, partyName, partyType: "CONTRACTOR", status: "ACTIVE", city: "Lahore" });

function baseApi(overrides: Record<string, unknown> = {}) {
  return {
    listMachines: vi.fn().mockResolvedValue([machine()]),
    listMachineDayPrograms: vi.fn().mockResolvedValue({ accepted: true, rows: [program()] }),
    listCartonProgramBatches: vi.fn().mockResolvedValue({ accepted: true, rows: [run()] }),
    listParties: vi.fn().mockResolvedValue({
      rows: [contractor("p-aslam", "ASLAM"), contractor("p-babar", "BABAR"), contractor("p-khan", "KHAN")],
      total: 3,
      page: 1,
      pageSize: 500,
    }),
    addMachine: vi.fn().mockResolvedValue({ accepted: true, outcome: "ADDED", machineId: "m-2" }),
    assignMachineContractor: vi.fn().mockResolvedValue({ accepted: true, outcome: "ASSIGNED" }),
    generateQrBatch: vi.fn(),
    ...overrides,
  };
}

const renderPage = (props: Partial<React.ComponentProps<typeof MachineProgramPage>> = {}) =>
  render(
    <NotificationsProvider>
      <MachineProgramPage {...props} />
    </NotificationsProvider>
  );

/** A cell as read, without the row's ▸ / ▾ disclosure mark. */
const cellText = (cell: HTMLElement) => (cell.textContent ?? "").replace(/^[▸▾]/, "");

const programTable = (code = "MP-000123") => screen.findByRole("table", { name: `Carton QRs of ${code}` });

/** Picks a contractor in one of the dialog's two dropdowns. */
const pickContractor = async (field: string, name: string) => {
  await userEvent.click(screen.getByRole("combobox", { name: field }));
  await userEvent.click(await screen.findByRole("option", { name: new RegExp(name) }));
};

describe("MachineProgramPage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows each machine with its machine contractor and packing contractor", async () => {
    setupDesktop(baseApi({ listMachines: vi.fn().mockResolvedValue([machine(), machine({ id: "m-2", name: "MACHINE 2", machineCode: "M-002", packingContractorPartyId: null, packingContractorName: null })]) }));
    renderPage();

    const cards = within(await screen.findByRole("list", { name: "Machines" })).getAllByRole("listitem");
    expect(cards).toHaveLength(2);
    expect(within(cards[0]).getByRole("heading", { name: "MACHINE 1" })).toBeInTheDocument();
    expect(within(cards[0]).getByText("ASLAM")).toBeInTheDocument();
    expect(within(cards[0]).getByText("BABAR")).toBeInTheDocument();
    expect(within(cards[1]).getByText("⚠ Not set"), "an unset contractor is said in words").toBeInTheDocument();
  });

  it("A: shows a machine's day program — MP number, machine, contractors, cartons and dozens", async () => {
    setupDesktop(baseApi());
    renderPage();

    const card = (await programTable()).closest("article") as HTMLElement;
    expect(within(card).getByText("MP-000123")).toBeInTheDocument();
    expect(within(card).getByRole("heading", { name: "MACHINE 1" })).toBeInTheDocument();
    expect(within(card).getByText("10 cartons")).toBeInTheDocument();
    const row = within(await programTable()).getAllByRole("row")[1];
    expect(within(row).getAllByRole("cell").slice(0, 6).map(cellText)).toEqual(["SK6", "7/10", "BLACKGREY", "10", "5 DZN", "1"]);
  });

  it("B: each machine's program is its own card, and a line's runs are listed when opened", async () => {
    const api = baseApi({
      listMachineDayPrograms: vi.fn().mockResolvedValue({
        accepted: true,
        rows: [
          program({ cartons: 17, lines: [line({ cartons: 17, equivalentDozens: 8.5, batchCount: 2 })] }),
          program({ programId: "mp-124", programNumber: 124, code: "MP-000124", machineId: "m-2", machineName: "MACHINE 2", contractorName: "KHAN" }),
        ],
      }),
      listCartonProgramBatches: vi.fn().mockResolvedValue({
        accepted: true,
        rows: [run({ id: "batch-2", firstQrId: "SK6_BLACKGREY_7/10_000011", lastQrId: "SK6_BLACKGREY_7/10_000017", cartons: 7 }), run()],
      }),
    });
    setupDesktop(api);
    renderPage();

    expect(await programTable("MP-000124")).toBeInTheDocument();
    const first = await programTable("MP-000123");
    expect(within(first).getByText("8.5 DZN")).toBeInTheDocument();

    await userEvent.click(within(first).getByRole("button", { name: "Show the runs for SK6 7/10 BLACKGREY" }));
    const runs = await screen.findByRole("list", { name: "Codes" });
    expect(within(runs).getAllByRole("listitem")).toHaveLength(2);
    expect(within(runs).getByText(/7 cartons · 3\.5 DZN/)).toBeInTheDocument();
    expect(api.listCartonProgramBatches).toHaveBeenCalledWith({ programId: "mp-123", articleSizeId: "as-sk6", color: "BLACKGREY", grade: null });
  });

  it("marks a B carton line with a B, in words for screen readers", async () => {
    setupDesktop(baseApi({ listMachineDayPrograms: vi.fn().mockResolvedValue({ accepted: true, rows: [program({ lines: [line({ color: "MIX", grade: "B", cartons: 3 })] })] }) }));
    renderPage();
    const table = await programTable();
    expect(within(table).getByLabelText("B carton")).toHaveTextContent("B");
  });

  it("C: changing the day and refreshing only re-read — nothing is generated", async () => {
    const api = baseApi();
    setupDesktop(api);
    renderPage();
    await programTable();
    const firstDay = api.listMachineDayPrograms.mock.calls[0][0] as string;

    await userEvent.click(screen.getByRole("button", { name: /previous day/i }));
    await waitFor(() => expect(api.listMachineDayPrograms).toHaveBeenCalledTimes(2));
    expect(api.listMachineDayPrograms.mock.calls[1][0]).not.toBe(firstDay);

    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(api.listMachineDayPrograms).toHaveBeenCalledTimes(3));
    expect(api.generateQrBatch).not.toHaveBeenCalled();
    expect(api.addMachine).not.toHaveBeenCalled();
  });

  it("shows the empty day with a way to the QR Generator, and an error with retry", async () => {
    const listMachineDayPrograms = vi
      .fn()
      .mockResolvedValueOnce({ accepted: false, rows: [], reason: "Machine Program access is required." })
      .mockResolvedValueOnce({ accepted: true, rows: [] });
    setupDesktop(baseApi({ listMachineDayPrograms }));
    const openQrGenerator = vi.fn();
    renderPage({ onOpenQrGenerator: openQrGenerator });

    expect(await screen.findByText("Machine Program access is required.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("No programs on this day")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open QR Generator" }));
    expect(openQrGenerator).toHaveBeenCalledTimes(1);
  });

  it("Add Machine: names the machine, picks both contractors, and saves them in one step", async () => {
    const api = baseApi();
    setupDesktop(api);
    renderPage();
    await screen.findByRole("list", { name: "Machines" });

    await userEvent.click(screen.getByRole("button", { name: /add machine/i }));
    const dialog = await screen.findByRole("dialog", { name: "Add Machine" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Add Machine" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Type the machine's name.");
    expect(api.addMachine).not.toHaveBeenCalled();

    await userEvent.type(within(dialog).getByLabelText("Machine name"), "Machine 2");
    await pickContractor("Machine contractor", "KHAN");
    await pickContractor("Packing contractor", "BABAR");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add Machine" }));

    await waitFor(() =>
      expect(api.addMachine).toHaveBeenCalledWith({ name: "Machine 2", contractorPartyId: "p-khan", packingContractorPartyId: "p-babar" })
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(api.listMachines).toHaveBeenCalledTimes(2);
  });

  it("Add Machine shows the main process's refusal and keeps the dialog open", async () => {
    setupDesktop(baseApi({ addMachine: vi.fn().mockResolvedValue({ accepted: false, outcome: "MACHINE_EXISTS", reason: "MACHINE 1 is already set up. Change its contractors instead." }) }));
    renderPage();
    await screen.findByRole("list", { name: "Machines" });
    await userEvent.click(screen.getByRole("button", { name: /add machine/i }));
    const dialog = await screen.findByRole("dialog", { name: "Add Machine" });
    await userEvent.type(within(dialog).getByLabelText("Machine name"), "Machine 1");
    await pickContractor("Machine contractor", "ASLAM");
    await pickContractor("Packing contractor", "BABAR");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add Machine" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("already set up");
  });

  it("Change contractors saves only the contractor that changed", async () => {
    const api = baseApi();
    setupDesktop(api);
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Change contractors of MACHINE 1" }));
    const dialog = await screen.findByRole("dialog", { name: "Contractors of MACHINE 1" });
    await pickContractor("Packing contractor", "KHAN");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(api.assignMachineContractor).toHaveBeenCalledTimes(1));
    expect(api.assignMachineContractor).toHaveBeenCalledWith({ machineId: "m-1", role: "PACKING", contractorPartyId: "p-khan" });
  });

  it("G: none of the retired planning workflow is on the page", async () => {
    setupDesktop(baseApi());
    renderPage();
    await programTable();
    expect(screen.queryByText(/injector/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/sole/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /print program/i })).not.toBeInTheDocument();
  });
});
