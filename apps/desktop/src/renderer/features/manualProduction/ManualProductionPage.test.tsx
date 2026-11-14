import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QrGeneratorWorkspace } from "../qrGenerator/QrGeneratorWorkspace";
import { NotificationsProvider } from "../../state/NotificationsContext";
import { NotificationCenter } from "../../components/layout/NotificationCenter";
import { copy } from "../../config/copy";
import type { MachineRecord, ManualProductionEntry, ManualProductionPage as DayPage } from "../../types/desktopApi";
import { toIsoDate } from "../../utils/dates";
import { buildProductionDay } from "@erp/domain";
import { ManualProductionPage } from "./ManualProductionPage";

// MANUAL PRODUCTION, A PAGE OF ITS OWN (docs/48): choose the machine and the article, type every size and colour at
// once, Add to list, the next article or machine, then Save every line together; then Complete today's production.
// The main process decides and writes everything; the page shows its answers.

const text = copy.manualProductionPage;
const dayText = copy.productionDay;

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

const machineRecord = (id: string, name: string): MachineRecord => ({
  id, machineCode: id.toUpperCase(), name, sectionId: "ws-1", sectionName: "PACKING", sortOrder: 1, status: "ACTIVE",
  contractorPartyId: "p-aslam", contractorName: "ASLAM", packingContractorPartyId: "p-babar", packingContractorName: "BABAR",
});

const product = (article: string, size: string, colors: string[]) => ({
  id: `as-${article}-${size}`, articleSizeId: `as-${article}-${size}`, article, color: "", size, colors, description: null,
  costPrice: 300, sellingPrice: 550, mainGroupId: null, groupId: null, articleSeriesId: null, status: "ACTIVE",
  createdAt: "2024-01-01", updatedAt: "2024-01-01",
});

const entry = (overrides: Partial<ManualProductionEntry> = {}): ManualProductionEntry => ({
  id: "e-1", code: "MAN-000001", article: "SK6", size: "7/10", color: "RED", cartons: 20, equivalentDozens: 10,
  programCode: "MP-000123", machineName: "MACHINE 1", enteredAt: "2026-10-14T05:42:00.000Z", enteredBy: "admin",
  voidedAt: null, voidedBy: null, voidReason: null, ...overrides,
});

const day = (rows: ManualProductionEntry[]): DayPage => ({
  date: "2026-10-14", rows, page: 1, pageSize: 25, totalEntries: rows.length,
  totalCartons: rows.reduce((total, row) => total + (row.voidedAt ? 0 : row.cartons), 0),
  equivalentDozens: rows.reduce((total, row) => total + row.equivalentDozens, 0),
  summary: rows.length ? [{ article: "SK6", size: "7/10", color: "RED", grade: null, cartons: 20, equivalentDozens: 10 }] : [],
});

/** Today as the Production section reads it (productionDayView): MACHINE 1, SK6 7/10 RED. */
const productionDay = (cartons: number) =>
  buildProductionDay(toIsoDate(), cartons > 0 ? [{ machineName: "MACHINE 1", article: "SK6", size: "7/10", color: "RED", cartons, entries: 1 }] : [], null);

const TODAY_SK6 = {
  accepted: true,
  article: { date: toIsoDate(), machineId: "m-1", machineName: "MACHINE 1", article: "SK6", cells: [{ articleSizeId: "as-SK6-7/10", size: "7/10", color: "RED", cartons: 20 }] },
};

const MARK = { date: toIsoDate(), completedAt: "2026-11-14T13:05:00.000Z", completedBy: "aslam", cartons: 20, entries: 1 };

function baseApi(overrides: Record<string, unknown> = {}) {
  return {
    listMachines: vi.fn().mockResolvedValue([machineRecord("m-1", "MACHINE 1"), machineRecord("m-2", "MACHINE 2")]),
    listProducts: vi.fn().mockResolvedValue({
      rows: [product("SK6", "7/10", ["RED", "BLACK"]), product("SK6", "4/6", ["RED"]), product("EVR9", "7/10", ["BLUE"])],
      total: 3, page: 1, pageSize: 1000,
    }),
    listManualProduction: vi.fn().mockResolvedValue({ accepted: true, page: day([]) }),
    getProductionDayMark: vi.fn().mockResolvedValue({ accepted: true, mark: null }),
    getProductionDay: vi.fn().mockResolvedValue({ accepted: true, day: productionDay(0) }),
    saveManualProduction: vi.fn().mockResolvedValue({ accepted: true, entries: 4, cartons: 27, duplicates: 0 }),
    completeProductionDay: vi.fn().mockResolvedValue({ accepted: true, mark: MARK, duplicate: false }),
    ...overrides,
  };
}

