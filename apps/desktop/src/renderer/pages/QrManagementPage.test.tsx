import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { QrManagementPage } from "./QrManagementPage";
import { NotificationsProvider } from "../state/NotificationsContext";
import type { QrBatchMemberRow, QrDetail, QrGenerationGroup, QrGenerationOverview, QrSearchRow } from "../types/desktopApi";

function setupDesktop(api: Record<string, unknown>) {
  Object.defineProperty(window, "desktop", {
    value: { versions: { node: "22", chrome: "128", electron: "43" }, api },
    configurable: true,
  });
}

const localYmd = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const group = (overrides: Partial<QrGenerationGroup>): QrGenerationGroup => ({
  batchId: "batch-1",
  article: "SK6",
  color: "RED",
  size: "7/10",
  startSequence: 1,
  endSequence: 50,
  quantity: 50,
  firstQrId: "SK6_RED_7/10_000001",
  lastQrId: "SK6_RED_7/10_000050",
  generatedAt: "2026-09-15T05:32:00.000Z",
  generatedBy: "admin",
  requestedBy: "Aslam (Production)",
  stageCounts: { REGISTERED: 42, PRODUCED: 8 },
  ...overrides,
});

const overview = (overrides: Partial<QrGenerationOverview> = {}): QrGenerationOverview => ({
  groups: [
    group({}),
    group({
      batchId: "batch-2",
      color: "BLUE",
      startSequence: 1,
      endSequence: 20,
      quantity: 20,
      firstQrId: "SK6_BLUE_7/10_000001",
      lastQrId: "SK6_BLUE_7/10_000020",
      generatedAt: "2026-09-15T06:05:00.000Z",
      requestedBy: null,
      stageCounts: { REGISTERED: 20 },
    }),
  ],
  total: 2,
  page: 1,
  pageSize: 25,
  totalQrCount: 70,
  stageCounts: { REGISTERED: 62, PRODUCED: 8 },
  ...overrides,
});

const member = (sequence: number, stage: QrBatchMemberRow["stage"]): QrBatchMemberRow => ({
  qrId: `SK6_RED_7/10_${String(sequence).padStart(6, "0")}`,
  sequence,
  stage,
  lastActivityAt: "2026-09-15T05:32:00.000Z",
});

const searchRow = (overrides: Partial<QrSearchRow>): QrSearchRow => ({
  qrId: "SK6_RED_7/10_000001",
  article: "SK6",
  color: "RED",
  size: "7/10",
  sequence: 1,
  batchId: "batch-1",
  registeredAt: "2026-09-15T05:32:00.000Z",
  stage: "PRODUCED",
  lastActivityAt: "2026-09-16T03:14:00.000Z",
  ...overrides,
});

const detail = (overrides: Partial<QrDetail>): QrDetail => ({
  qrId: "SK6_RED_7/10_000037",
  article: "SK6",
  color: "RED",
  size: "7/10",
  serial: "000037",
  stage: "DISPATCHED",
  productVariantId: "pv-1",
  sellingPrice: 550,
  stockOnHand: 12,
  registry: {
    status: "GENERATED",
    registeredAt: "2026-09-15T05:32:00.000Z",
    voidReason: null,
    voidedAt: null,
    voidedBy: null,
  },
  batch: {
    id: "batch-1",
    startSequence: 1,
    endSequence: 50,
    quantity: 50,
    createdAt: "2026-09-15T05:32:00.000Z",
    createdBy: "admin",
    requestedBy: "Aslam (Production)",
    producedCount: 12,
    voidCount: 0,
  },
  lifecycle: {
    currentStatus: "DISPATCHED",
    locationType: "FACTORY",
    locationId: null,
    firstScannedAt: "2026-09-16T03:14:00.000Z",
    updatedAt: "2026-09-18T05:02:00.000Z",
  },
  events: [
    {
      id: "ev-1",
      eventType: "PRODUCED",
      occurredAt: "2026-09-16T03:14:00.000Z",
      factory: "Factory 777",
      workstation: "Line 1",
      operator: "Aslam",
      deviceId: "device-1",
      note: null,
      syncStatus: "SYNCED",
    },
    {
      id: "ev-2",
      eventType: "DISPATCHED",
      occurredAt: "2026-09-18T05:02:00.000Z",
      factory: "Factory 777",
      workstation: "Gate",
      operator: null,
      deviceId: "device-2",
      note: null,
      syncStatus: "PENDING",
    },
  ],
  ...overrides,
});

