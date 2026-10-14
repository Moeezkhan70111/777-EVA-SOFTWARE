import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QrGeneratorWorkspace } from "../qrGenerator/QrGeneratorWorkspace";
import { NotificationsProvider } from "../../state/NotificationsContext";
import type { MachineRecord, ManualProductionEntry, ManualProductionPage } from "../../types/desktopApi";

// MANUAL PRODUCTION — a QR Generator tab: choose the machine, article, size and colour, type the
// dozens, Save. The main process decides and writes everything; the screen shows its answers.

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

const machine: MachineRecord = {
  id: "m-1", machineCode: "M-001", name: "MACHINE 1", sectionId: "ws-1", sectionName: "PACKING", sortOrder: 1, status: "ACTIVE",
  contractorPartyId: "p-aslam", contractorName: "ASLAM", packingContractorPartyId: "p-babar", packingContractorName: "BABAR",
};

const product = (article: string, size: string, colors: string[]) => ({
  id: `as-${article}-${size}`, articleSizeId: `as-${article}-${size}`, article, color: "", size, colors, description: null,
  costPrice: 300, sellingPrice: 550, mainGroupId: null, groupId: null, articleSeriesId: null, status: "ACTIVE",
  createdAt: "2024-01-01", updatedAt: "2024-01-01",
});

const entry = (overrides: Partial<ManualProductionEntry> = {}): ManualProductionEntry => ({
  id: "e-1", code: "MAN-000001", article: "SK6", size: "7/10", color: "RED", cartons: 20, equivalentDozens: 10,
  programCode: "MP-000123", machineName: "MACHINE 1", enteredAt: "2026-10-14T05:42:00.000Z", enteredBy: "admin", ...overrides,
});

const day = (rows: ManualProductionEntry[]): ManualProductionPage => ({
  date: "2026-10-14", rows, page: 1, pageSize: 25, totalEntries: rows.length,
  totalCartons: rows.reduce((total, row) => total + row.cartons, 0),
  equivalentDozens: rows.reduce((total, row) => total + row.equivalentDozens, 0),
  summary: rows.length ? [{ article: "SK6", size: "7/10", color: "RED", grade: null, cartons: 20, equivalentDozens: 10 }] : [],
});

function baseApi(overrides: Record<string, unknown> = {}) {
  return {
    listMachines: vi.fn().mockResolvedValue([machine]),
    listProducts: vi.fn().mockResolvedValue({
      rows: [product("SK6", "7/10", ["RED", "BLACK"]), product("SK6", "4/6", ["BLUE"]), product("EVR9", "7/10", [])],
      total: 3, page: 1, pageSize: 1000,
    }),
    listQrColors: vi.fn().mockResolvedValue([]),
    listQrBatches: vi.fn().mockResolvedValue([]),
    listProductionReceipts: vi.fn().mockResolvedValue({ accepted: true, page: null }),
    listManualProduction: vi.fn().mockResolvedValue({ accepted: true, page: day([]) }),
    recordManualProduction: vi.fn().mockResolvedValue({ accepted: true, entry: entry(), duplicate: false }),
    ...overrides,
  };
}

const openTab = async (api: Record<string, unknown>) => {
  setupDesktop(api);
  render(
    <NotificationsProvider>
      <QrGeneratorWorkspace username="admin" onNavigate={vi.fn()} canReceiveProduction initialTab="manual" />
    </NotificationsProvider>
  );
  expect(await screen.findByRole("heading", { name: "Manual Production" })).toBeInTheDocument();
};

const pick = async (field: string, option: string) => {
  await userEvent.click(screen.getByRole("combobox", { name: field }));
  await userEvent.click(await screen.findByRole("option", { name: option }));
};

/** Machine 1, SK6 7/10 RED, and the dozens typed. */
const fillForm = async (dozens: string) => {
  await userEvent.click(await screen.findByRole("radio", { name: /MACHINE 1/ }));
  await pick("Article", "SK6");
  await pick("Size", "7/10");
  await pick("Colour", "RED");
  await userEvent.type(screen.getByLabelText("Quantity (dozens)"), dozens);
};