// The notice centre too, so what the page tells the operator can be read.
const show = () => render(<NotificationsProvider><ManualProductionPage /><NotificationCenter /></NotificationsProvider>);

const openPage = async (api: Record<string, unknown>) => {
  setupDesktop(api);
  const view = show();
  expect(await screen.findByRole("combobox", { name: text.articleLabel })).toBeInTheDocument();
  return view;
};

const chooseMachine = async (name: string) => userEvent.click(await screen.findByRole("radio", { name: new RegExp(name) }));
const chooseArticle = async (article: string) => {
  await userEvent.click(screen.getByRole("combobox", { name: text.articleLabel }));
  await userEvent.click(await screen.findByRole("option", { name: new RegExp(`^${article}`) }));
};
const box = (color: string, size: string) => screen.getByRole("textbox", { name: text.quantityFor(color, size) });
const listRegion = () => screen.getByRole("region", { name: text.listTitle });
const openEntries = async () => {
  await userEvent.click(screen.getByRole("tab", { name: copy.productionEdit.sectionEntries }));
  return screen.findByRole("table", { name: "Manual production today" });
};
const openEdit = async () => {
  await userEvent.click(await screen.findByRole("button", { name: copy.productionEdit.editLabel("SK6", "MACHINE 1") }));
  const dialog = await screen.findByRole("dialog", { name: copy.productionEdit.title("SK6", "MACHINE 1") });
  const red = await within(dialog).findByRole("textbox", { name: copy.productionEdit.boxLabel("7/10", "RED") });
  return { dialog, red };
};
const reviewAndSave = async (dialog: HTMLElement) => {
  await userEvent.click(within(dialog).getByRole("button", { name: copy.productionEdit.review }));
  const confirm = await screen.findByRole("dialog", { name: copy.productionEdit.confirmTitle("SK6", "MACHINE 1") });
  await userEvent.click(within(confirm).getByRole("button", { name: copy.productionEdit.save }));
  return confirm;
};

const saveAndConfirm = async () => {
  await userEvent.click(within(listRegion()).getByRole("button", { name: text.save }));
  const dialog = await screen.findByRole("dialog", { name: text.saveTitle });
  await userEvent.click(within(dialog).getByRole("button", { name: text.save }));
  return dialog;
};