function baseApi(overrides: Record<string, unknown> = {}) {
  return {
    getQrGenerationOverview: vi.fn().mockResolvedValue(overview()),
    listQrGenerationFilterOptions: vi.fn().mockResolvedValue({ articles: ["SK12", "SK6"], colors: ["BLUE", "RED"], sizes: ["4/6", "7/10"] }),
    listQrBatchMembers: vi.fn().mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: 100 }),
    searchQrCodes: vi.fn().mockResolvedValue([]),
    getQrDetail: vi.fn().mockResolvedValue(null),
    voidQrCode: vi.fn().mockResolvedValue({ accepted: true }),
    restoreQrCode: vi.fn().mockResolvedValue({ accepted: true }),
    markQrCodeDamaged: vi.fn().mockResolvedValue({ accepted: true, eventId: "ev-9" }),
    ...overrides,
  };
}

const renderPage = () =>
  render(
    <NotificationsProvider>
      <QrManagementPage username="Moeezkhan123" />
    </NotificationsProvider>,
  );

const lastOverviewCall = (api: ReturnType<typeof baseApi>) => {
  const calls = (api.getQrGenerationOverview as ReturnType<typeof vi.fn>).mock.calls;
  return calls[calls.length - 1][0] as Record<string, unknown>;
};

describe("QR Management — management mode", () => {
  it("loads today's generation runs (local calendar day, generation time) with tallies on first paint", async () => {
    const api = baseApi();
    setupDesktop(api);
    renderPage();

    await waitFor(() => expect(api.getQrGenerationOverview).toHaveBeenCalled());
    const today = localYmd();
    expect(lastOverviewCall(api)).toMatchObject({ fromDate: today, toDate: today, page: 1, pageSize: 25, includeSummary: true });
    expect(lastOverviewCall(api).article).toBeUndefined();

    // Grouped rows: one per generation run, with range, quantity and a status summary.
    const rows = await screen.findAllByRole("row", { expanded: false });
    expect(rows).toHaveLength(2);
    const first = rows[0];
    expect(within(first).getByText("SK6")).toBeInTheDocument();
    expect(within(first).getByText("RED")).toBeInTheDocument();
    expect(within(first).getByText("7/10")).toBeInTheDocument();
    expect(within(first).getByText("000001")).toBeInTheDocument();
    expect(within(first).getByText("000050")).toBeInTheDocument();
    expect(within(first).getByText("50")).toBeInTheDocument();
    expect(within(first).getByText("42")).toBeInTheDocument();
    expect(within(first).getByText("Generated")).toBeInTheDocument();
    expect(within(first).getByText("8")).toBeInTheDocument();
    expect(within(first).getByText("Production")).toBeInTheDocument();
    // Who ran it and who asked for it.
    expect(within(first).getByText(/· admin/)).toBeInTheDocument();
    expect(within(first).getByText("for Aslam (Production)")).toBeInTheDocument();
    expect(within(rows[1]).queryByText(/^for /)).not.toBeInTheDocument();

    // Summary tiles come from the database tallies, only for stages that have codes.
    expect(screen.getByText("62")).toBeInTheDocument();
    expect(screen.getByText("Production / Stock")).toBeInTheDocument();
    expect(screen.queryByText("Dispatched")).not.toBeInTheDocument();
    expect(screen.getByText(/70/)).toHaveTextContent("70");
  });

  it("filters live behind a Filters button; date range sends both bounds and product pickers AND together", async () => {
    const api = baseApi();
    setupDesktop(api);
    renderPage();
    await waitFor(() => expect(api.getQrGenerationOverview).toHaveBeenCalled());

    // The panel is closed until asked for; the button shows how many filters are active (Today).
    expect(screen.queryByRole("dialog", { name: "Filter options" })).not.toBeInTheDocument();
    const filtersButton = screen.getByRole("button", { name: /^filters/i });
    expect(filtersButton).toHaveTextContent("1");
    await userEvent.click(filtersButton);
    const panel = await screen.findByRole("dialog", { name: "Filter options" });

    fireEvent.change(within(panel).getByLabelText("From date"), { target: { value: "2026-09-01" } });
    fireEvent.change(within(panel).getByLabelText("To date"), { target: { value: "2026-09-15" } });
    await waitFor(() => expect(lastOverviewCall(api)).toMatchObject({ fromDate: "2026-09-01", toDate: "2026-09-15" }));

    // Product pickers are the same dropdown-select-only comboboxes as Add/Edit Product:
    // typing filters the list, the value is set only by picking an option.
    const article = within(panel).getByRole("combobox", { name: "Article" });
    await userEvent.type(article, "sk");
    const list = await within(panel).findByRole("listbox");
    expect(within(list).getAllByRole("option").map((o) => o.textContent)).toEqual(["SK12", "SK6"]);
    await userEvent.click(within(list).getByRole("option", { name: "SK6" }));
    expect(article).toHaveValue("SK6");
    await waitFor(() => expect(lastOverviewCall(api)).toMatchObject({ fromDate: "2026-09-01", toDate: "2026-09-15", article: "SK6" }));

    // Keyboard: arrows + Enter pick an option.
    const size = within(panel).getByRole("combobox", { name: "Size" });
    await userEvent.click(size);
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(size).toHaveValue("7/10");
    await userEvent.click(within(panel).getByRole("combobox", { name: "Colour" }));
    await userEvent.click(await within(panel).findByRole("option", { name: "RED" }));
    await waitFor(() =>
      expect(lastOverviewCall(api)).toMatchObject({ fromDate: "2026-09-01", toDate: "2026-09-15", article: "SK6", size: "7/10", color: "RED", page: 1 }),
    );
    expect(screen.getByRole("button", { name: /^filters/i })).toHaveTextContent("4");

    // Moving "From" past "To" pulls "To" along, so one pick selects a single date.
    fireEvent.change(within(panel).getByLabelText("From date"), { target: { value: "2026-09-20" } });
    await waitFor(() => expect(lastOverviewCall(api)).toMatchObject({ fromDate: "2026-09-20", toDate: "2026-09-20", article: "SK6" }));
    expect(within(panel).getByLabelText("To date")).toHaveValue("2026-09-20");
    fireEvent.change(within(panel).getByLabelText("From date"), { target: { value: "2026-09-15" } });
    fireEvent.change(within(panel).getByLabelText("To date"), { target: { value: "2026-09-15" } });
    await waitFor(() => expect(lastOverviewCall(api)).toMatchObject({ fromDate: "2026-09-15", toDate: "2026-09-15", article: "SK6" }));

    // Done closes the panel; active filters stay visible as chips and each can be removed alone.
    await userEvent.click(within(panel).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Filter options" })).not.toBeInTheDocument());
    expect(screen.getByText("Article: SK6")).toBeInTheDocument();
    expect(screen.getByText("Colour: RED")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Remove article filter" }));
    await waitFor(() => {
      const call = lastOverviewCall(api);
      expect(call).toMatchObject({ fromDate: "2026-09-15", toDate: "2026-09-15", color: "RED", size: "7/10" });
      expect(call.article).toBeUndefined();
    });

    // Clear all → everything, all time; Done closes the panel.
    await userEvent.click(screen.getByRole("button", { name: /^filters/i }));
    await userEvent.click(await screen.findByRole("button", { name: "Clear all" }));
    await waitFor(() => {
      const call = lastOverviewCall(api);
      expect(call.fromDate).toBeUndefined();
      expect(call.toDate).toBeUndefined();
      expect(call.color).toBeUndefined();
      expect(call.size).toBeUndefined();
    });
    expect(screen.getByText("All time")).toBeInTheDocument();
  });

  it("expands a run to list each code with its own status, one page at a time, and opens a code from it", async () => {
    const listQrBatchMembers = vi.fn().mockResolvedValue({
      rows: [member(1, "PRODUCED"), member(2, "PRODUCED"), member(3, "REGISTERED"), member(4, "VOID")],
      total: 50,
      page: 1,
      pageSize: 100,
    });
    const getQrDetail = vi.fn().mockResolvedValue(detail({ qrId: "SK6_RED_7/10_000003", serial: "000003", stage: "REGISTERED", lifecycle: null, events: [] }));
    const api = baseApi({ listQrBatchMembers, getQrDetail });
    setupDesktop(api);
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: /view codes SK6_RED_7\/10_000001 to SK6_RED_7\/10_000050/i }));
    await waitFor(() => expect(listQrBatchMembers).toHaveBeenCalledWith("batch-1", { page: 1, pageSize: 100 }));

    const panel = await screen.findByTestId("members-batch-1");
    expect(within(panel).getByText("SK6_RED_7/10_000001")).toBeInTheDocument();
    expect(within(panel).getByText("SK6_RED_7/10_000004")).toBeInTheDocument();
    const rowFor = (qrId: string) => within(panel).getByText(qrId).closest("tr") as HTMLElement;
    expect(within(rowFor("SK6_RED_7/10_000001")).getByText("Production / Stock")).toHaveClass("badge");
    expect(within(rowFor("SK6_RED_7/10_000003")).getByText("Generated")).toHaveClass("badge");
    expect(within(rowFor("SK6_RED_7/10_000004")).getByText("Void")).toHaveClass("badge");
    // Only the loaded page is in the DOM, not all 50.
    expect(within(panel).getAllByRole("row")).toHaveLength(5);
    expect(within(panel).getByText(/50 codes/)).toBeInTheDocument();

    await userEvent.click(within(rowFor("SK6_RED_7/10_000003")).getByRole("button", { name: "View" }));
    await waitFor(() => expect(getQrDetail).toHaveBeenCalledWith("SK6_RED_7/10_000003"));
    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getAllByText("SK6_RED_7/10_000003").length).toBeGreaterThan(0);
    expect(within(drawer).getByText("000003")).toBeInTheDocument();
  });

  it("paging the runs keeps the tallies and asks the database to skip them", async () => {
    const api = baseApi({
      getQrGenerationOverview: vi
        .fn()
        .mockResolvedValueOnce(overview({ total: 60 }))
        .mockResolvedValue(overview({ total: 60, page: 2, totalQrCount: null, stageCounts: null })),
    });
    setupDesktop(api);
    renderPage();

    await screen.findByText("Page 1 of 3");
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(lastOverviewCall(api)).toMatchObject({ page: 2, includeSummary: false }));
    // Tallies from the first load are still shown.
    expect(await screen.findByText("Page 2 of 3")).toBeInTheDocument();
    expect(screen.getByText("62")).toBeInTheDocument();
  });

  it("says the app needs a restart when the overview bridge is missing", async () => {
    setupDesktop(baseApi({ getQrGenerationOverview: undefined }));
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent(/restart the app/i);
  });

  it("shows a clear empty state when nothing was generated in the selection", async () => {
    setupDesktop(baseApi({ getQrGenerationOverview: vi.fn().mockResolvedValue(overview({ groups: [], total: 0, totalQrCount: 0, stageCounts: {} })) }));
    renderPage();
    expect(await screen.findByText(/no codes were generated in this selection/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing generated in this selection/i)).toBeInTheDocument();
  });
});