describe("ManualProductionTab", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sits after Receive Production, and only for users who may record production", () => {
    setupDesktop(baseApi());
    const { unmount } = render(
      <NotificationsProvider>
        <QrGeneratorWorkspace username="admin" onNavigate={vi.fn()} canReceiveProduction />
      </NotificationsProvider>
    );
    const names = screen.getAllByRole("tab").map((tab) => tab.textContent);
    expect(names.indexOf("Manual Production")).toBe(names.indexOf("Receive Production") + 1);
    unmount();
    render(
      <NotificationsProvider>
        <QrGeneratorWorkspace username="admin" onNavigate={vi.fn()} />
      </NotificationsProvider>
    );
    expect(screen.queryByRole("tab", { name: "Manual Production" })).not.toBeInTheDocument();
  });

  it("asks for the machine, offers only the article's sizes and the size's colours, and shows the cartons", async () => {
    await openTab(baseApi());
    expect(screen.getByText("Choose the machine above first.")).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Machine" })).toBeInTheDocument();
    const save = screen.getByRole("button", { name: "Save production" });
    expect(save).toBeDisabled();

    await userEvent.click(screen.getByRole("radio", { name: /MACHINE 1/ }));
    expect(screen.getByText("On MACHINE 1's program for today.")).toBeInTheDocument();
    await pick("Article", "SK6");
    await userEvent.click(screen.getByRole("combobox", { name: "Size" }));
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["4/6", "7/10"]);
    await userEvent.click(screen.getByRole("option", { name: "7/10" }));
    await userEvent.click(screen.getByRole("combobox", { name: "Colour" }));
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["BLACK", "RED"]);
    await userEvent.click(screen.getByRole("option", { name: "RED" }));

    const dozens = screen.getByLabelText("Quantity (dozens)");
    await userEvent.type(dozens, "1.25");
    expect(screen.getByText(/⚠ Enter whole or half dozens/)).toBeInTheDocument();
    expect(dozens).toHaveAttribute("aria-invalid", "true");
    expect(save).toBeDisabled();
    await userEvent.clear(dozens);
    await userEvent.type(dozens, "10");
    expect(screen.getByText("= 20 cartons into store stock")).toBeInTheDocument();
    expect(save).toBeEnabled();
  });

  it("Save sends the choice once, says what was saved, clears the quantity and re-reads the day", async () => {
    const api = baseApi();
    await openTab(api);
    await fillForm("10");
    const reads = api.listManualProduction.mock.calls.length;
    await userEvent.click(screen.getByRole("button", { name: "Save production" }));

    expect(api.recordManualProduction).toHaveBeenCalledTimes(1);
    expect(api.recordManualProduction).toHaveBeenCalledWith(
      expect.objectContaining({ machineId: "m-1", articleSizeId: "as-SK6-7/10", color: "RED", dozens: "10", requestId: expect.any(String) })
    );
    const saved = await screen.findByText("MAN-000001: 20 cartons of SK6 7/10 RED added to stock.", { exact: false });
    expect(saved.closest("[role='status']")).toHaveTextContent("✓ Saved MAN-000001: 20 cartons of SK6 7/10 RED added to stock.");
    expect(screen.getByLabelText("Quantity (dozens)")).toHaveValue("");
    await waitFor(() => expect(api.listManualProduction.mock.calls.length).toBeGreaterThan(reads));
  });

  it("a refusal is shown in the main process's words; a lost answer keeps the same request for the retry", async () => {
    const recordManualProduction = vi
      .fn()
      .mockRejectedValueOnce(new Error("ipc gone"))
      .mockResolvedValueOnce({ accepted: false, entry: null, reason: "MACHINE 1 has no active packing contractor." })
      .mockResolvedValue({ accepted: true, entry: entry(), duplicate: true });
    await openTab(baseApi({ recordManualProduction }));
    await fillForm("10");
    const save = screen.getByRole("button", { name: "Save production" });

    await userEvent.click(save);
    expect(await screen.findByRole("alert")).toHaveTextContent("⚠ Not saved The production could not be saved — the connection failed.");
    await userEvent.click(save);
    expect(await screen.findByRole("alert")).toHaveTextContent("MACHINE 1 has no active packing contractor.");
    await userEvent.click(save);
    expect(await screen.findByText(/MAN-000001 was already saved — nothing was added twice/)).toBeInTheDocument();

    const ids = recordManualProduction.mock.calls.map(([input]) => (input as { requestId: string }).requestId);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[1]);
  });

  it("lists today's entries in Details and adds them up in Summary", async () => {
    await openTab(baseApi({ listManualProduction: vi.fn().mockResolvedValue({ accepted: true, page: day([entry()]) }) }));
    const details = await screen.findByRole("table", { name: "Manual production today" });
    const [, row] = within(details).getAllByRole("row");
    expect(row).toHaveTextContent("MAN-000001");
    expect(row).toHaveTextContent("10 DZN");
    expect(row).toHaveTextContent("MACHINE 1 · MP-000123");
    expect(screen.getByText("20 cartons")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: "Summary" }));
    const summary = screen.getByRole("table", { name: "Manual production by article, size and colour" });
    expect(within(summary).getAllByRole("row").at(-1)).toHaveTextContent("Total2010 DZN");
  });

  it("shows loading, the empty day, and a failed load with a retry that works", async () => {
    let answer: (value: unknown) => void = () => undefined;
    const listManualProduction = vi
      .fn()
      .mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
      .mockResolvedValueOnce({ accepted: true, page: day([]) });
    await openTab(baseApi({ listManualProduction }));
    expect(screen.getByText("Loading today's manual production…")).toBeInTheDocument();
    answer({ accepted: false, page: null, reason: "Today's manual production could not be loaded." });
    expect(await screen.findByText("Today's manual production could not be loaded.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("No manual production yet today")).toBeInTheDocument();
  });

  it("says so when there are no active products to record", async () => {
    await openTab(baseApi({ listProducts: vi.fn().mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: 1000 }) }));
    expect(await screen.findByText("No active products")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save production" })).not.toBeInTheDocument();
  });
});
