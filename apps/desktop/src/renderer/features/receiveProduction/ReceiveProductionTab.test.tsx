import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReceiveProductionTab } from "./ReceiveProductionTab";
import { POLL_MS } from "./useProductionReceipts";
import { QrGeneratorWorkspace } from "../qrGenerator/QrGeneratorWorkspace";
import { NotificationsProvider } from "../../state/NotificationsContext";
import type { ProductionReceipt, ProductionReceiptPage, ReceiveProductionResult } from "../../types/desktopApi";

// RECEIVE PRODUCTION — scan or type a generated carton QR; the main process decides, the screen
// says what it decided and shows today's receipts from the database.

function setupDesktop(api: Record<string, unknown>) {
  Object.defineProperty(window, "desktop", {
    value: { versions: { node: "22", chrome: "128", electron: "43" }, api },
    configurable: true,
  });
}

const QR = "SK6_BLACKGREY_7/10_000001";

const receipt = (overrides: Partial<ProductionReceipt> = {}): ProductionReceipt => ({
  qrId: QR,
  article: "SK6",
  size: "7/10",
  color: "BLACKGREY",
  grade: null,
  receivedAt: "2026-10-14T05:42:00.000Z",
  receivedBy: "aslam",
  station: "RECEIVE_PRODUCTION",
  stage: "PRODUCED",
  programCode: "MP-000001",
  machineName: "MACHINE 1",
  ...overrides,
});

const page = (rows: ProductionReceipt[], totalCartons = rows.length, summary: ProductionReceiptPage["summary"] = []): ProductionReceiptPage => ({
  date: "2026-10-14",
  rows,
  page: 1,
  pageSize: 25,
  totalCartons,
  equivalentDozens: totalCartons / 2,
  summary,
});

const received = (qrId = QR): ReceiveProductionResult => ({ accepted: true, outcome: "RECEIVED", qrId, receipt: receipt({ qrId }) });

function baseApi(overrides: Record<string, unknown> = {}) {
  return {
    receiveProduction: vi.fn().mockResolvedValue(received()),
    listProductionReceipts: vi.fn().mockResolvedValue({ accepted: true, page: page([]) }),
    findProductionReceipt: vi.fn().mockResolvedValue({ accepted: true, receipt: null }),
    ...overrides,
  };
}

const renderTab = () =>
  render(
    <NotificationsProvider>
      <ReceiveProductionTab />
    </NotificationsProvider>
  );

const scanBox = () => screen.getByRole("textbox", { name: "Scanner input" });
const status = () => screen.getByTestId("scan-status");

/** What a hardware scanner does: the whole code lands in the box at once. */
const scannerTypes = (value: string) => fireEvent.change(scanBox(), { target: { value } });