describe("QR Management — direct lookup", () => {
  it("Enter on a full code (as a scanner sends it) opens that exact code with its timeline and lifecycle", async () => {
    const getQrDetail = vi.fn().mockResolvedValue(detail({}));
    const api = baseApi({ getQrDetail, searchQrCodes: vi.fn().mockResolvedValue([searchRow({ qrId: "SK6_RED_7/10_000037", stage: "DISPATCHED" })]) });
    setupDesktop(api);
    renderPage();

    await userEvent.type(screen.getByLabelText("Search QR Code"), "sk6_red_7/10_000037{Enter}");
    await waitFor(() => expect(getQrDetail).toHaveBeenCalledWith("SK6_RED_7/10_000037"));

    const drawer = await screen.findByRole("dialog");
    // Identity: the raw code as subtext, its parts in a table.
    expect(within(drawer).getAllByText("SK6_RED_7/10_000037").map((el) => el.className)).toContain("qrm-drawer-code");
    const identity = within(drawer).getByRole("table", { name: "Identity" });
    expect(within(identity).getAllByRole("columnheader").map((th) => th.textContent)).toEqual(["Article", "Colour", "Size", "Code"]);
    expect(within(identity).getAllByRole("cell").map((td) => td.textContent)).toEqual(["SK6", "RED", "7/10", "000037"]);
    // Current status, separate from history.
    expect(within(drawer).getAllByText("Dispatched").some((el) => el.classList.contains("badge"))).toBe(true);
    // Generation facts: operator and requester are separate facts.
    expect(within(drawer).getByText("admin")).toBeInTheDocument();
    expect(within(drawer).getByText("Aslam (Production)")).toBeInTheDocument();
    expect(within(drawer).getByText("000001 → 000050")).toBeInTheDocument();
    expect(within(drawer).getByText("12 of 50 produced")).toBeInTheDocument();
    // Timeline: only what actually happened, oldest first — registration, then the two scans.
    const timeline = within(drawer).getByText("Timeline").nextElementSibling as HTMLElement;
    const entries = within(timeline).getAllByRole("listitem").map((li) => li.querySelector("strong")?.textContent);
    expect(entries).toEqual(["Generated", "Production scan (+IN)", "Dispatched"]);
    expect(within(timeline).getByText(/Factory 777 · Line 1 · Aslam/)).toBeInTheDocument();
    expect(within(timeline).getByText(/Factory 777 · Gate · device-2 · pending/)).toBeInTheDocument();
    // Lifecycle rail: canonical order, current step marked, untracked steps labelled as such.
    const rail = within(drawer).getByRole("list", { name: "Lifecycle" });
    const steps = within(rail).getAllByRole("listitem");
    expect(steps.map((s) => s.querySelector(".qrm-rail-label")?.textContent)).toEqual([
      "Generated",
      "Production / Stock",
      "In Store",
      "To Gate",
      "Dispatched",
      // A carton a customer sends back steps onto the rail here: credited and standing at
      // the gate, not in stock until Store Scanning receives it.
      "On Gate (returned)",
      "Delivered",
    ]);
    expect(steps[4]).toHaveAttribute("aria-current", "step");
    expect(steps[0]).toHaveClass("qrm-rail-step--done");
    expect(steps[1]).toHaveClass("qrm-rail-step--done");
    // In Store and To Gate are tracked steps now that Store Scanning and Store Move Out
    // record them; a dispatched unit is past both.
    expect(steps[2]).toHaveClass("qrm-rail-step--done");
    expect(within(steps[2]).queryByText("not tracked")).not.toBeInTheDocument();
    expect(steps[3]).toHaveClass("qrm-rail-step--done");
    expect(within(steps[3]).queryByText("not tracked")).not.toBeInTheDocument();
    // On Gate is tracked (a recorded return puts a carton there); Delivered still is not.
    expect(within(steps[5]).queryByText("not tracked")).not.toBeInTheDocument();
    expect(steps[6]).toHaveClass("qrm-rail-step--untracked");
    // Variant-level stock is not a fact about this code, so it is not shown here.
    expect(within(drawer).queryByText(/on hand/)).not.toBeInTheDocument();
  });

  it("reports QR NOT FOUND for an unknown code and creates nothing", async () => {
    const api = baseApi({ getQrDetail: vi.fn().mockResolvedValue(null), searchQrCodes: vi.fn().mockResolvedValue([]) });
    setupDesktop(api);
    renderPage();

    await userEvent.type(screen.getByLabelText("Search QR Code"), "SK6_RED_7/10_999999{Enter}");
    await waitFor(() => expect(api.getQrDetail).toHaveBeenCalledWith("SK6_RED_7/10_999999"));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("QR NOT FOUND");
    expect(alert).toHaveTextContent("SK6_RED_7/10_999999");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // Nothing that could write was called.
    expect(api.voidQrCode).not.toHaveBeenCalled();
    expect(api.restoreQrCode).not.toHaveBeenCalled();
    expect(api.markQrCodeDamaged).not.toHaveBeenCalled();
  });

  it("never opens a stale suggestion when Enter is pressed on a different, unknown value", async () => {
    // A scanner types the whole code and presses Enter before the suggestion search for it has run.
    const searchQrCodes = vi.fn().mockImplementation(async (q: string) => (q.includes("000050") ? [searchRow({ qrId: "SK6_RED_7/10_000050", stage: "VOID" })] : []));
    const getQrDetail = vi.fn().mockImplementation(async (id: string) => (id === "SK6_RED_7/10_000050" ? detail({ qrId: id, stage: "VOID", lifecycle: null, events: [] }) : null));
    setupDesktop(baseApi({ searchQrCodes, getQrDetail }));
    renderPage();

    const input = screen.getByLabelText("Search QR Code");
    await userEvent.type(input, "SK6_RED_7/10_000050");
    await waitFor(() => expect(searchQrCodes).toHaveBeenCalledWith("SK6_RED_7/10_000050", 50));
    await screen.findByRole("listbox", { name: "Matching codes" });

    // Replace the value and submit immediately, before the 250 ms debounce fires.
    fireEvent.change(input, { target: { value: "SK6_RED_7/10_999999" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    expect(await screen.findByRole("alert")).toHaveTextContent("QR NOT FOUND");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(getQrDetail).not.toHaveBeenCalledWith("SK6_RED_7/10_000050");
  });

  it("suggests matches while typing and opens one on click", async () => {
    const searchQrCodes = vi.fn().mockResolvedValue([searchRow({}), searchRow({ qrId: "SK6_RED_7/10_000002", sequence: 2, stage: "REGISTERED" })]);
    const getQrDetail = vi.fn().mockResolvedValue(detail({ qrId: "SK6_RED_7/10_000002", serial: "000002", stage: "REGISTERED", lifecycle: null, events: [] }));
    setupDesktop(baseApi({ searchQrCodes, getQrDetail }));
    renderPage();

    await userEvent.type(screen.getByLabelText("Search QR Code"), "sk6 red");
    await waitFor(() => expect(searchQrCodes).toHaveBeenCalledWith("sk6 red", 50));
    const list = await screen.findByRole("listbox", { name: "Matching codes" });
    expect(within(list).getAllByRole("option")).toHaveLength(2);
    await userEvent.click(within(list).getByText("SK6_RED_7/10_000002"));
    await waitFor(() => expect(getQrDetail).toHaveBeenCalledWith("SK6_RED_7/10_000002"));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });
});

describe("QR Management — existing correction actions", () => {
  const openCode = async (qrId: string) => {
    await userEvent.type(screen.getByLabelText("Search QR Code"), `${qrId}{Enter}`);
    return screen.findByRole("dialog");
  };

  it("voids a generated code with a reason and reloads every view", async () => {
    const voidQrCode = vi.fn().mockResolvedValue({ accepted: true });
    const getQrDetail = vi
      .fn()
      .mockResolvedValueOnce(detail({ stage: "REGISTERED", lifecycle: null, events: [] }))
      .mockResolvedValue(
        detail({
          stage: "VOID",
          lifecycle: null,
          events: [],
          registry: { status: "VOID", registeredAt: "2026-09-15T05:32:00.000Z", voidReason: "Label torn", voidedAt: "2026-09-15T07:00:00.000Z", voidedBy: "admin" },
        }),
      );
    const api = baseApi({ getQrDetail, voidQrCode });
    setupDesktop(api);
    renderPage();
    await waitFor(() => expect(api.getQrGenerationOverview).toHaveBeenCalledTimes(1));

    const drawer = await openCode("SK6_RED_7/10_000037");
    await userEvent.click(within(drawer).getByRole("button", { name: /^void…$/i }));
    const dialog = await screen.findByRole("dialog", { name: /void this code/i });
    expect(within(dialog).getByRole("button", { name: /^void code$/i })).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/reason/i), "Label torn");
    await userEvent.click(within(dialog).getByRole("button", { name: /^void code$/i }));

    // The logged-in operator is recorded as the actor.
    await waitFor(() => expect(voidQrCode).toHaveBeenCalledWith({ qrId: "SK6_RED_7/10_000037", reason: "Label torn", actor: "Moeezkhan123" }));
    await waitFor(() => expect(getQrDetail).toHaveBeenCalledTimes(2));
    // The overview (with tallies) is refetched so the grouped table agrees with the change.
    await waitFor(() => expect(api.getQrGenerationOverview).toHaveBeenCalledTimes(2));
    expect(lastOverviewCall(api)).toMatchObject({ includeSummary: true });
    expect(screen.queryByRole("dialog", { name: /void this code/i })).not.toBeInTheDocument();
    // The timeline now records the void, with its reason.
    const timeline = (await screen.findByText("Timeline")).nextElementSibling as HTMLElement;
    const entries = within(timeline).getAllByRole("listitem").map((li) => li.querySelector("strong")?.textContent);
    expect(entries).toEqual(["Generated", "Voided"]);
    expect(within(timeline).getByText("“Label torn”")).toBeInTheDocument();
  });

  it("offers Restore for a void code and nothing destructive", async () => {
    const restoreQrCode = vi.fn().mockResolvedValue({ accepted: true });
    setupDesktop(
      baseApi({
        getQrDetail: vi.fn().mockResolvedValue(
          detail({
            stage: "VOID",
            lifecycle: null,
            events: [],
            registry: { status: "VOID", registeredAt: "2026-09-15T05:32:00.000Z", voidReason: "Misprint", voidedAt: "2026-09-15T07:00:00.000Z", voidedBy: "admin" },
          }),
        ),
        restoreQrCode,
      }),
    );
    renderPage();

    const drawer = await openCode("SK6_RED_7/10_000037");
    expect(within(drawer).getByText("Misprint")).toBeInTheDocument();
    expect(within(drawer).queryByRole("button", { name: /^void…$/i })).not.toBeInTheDocument();
    expect(within(drawer).queryByRole("button", { name: /mark damaged/i })).not.toBeInTheDocument();
    expect(within(drawer).getByText(/left the lifecycle/i)).toBeInTheDocument();

    await userEvent.click(within(drawer).getByRole("button", { name: /^restore$/i }));
    await waitFor(() => expect(restoreQrCode).toHaveBeenCalledWith({ qrId: "SK6_RED_7/10_000037" }));
  });

  it("marks a produced unit damaged with a reason", async () => {
    const markQrCodeDamaged = vi.fn().mockResolvedValue({ accepted: true, eventId: "ev-9" });
    setupDesktop(
      baseApi({
        getQrDetail: vi.fn().mockResolvedValue(detail({ stage: "PRODUCED", lifecycle: { ...detail({}).lifecycle!, currentStatus: "PRODUCED" }, events: [detail({}).events[0]] })),
        markQrCodeDamaged,
      }),
    );
    renderPage();

    const drawer = await openCode("SK6_RED_7/10_000037");
    expect(within(drawer).queryByRole("button", { name: /^void…$/i })).not.toBeInTheDocument();
    await userEvent.click(within(drawer).getByRole("button", { name: /mark damaged…/i }));
    const dialog = await screen.findByRole("dialog", { name: /mark unit as damaged/i });
    await userEvent.type(within(dialog).getByLabelText(/what happened/i), "Crushed in rack B");
    await userEvent.click(within(dialog).getByRole("button", { name: /^mark damaged$/i }));
    await waitFor(() =>
      expect(markQrCodeDamaged).toHaveBeenCalledWith({ qrId: "SK6_RED_7/10_000037", reason: "Crushed in rack B", actor: "Moeezkhan123" }),
    );
  });

  it("explains why nothing can be done to a unit that is with a customer", async () => {
    setupDesktop(baseApi({ getQrDetail: vi.fn().mockResolvedValue(detail({})) }));
    renderPage();
    const drawer = await openCode("SK6_RED_7/10_000037");
    expect(within(drawer).getByText(/with a customer/i)).toBeInTheDocument();
    expect(within(drawer).queryByRole("button", { name: /^void…$/i })).not.toBeInTheDocument();
    expect(within(drawer).queryByRole("button", { name: /mark damaged/i })).not.toBeInTheDocument();
    expect(within(drawer).queryByRole("button", { name: /^restore$/i })).not.toBeInTheDocument();
  });

  it("surfaces a refused action and leaves the modal open", async () => {
    const voidQrCode = vi.fn().mockResolvedValue({ accepted: false, reason: "This code is already void." });
    setupDesktop(baseApi({ getQrDetail: vi.fn().mockResolvedValue(detail({ stage: "REGISTERED", lifecycle: null, events: [] })), voidQrCode }));
    renderPage();

    const drawer = await openCode("SK6_RED_7/10_000037");
    await userEvent.click(within(drawer).getByRole("button", { name: /^void…$/i }));
    const dialog = await screen.findByRole("dialog", { name: /void this code/i });
    await userEvent.type(within(dialog).getByLabelText(/reason/i), "x");
    await userEvent.click(within(dialog).getByRole("button", { name: /^void code$/i }));
    await waitFor(() => expect(voidQrCode).toHaveBeenCalled());
    expect(screen.getByRole("dialog", { name: /void this code/i })).toBeInTheDocument();
  });
});
