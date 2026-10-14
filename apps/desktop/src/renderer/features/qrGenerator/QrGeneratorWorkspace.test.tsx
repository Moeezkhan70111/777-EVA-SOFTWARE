import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QrGeneratorWorkspace } from "./QrGeneratorWorkspace";
import { NotificationsProvider } from "../../state/NotificationsContext";
import type { MachineRecord } from "../../types/desktopApi";

// QR GENERATOR workspace — Carton QR and B-Carton Labels as two tabs, and the machine chosen once
// above both. Nothing is generated until a machine is chosen; the run then names it.

vi.mock("../../utils/qrLabels", () => ({
  QrPreview: ({ value }: { value: string }) => <span>{value}</span>,
  openCartonLabelPrintWindow: vi.fn(() => true),
}));

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

const EVR9 = {
  id: "as-evr9", articleSizeId: "as-evr9", article: "EVR9", color: "", size: "7/10", colors: [], description: null,
  costPrice: 300, sellingPrice: 550, mainGroupId: null, groupId: null, articleSeriesId: null, status: "ACTIVE",
  createdAt: "2024-01-01", updatedAt: "2024-01-01",
};

function baseApi(overrides: Record<string, unknown> = {}) {
  return {
    listMachines: vi.fn().mockResolvedValue([
      machine(),
      machine({ id: "m-3", name: "MACHINE 3", machineCode: "M-003", packingContractorPartyId: null, packingContractorName: null }),
    ]),
    listProducts: vi.fn().mockResolvedValue({ rows: [EVR9], total: 1, page: 1, pageSize: 1000 }),
    listQrColors: vi.fn().mockResolvedValue([]),
    listQrBatches: vi.fn().mockResolvedValue([]),
    getQrSequenceState: vi.fn().mockResolvedValue({ article: "EVR9", size: "7/10", color: "MIX", lastSequence: 0, nextSequence: 1 }),
    generateQrBatch: vi.fn().mockResolvedValue({ accepted: false, reason: "not under test" }),
    ...overrides,
  };
}

const renderWorkspace = (props: Partial<React.ComponentProps<typeof QrGeneratorWorkspace>> = {}) =>
  render(
    <NotificationsProvider>
      <QrGeneratorWorkspace username="admin" onNavigate={vi.fn()} {...props} />
    </NotificationsProvider>
  );

describe("QrGeneratorWorkspace", () => {
  beforeEach(() => vi.clearAllMocks());

  it("has the Carton QR and B-Carton Labels tabs, and asks for the machine first", async () => {
    setupDesktop(baseApi());
    renderWorkspace();

    expect(screen.getByRole("heading", { level: 1, name: "QR Generator" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Carton QR" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "B-Carton Labels" })).toBeInTheDocument();
    expect(await screen.findByRole("radiogroup", { name: "Machine" })).toBeInTheDocument();
    expect(screen.getByText(/Choose the machine first\./)).toBeInTheDocument();
  });

  it("a machine without both contractors cannot be chosen, and says why", async () => {
    setupDesktop(baseApi());
    renderWorkspace();
    const unready = await screen.findByRole("radio", { name: /MACHINE 3/ });
    expect(unready).toBeDisabled();
    expect(unready).toHaveTextContent("Contractors not set");
    expect(screen.getByRole("radio", { name: /MACHINE 1/ })).toHaveTextContent("ASLAM · BABAR");
  });

  it("the B-Carton Labels tab generates nothing until a machine is chosen, then sends it", async () => {
    const api = baseApi();
    setupDesktop(api);
    renderWorkspace({ initialTab: "b-cartons" });

    expect(screen.getByRole("tab", { name: "B-Carton Labels" })).toHaveAttribute("aria-selected", "true");
    await userEvent.click(await screen.findByRole("combobox", { name: "Article and size" }));
    await userEvent.click(await screen.findByRole("option", { name: /EVR9 \/ 7\/10/ }));
    await userEvent.type(screen.getByLabelText("Labels to print"), "3");
    const generate = await screen.findByRole("button", { name: /Generate 3 labels/i });
    expect(generate).toBeDisabled();

    await userEvent.click(screen.getByRole("radio", { name: /MACHINE 1/ }));
    expect(screen.getByRole("radio", { name: /MACHINE 1/ })).toHaveAttribute("aria-checked", "true");
    expect(generate).toBeEnabled();
    await userEvent.click(generate);
    await waitFor(() => expect(api.generateQrBatch).toHaveBeenCalledWith(expect.objectContaining({ machineId: "m-1", grade: "B" })));
  });

  it("keeps the chosen machine when the tab changes, and switching generates nothing", async () => {
    const api = baseApi();
    setupDesktop(api);
    renderWorkspace();
    await userEvent.click(await screen.findByRole("radio", { name: /MACHINE 1/ }));
    await userEvent.click(screen.getByRole("tab", { name: "B-Carton Labels" }));
    await userEvent.click(screen.getByRole("tab", { name: "Carton QR" }));
    expect(screen.getByRole("radio", { name: /MACHINE 1/ })).toHaveAttribute("aria-checked", "true");
    expect(api.generateQrBatch).not.toHaveBeenCalled();
  });

  it("with no machines set up, offers the way to the Machine Program", async () => {
    setupDesktop(baseApi({ listMachines: vi.fn().mockResolvedValue([]) }));
    const setUp = vi.fn();
    renderWorkspace({ onSetUpMachines: setUp });
    expect(await screen.findByText("No machines set up")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Set up machines" }));
    expect(setUp).toHaveBeenCalledTimes(1);
  });
});