describe("ReceiveProductionTab", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.useRealTimers());

  it("A: a scanned generated carton is RECEIVED, and today's list and count come back from the database", async () => {
    const listProductionReceipts = vi
      .fn()
      .mockResolvedValueOnce({ accepted: true, page: page([]) })
      .mockResolvedValue({ accepted: true, page: page([receipt()]) });
    const api = baseApi({ listProductionReceipts });
    setupDesktop(api);
    renderTab();
    expect(await screen.findByText("Nothing received yet today")).toBeInTheDocument();

    scannerTypes(QR);

    await waitFor(() => expect(status()).toHaveTextContent("RECEIVED"));
    expect(api.receiveProduction).toHaveBeenCalledTimes(1);
    expect(api.receiveProduction).toHaveBeenCalledWith(QR);
    const table = await screen.findByRole("table", { name: "Received production" });
    const row = within(table).getAllByRole("row")[1];
    expect(row).toHaveTextContent(QR);
    expect(row).toHaveTextContent("Latest");
    expect(screen.getByText("1 carton")).toBeInTheDocument();
    expect(screen.getByText("0.5 DZN")).toBeInTheDocument();
  });

  it("B: a QR that was never generated says QR NOT GENERATED, and the list is not changed", async () => {
    const api = baseApi({
      receiveProduction: vi.fn().mockResolvedValue({ accepted: false, outcome: "NOT_GENERATED", qrId: "SK6_BLACKGREY_7/10_000999", receipt: null }),
    });
    setupDesktop(api);
    renderTab();
    await screen.findByText("Nothing received yet today");
    const loadsBefore = api.listProductionReceipts.mock.calls.length;

    scannerTypes("SK6_BLACKGREY_7/10_000999");

    await waitFor(() => expect(status()).toHaveTextContent("QR NOT GENERATED"));
    expect(screen.getByText("This carton cannot be received into production.")).toBeInTheDocument();
    expect(api.listProductionReceipts.mock.calls.length).toBe(loadsBefore);
  });

  it("C: a raw material label is named as one", async () => {
    setupDesktop(baseApi({ receiveProduction: vi.fn().mockResolvedValue({ accepted: false, outcome: "RAW_MATERIAL_QR", qrId: "RM_P1_I1_000001" }) }));
    renderTab();
    scannerTypes("RM_P1_I1_000001");
    await waitFor(() => expect(status()).toHaveTextContent("RAW MATERIAL LABEL"));
  });

  it("D: a carton already received says ALREADY RECEIVED with when — distinct from a new receipt", async () => {
    setupDesktop(
      baseApi({ receiveProduction: vi.fn().mockResolvedValue({ accepted: false, outcome: "ALREADY_RECEIVED", qrId: QR, receipt: receipt() }) })
    );
    renderTab();
    scannerTypes(QR);
    await waitFor(() => expect(status()).toHaveTextContent("ALREADY RECEIVED"));
    expect(status()).not.toHaveTextContent(/^RECEIVED$/);
    expect(screen.getByText(/already been recorded in production/)).toBeInTheDocument();
  });

  it("G: an ineligible (voided) carton says why", async () => {
    setupDesktop(
      baseApi({ receiveProduction: vi.fn().mockResolvedValue({ accepted: false, outcome: "INELIGIBLE", qrId: QR, reason: "This QR was voided in QR Management and cannot be produced." }) })
    );
    renderTab();
    scannerTypes(QR);
    await waitFor(() => expect(status()).toHaveTextContent("QR INELIGIBLE"));
    expect(screen.getByText(/voided in QR Management/)).toBeInTheDocument();
  });

  it("E: a code typed by hand waits for Enter — the key and the button send it the same way", async () => {
    const api = baseApi({ receiveProduction: vi.fn().mockResolvedValue(received("SK6_RED_7/10_000002")) });
    setupDesktop(api);
    renderTab();
    const user = userEvent.setup({ delay: 90 });

    await user.type(scanBox(), "SK6_RED_7/10_000002");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(api.receiveProduction, "nothing is sent half-typed").not.toHaveBeenCalled();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(api.receiveProduction).toHaveBeenCalledWith("SK6_RED_7/10_000002"));
    await waitFor(() => expect(scanBox()).toHaveValue(""));

    await user.type(scanBox(), "SK6_RED_7/10_000002");
    await user.click(screen.getByRole("button", { name: "Enter" }));
    await waitFor(() => expect(api.receiveProduction).toHaveBeenCalledTimes(2));
    expect(api.receiveProduction.mock.calls[1]).toEqual(api.receiveProduction.mock.calls[0]);
  }, 15000);

  it("E: a refused typed code is put back in the box for correcting", async () => {
    setupDesktop(baseApi({ receiveProduction: vi.fn().mockResolvedValue({ accepted: false, outcome: "NOT_GENERATED", qrId: "SK6_RED_7/10_000009" }) }));
    renderTab();
    const user = userEvent.setup({ delay: 90 });
    await user.type(scanBox(), "SK6_RED_7/10_000009");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(status()).toHaveTextContent("QR NOT GENERATED"));
    await waitFor(() => expect(scanBox()).toHaveValue("SK6_RED_7/10_000009"));
  }, 15000);

  it("F: consecutive scans are each sent once, in turn, and the box keeps the focus", async () => {
    const codes = ["SK6_RED_7/10_000001", "SK6_RED_7/10_000002", "SK6_RED_7/10_000003"];
    let inFlight = 0;
    let overlapped = false;
    const receiveProduction = vi.fn(async (code: string) => {
      inFlight += 1;
      if (inFlight > 1) overlapped = true;
      await new Promise((resolve) => setTimeout(resolve, 30));
      inFlight -= 1;
      return received(code);
    });
    setupDesktop(baseApi({ receiveProduction }));
    renderTab();

    // Each label is scanned as soon as the box has taken the last one — while the last receipt is
    // still on its way (30 ms), so they queue rather than overlap.
    for (const code of codes) {
      scannerTypes(code);
      await waitFor(() => expect(scanBox()).toHaveValue(""));
    }
    await waitFor(() => expect(receiveProduction).toHaveBeenCalledTimes(3));
    expect(receiveProduction.mock.calls.map(([code]) => code)).toEqual(codes);
    expect(overlapped, "never two at once").toBe(false);
    await waitFor(() => expect(scanBox()).toHaveFocus());
  });

  it("I: when the call itself fails, the database decides — recorded after all", async () => {
    const api = baseApi({
      receiveProduction: vi.fn().mockRejectedValue(new Error("IPC timeout")),
      findProductionReceipt: vi.fn().mockResolvedValue({ accepted: true, receipt: receipt() }),
    });
    setupDesktop(api);
    renderTab();
    scannerTypes(QR);
    await waitFor(() => expect(status()).toHaveTextContent("RECEIVED"));
    expect(api.findProductionReceipt).toHaveBeenCalledWith(QR);
    expect(screen.getByText("Recorded — confirmed after a connection problem.")).toBeInTheDocument();
    expect(api.receiveProduction, "never retried blindly").toHaveBeenCalledTimes(1);
  });

  it("I: when the call fails and the carton is not recorded, it says SYSTEM ERROR and the next scan still works", async () => {
    const receiveProduction = vi.fn().mockRejectedValueOnce(new Error("IPC timeout")).mockResolvedValue(received("SK6_RED_7/10_000002"));
    setupDesktop(baseApi({ receiveProduction }));
    renderTab();
    scannerTypes(QR);
    await waitFor(() => expect(status()).toHaveTextContent("SYSTEM ERROR"));
    scannerTypes("SK6_RED_7/10_000002");
    await waitFor(() => expect(status()).toHaveTextContent("RECEIVED"));
  });

  it("J: a carton received at another station appears without a refresh", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const listProductionReceipts = vi.fn().mockResolvedValue({ accepted: true, page: page([]) });
    setupDesktop(baseApi({ listProductionReceipts }));
    renderTab();
    await screen.findByText("Nothing received yet today");

    listProductionReceipts.mockResolvedValue({ accepted: true, page: page([receipt({ qrId: "SK6_RED_7/10_000777", receivedBy: "babar" })]) });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS + 10);
    });
    expect(await screen.findByText("SK6_RED_7/10_000777")).toBeInTheDocument();
    expect(screen.getByText("1 carton")).toBeInTheDocument();
  });

  it("Summary adds the day up per article, size and colour, with the total — from the same read as Details", async () => {
    const summary = [
      { article: "SK6", size: "4/6", color: "BLACK", grade: null, cartons: 40, equivalentDozens: 20 },
      { article: "SK6", size: "7/10", color: "RED", grade: null, cartons: 20, equivalentDozens: 10 },
    ];
    const api = baseApi({ listProductionReceipts: vi.fn().mockResolvedValue({ accepted: true, page: page([receipt()], 60, summary) }) });
    setupDesktop(api);
    renderTab();
    expect(await screen.findByRole("table", { name: "Received production" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Details" })).toHaveAttribute("aria-selected", "true");

    await userEvent.click(screen.getByRole("tab", { name: "Summary" }));
    const table = screen.getByRole("table", { name: "Received production by article, size and colour" });
    const rows = within(table).getAllByRole("row").map((row) => row.textContent);
    expect(rows).toEqual([
      "ArticleSizeColourCartonsDozens",
      "SK64/6BLACK4020 DZN",
      "SK67/10RED2010 DZN",
      "Total6030 DZN",
    ]);
    expect(api.receiveProduction).not.toHaveBeenCalled();
  });

  it("shows when the list could not be refreshed, keeping what it had", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const listProductionReceipts = vi.fn().mockResolvedValueOnce({ accepted: true, page: page([receipt()]) }).mockRejectedValue(new Error("offline"));
    setupDesktop(baseApi({ listProductionReceipts }));
    renderTab();
    expect(await screen.findByText(QR)).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS + 10);
    });
    expect(await screen.findByText(/Not updating/)).toBeInTheDocument();
    expect(screen.getByText(QR)).toBeInTheDocument();
  });
});