describe("Manual Production page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it("is no longer a QR Generator tab", () => {
    setupDesktop(baseApi());
    render(
      <NotificationsProvider>
        <QrGeneratorWorkspace username="admin" onNavigate={vi.fn()} canReceiveProduction />
      </NotificationsProvider>
    );
    expect(screen.queryByRole("tab", { name: "Manual Production" })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Receive Production" })).toBeInTheDocument();
  });

  it("an article shows every size down and colour across at once; a size not made in a colour takes no quantity", async () => {
    await openPage(baseApi());
    await chooseArticle("SK6");
    const grid = screen.getByRole("region", { name: text.gridLabel("SK6") });
    expect(within(grid).getAllByRole("rowheader").map((cell) => cell.textContent)).toEqual(["7/10", "4/6"]);
    expect(within(grid).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual([text.sizeColumn, "BLACK", "RED"]);
    expect(screen.queryByRole("textbox", { name: text.quantityFor("BLACK", "4/6") })).toBeNull();
    expect(within(grid).getByText(text.colourNotOnSize)).toBeInTheDocument();
    expect(screen.getByText(`⚠ ${text.chooseMachineFirst}`)).toBeInTheDocument();
    await userEvent.type(box("RED", "7/10"), "1.25");
    expect(screen.getByRole("alert")).toHaveTextContent(/whole or half dozens/);
    expect(screen.getByRole("button", { name: text.addToList })).toBeDisabled();
  });

  it("two machines, two articles, one Save: every line goes in one call, each with its own request id", async () => {
    const api = baseApi();
    await openPage(api);
    await chooseMachine("MACHINE 1");
    await chooseArticle("SK6");
    await userEvent.type(box("RED", "7/10"), "10{ArrowDown}2");
    expect(box("RED", "4/6")).toHaveValue("2");
    await userEvent.type(box("BLACK", "7/10"), "0.5{Enter}");
    expect(box("RED", "7/10")).toHaveValue("");

    await chooseMachine("MACHINE 2");
    await chooseArticle("EVR9");
    await userEvent.type(box("BLUE", "7/10"), "1");
    await userEvent.click(screen.getByRole("button", { name: text.addToList }));

    const list = listRegion();
    expect(within(list).getByRole("heading", { name: text.listMachine("MACHINE 1", "12.5") })).toBeInTheDocument();
    expect(within(list).getByRole("heading", { name: text.listMachine("MACHINE 2", "1") })).toBeInTheDocument();
    expect(within(list).getByText(text.listTotals(4, "13.5", 27))).toBeInTheDocument();

    await saveAndConfirm();
    await waitFor(() => expect(api.saveManualProduction).toHaveBeenCalledTimes(1));
    const sent = api.saveManualProduction.mock.calls[0]?.[0] as { lines: Array<Record<string, string>> };
    expect(sent.lines.map((line) => `${line.machineId} ${line.articleSizeId} ${line.color} ${line.dozens}`)).toEqual([
      "m-1 as-SK6-7/10 BLACK 0.5", "m-1 as-SK6-7/10 RED 10", "m-1 as-SK6-4/6 RED 2", "m-2 as-EVR9-7/10 BLUE 1",
    ]);
    expect(new Set(sent.lines.map((line) => line.requestId)).size).toBe(4);
    expect(await screen.findByText(text.saved(4, "13.5"), { exact: false })).toBeInTheDocument();
    expect(within(list).getByText(text.listEmptyTitle)).toBeInTheDocument();
  });

  it("the same machine, size and colour added again replaces its line; a line can be removed", async () => {
    await openPage(baseApi());
    await chooseMachine("MACHINE 1");
    await chooseArticle("SK6");
    await userEvent.type(box("RED", "7/10"), "10{Enter}");
    await userEvent.type(box("RED", "7/10"), "4{Enter}");
    expect(within(listRegion()).getByText(text.listTotals(1, "4", 8))).toBeInTheDocument();
    expect(box("RED", "7/10").closest("td")).toHaveTextContent(text.inList("4"));
    await userEvent.click(within(listRegion()).getByRole("button", { name: text.removeLabel("MACHINE 1 SK6 7/10 RED") }));
    expect(within(listRegion()).getByText(text.listEmptyTitle)).toBeInTheDocument();
  });

  it("a refused Save keeps the list and its ids, in the main process's words; a lost answer is said plainly", async () => {
    const saveManualProduction = vi.fn()
      .mockResolvedValueOnce({ accepted: false, reason: "Line 1: SK6 7/10 RED is disabled in Product Master." })
      .mockRejectedValueOnce(new Error("ipc gone"));
    await openPage(baseApi({ saveManualProduction }));
    await chooseMachine("MACHINE 1");
    await chooseArticle("SK6");
    await userEvent.type(box("RED", "7/10"), "10{Enter}");

    const first = await saveAndConfirm();
    expect(await within(first).findByRole("alert")).toHaveTextContent(/disabled in Product Master/);
    await userEvent.click(within(first).getByRole("button", { name: text.save }));
    expect(await within(first).findByRole("alert")).toHaveTextContent(/connection failed/);

    const ids = saveManualProduction.mock.calls.map(([input]) => (input as { lines: Array<{ requestId: string }> }).lines[0]?.requestId);
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(ids[0]);
    expect(within(listRegion()).getByText(text.listTotals(1, "10", 20))).toBeInTheDocument();
  });

  it("the list is kept on this computer for today; a list from another day is not offered", async () => {
    const view = await openPage(baseApi());
    await chooseMachine("MACHINE 1");
    await chooseArticle("SK6");
    await userEvent.type(box("RED", "7/10"), "3{Enter}");
    expect(JSON.parse(window.localStorage.getItem("erp.manual-production.list") ?? "{}")).toMatchObject({ day: toIsoDate(), lines: [{ color: "RED", cartons: 6 }] });
    view.unmount();

    show();
    expect(await screen.findByText(text.listTotals(1, "3", 6))).toBeInTheDocument();
    window.localStorage.setItem("erp.manual-production.list", JSON.stringify({ day: "2020-01-01", lines: JSON.parse(window.localStorage.getItem("erp.manual-production.list") ?? "{}").lines }));
    document.body.innerHTML = "";
    show();
    expect(await screen.findByText(text.listEmptyTitle)).toBeInTheDocument();
  });

  it("Complete today's production waits for saved production and an empty list, asks first, then shows Production added", async () => {
    const api = baseApi({ listManualProduction: vi.fn().mockResolvedValue({ accepted: true, page: day([entry()]) }) });
    await openPage(api);
    expect(await screen.findByText(dayText.notAdded)).toBeInTheDocument();
    const complete = screen.getByRole("button", { name: `✓ ${text.completeButton}` });
    await waitFor(() => expect(complete).toBeEnabled());

    await chooseMachine("MACHINE 1");
    await chooseArticle("SK6");
    await userEvent.type(box("RED", "7/10"), "1{Enter}");
    expect(complete).toBeDisabled();
    expect(screen.getByText(text.completeUnsaved(1))).toBeInTheDocument();
    await userEvent.click(within(listRegion()).getByRole("button", { name: text.clearList }));

    api.getProductionDayMark.mockResolvedValue({ accepted: true, mark: MARK });
    await userEvent.click(complete);
    const dialog = await screen.findByRole("dialog", { name: text.completeTitle });
    await userEvent.click(within(dialog).getByRole("button", { name: text.completeButton }));
    expect(api.completeProductionDay).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(dayText.added)).toBeInTheDocument();
    expect(screen.getByText(dayText.addedBy("6:05 PM", "aslam"))).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: `✓ ${text.completeButton}` })).not.toBeInTheDocument();
  });

  it("a day with nothing saved cannot be completed, and says why", async () => {
    await openPage(baseApi());
    const complete = await screen.findByRole("button", { name: `✓ ${text.completeButton}` });
    expect(complete).toBeDisabled();
    expect(screen.getByText(text.completeNothing)).toBeInTheDocument();
  });

  it("shows today's production as a matrix per machine and article, and every entry under Entries", async () => {
    await openPage(baseApi({
      listManualProduction: vi.fn().mockResolvedValue({ accepted: true, page: day([entry()]) }),
      getProductionDay: vi.fn().mockResolvedValue({ accepted: true, day: productionDay(20) }),
    }));
    // Production first: MACHINE 1, SK6 as sizes down and colours across, in dozens.
    expect(await screen.findByRole("heading", { name: copy.productionReport.machineHeading("MACHINE 1", "10") })).toBeInTheDocument();
    const matrix = screen.getByRole("region", { name: dayText.tableLabel("SK6") });
    expect(within(matrix).getAllByRole("row")[1]).toHaveTextContent("7/10");
    expect(screen.getByRole("button", { name: copy.productionEdit.editLabel("SK6", "MACHINE 1") })).toBeInTheDocument();
    // Entries: every entry, as before.
    const details = await openEntries();
    const [, row] = within(details).getAllByRole("row");
    expect(row).toHaveTextContent("MAN-000001");
    expect(row).toHaveTextContent("MACHINE 1 · MP-000123");
  });

  it("edits an article in its grid: 10 dozen changed to 6 is sent as one change, and the day is read again", async () => {
    const getProductionDay = vi.fn().mockResolvedValue({ accepted: true, day: productionDay(20) });
    const getManualProductionArticle = vi.fn().mockResolvedValue(TODAY_SK6);
    const editManualProduction = vi.fn().mockResolvedValue({ accepted: true, changes: [{ size: "7/10", color: "RED", fromCartons: 20, toCartons: 12, voided: ["MAN-000001"], recorded: "MAN-000002" }] });
    await openPage(baseApi({ getProductionDay, getManualProductionArticle, editManualProduction }));
    const { dialog, red } = await openEdit();
    expect(getManualProductionArticle).toHaveBeenCalledWith({ machineName: "MACHINE 1", article: "SK6" });
    expect(red).toHaveValue("10");
    await userEvent.clear(red);
    await userEvent.type(red, "6");
    expect(within(dialog).getByText(copy.productionEdit.change("7/10", "RED", "10", "6"))).toBeInTheDocument();
    const readsBefore = getProductionDay.mock.calls.length;
    await reviewAndSave(dialog);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(editManualProduction).toHaveBeenCalledWith({
      requestId: expect.any(String), machineId: "m-1", article: "SK6", cells: [{ articleSizeId: "as-SK6-7/10", color: "RED", dozens: "6" }],
    });
    expect(await screen.findByText(copy.productionEdit.savedBody(1))).toBeInTheDocument();
    await waitFor(() => expect(getProductionDay.mock.calls.length).toBeGreaterThan(readsBefore));
  });

  it("a refused edit says why, in the main process's words, and stays open", async () => {
    const reason = "SK6 7/10 RED: These cartons have already gone out on gatepass GP-000004. Cancel that gatepass first.";
    await openPage(baseApi({
      getProductionDay: vi.fn().mockResolvedValue({ accepted: true, day: productionDay(20) }),
      getManualProductionArticle: vi.fn().mockResolvedValue(TODAY_SK6),
      editManualProduction: vi.fn().mockResolvedValue({ accepted: false, reason }),
    }));
    const { dialog, red } = await openEdit();
    await userEvent.clear(red);
    const confirm = await reviewAndSave(dialog);
    expect(await within(confirm).findByRole("alert")).toHaveTextContent(reason);
  });

  it("downloads today's production as a PDF, for one machine or the whole day", async () => {
    const savePdfDocument = vi.fn().mockResolvedValue({ accepted: true, filePath: "C:/Reports/Daily Production.pdf" });
    await openPage(baseApi({ getProductionDay: vi.fn().mockResolvedValue({ accepted: true, day: productionDay(20) }), savePdfDocument }));
    await userEvent.click(await screen.findByRole("button", { name: copy.productionReport.downloadMachine("MACHINE 1") }));
    await waitFor(() => expect(savePdfDocument).toHaveBeenCalledTimes(1));
    const [first] = savePdfDocument.mock.calls[0] as [{ html: string; fileName: string }];
    expect(first.fileName).toBe("Daily Production " + toIsoDate() + " MACHINE 1.pdf");
    expect(first.html).toContain(copy.productionReport.title);
    expect(first.html).toContain("SK6");
    expect(await screen.findByText(copy.productionReport.savedTitle)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: copy.productionReport.downloadDay }));
    await waitFor(() => expect(savePdfDocument).toHaveBeenCalledTimes(2));
    expect((savePdfDocument.mock.calls[1] as [{ fileName: string }])[0].fileName).toBe("Daily Production " + toIsoDate() + ".pdf");
  });

  it("under a box, what is already saved today for that size and colour", async () => {
    await openPage(baseApi({ listManualProduction: vi.fn().mockResolvedValue({ accepted: true, page: day([entry()]) }) }));
    await openEntries();
    await chooseArticle("SK6");
    expect(box("RED", "7/10").closest("td")).toHaveTextContent(text.savedToday("10"));
  });

  it("voids an entry only with a reason, and then shows it as voided in words", async () => {
    const voided = entry({ voidedAt: "2026-10-14T06:00:00.000Z", voidedBy: "admin", voidReason: "typed twice" });
    const listManualProduction = vi.fn().mockResolvedValue({ accepted: true, page: day([entry()]) });
    const voidManualProduction = vi.fn().mockImplementation(async () => {
      listManualProduction.mockResolvedValue({ accepted: true, page: day([voided]) });
      return { accepted: true, entry: voided };
    });
    await openPage(baseApi({ listManualProduction, voidManualProduction }));
    await openEntries();
    await userEvent.click(await screen.findByRole("button", { name: "Void MAN-000001" }));
    const dialog = await screen.findByRole("dialog", { name: "Void MAN-000001?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Void entry" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Give a reason for voiding this entry.");
    await userEvent.type(within(dialog).getByLabelText("Reason (required)"), "typed twice");
    await userEvent.click(within(dialog).getByRole("button", { name: "Void entry" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(voidManualProduction).toHaveBeenLastCalledWith({ entryId: "e-1", reason: "typed twice" });
    expect(await screen.findByText("Voided")).toBeInTheDocument();
  });

  it("says so when there are no active products to record", async () => {
    setupDesktop(baseApi({ listProducts: vi.fn().mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: 1000 }) }));
    show();
    expect(await screen.findByText(copy.manualProduction.noProductsTitle)).toBeInTheDocument();
  });
});