describe("Receive Production in the QR Generator", () => {
  beforeEach(() => vi.clearAllMocks());

  const workspaceApi = () => ({
    ...baseApi(),
    listMachines: vi.fn().mockResolvedValue([]),
    listProducts: vi.fn().mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: 1000 }),
    listQrColors: vi.fn().mockResolvedValue([]),
    listQrBatches: vi.fn().mockResolvedValue([]),
    generateQrBatch: vi.fn(),
  });

  it("is the third tab, asks for no machine, and opening it records nothing", async () => {
    const api = workspaceApi();
    setupDesktop(api);
    render(
      <NotificationsProvider>
        <QrGeneratorWorkspace username="admin" onNavigate={vi.fn()} canReceiveProduction />
      </NotificationsProvider>
    );
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Carton QR", "B-Carton Labels", "Receive Production"]);
    await userEvent.click(screen.getByRole("tab", { name: "Receive Production" }));
    expect(await screen.findByRole("heading", { name: "Receive Production" })).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "Machine" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Carton QR" }));
    expect(api.receiveProduction).not.toHaveBeenCalled();
    expect(api.generateQrBatch).not.toHaveBeenCalled();
  });

  it("is not offered to a user who may not record production", () => {
    setupDesktop(workspaceApi());
    render(
      <NotificationsProvider>
        <QrGeneratorWorkspace username="admin" onNavigate={vi.fn()} />
      </NotificationsProvider>
    );
    expect(screen.queryByRole("tab", { name: "Receive Production" })).not.toBeInTheDocument();
  });
});
