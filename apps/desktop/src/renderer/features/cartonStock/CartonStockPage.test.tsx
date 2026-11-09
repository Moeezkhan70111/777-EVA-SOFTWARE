import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { copy } from "../../config/copy";
import { NotificationsProvider } from "../../state/NotificationsContext";
import type { CartonReconciliation } from "../../types/desktopApi";
import { CartonStockPage } from "./CartonStockPage";
import { CARTON_STOCK_FALLBACK_POLL_MS, CARTON_STOCK_TRACE_SCREEN } from "./useCartonStock";

// CARTON STOCK: an administrator adjusts, with a reason, and reads whether the figure matches its
// movements. The main process decides and writes everything; the screen says what it answered.

const text = copy.cartonStock;

const reconciliation = (over: Partial<CartonReconciliation> = {}): CartonReconciliation => ({
  rows: [{ variantId: "v-1", article: "SK6", size: "7/10", color: "RED", produced: 20, adjusted: -3, issued: 5, movementStock: 12, qrInStore: 0, storeFigure: 12, difference: 0 }],
  page: 1, pageSize: 25, total: 1, movements: 4, fingerprint: "abc123", differences: 0, unsent: 0, refused: 0, waiting: 0, entriesBeforeFreshStart: 0,
  ...over,
});

const product = { id: "as-1", articleSizeId: "as-1", article: "SK6", size: "7/10", color: "", colors: ["RED"], status: "ACTIVE" };

const api = {
  listProducts: vi.fn(),
  getCartonStockReconciliation: vi.fn(),
  adjustCartonStock: vi.fn(),
};

const show = () => render(<NotificationsProvider><CartonStockPage /></NotificationsProvider>);

/** Article, size, colour and cartons chosen, ready for a reason. */
async function fillForm(): Promise<void> {
  await userEvent.click(await screen.findByRole("combobox", { name: copy.manualProduction.articleLabel }));
  await userEvent.click(await screen.findByRole("option", { name: "SK6" }));
  await userEvent.click(screen.getByRole("combobox", { name: copy.manualProduction.sizeLabel }));
  await userEvent.click(await screen.findByRole("option", { name: "7/10" }));
  await userEvent.click(screen.getByRole("combobox", { name: copy.manualProduction.colorLabel }));
  await userEvent.click(await screen.findByRole("option", { name: "RED" }));
  await userEvent.type(screen.getByLabelText(text.cartonsLabel), "3");
}

beforeEach(() => {
  api.listProducts.mockReset().mockResolvedValue({ rows: [product] });
  api.getCartonStockReconciliation.mockReset().mockResolvedValue({ accepted: true, reconciliation: reconciliation() });
  api.adjustCartonStock.mockReset().mockResolvedValue({ accepted: true, duplicate: false });
  Object.defineProperty(window, "desktop", { value: { versions: { node: "22", chrome: "128", electron: "43" }, api }, configurable: true });
});

describe("adjusting carton stock", () => {
  it("cannot be saved without a reason", async () => {
    show();
    await fillForm();
    expect(screen.getByRole("button", { name: text.save })).toBeDisabled();
    await userEvent.type(screen.getByLabelText(text.reasonLabel), "   ");
    expect(screen.getByRole("button", { name: text.save })).toBeDisabled();
    expect(api.adjustCartonStock).not.toHaveBeenCalled();
  });

  it("sends the product, direction, cartons and reason under one request id, and says what it did", async () => {
    show();
    await fillForm();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: text.directionLabel }), "OUT");
    await userEvent.type(screen.getByLabelText(text.reasonLabel), "counted");
    await userEvent.click(screen.getByRole("button", { name: text.save }));

    expect(api.adjustCartonStock).toHaveBeenCalledTimes(1);
    expect(api.adjustCartonStock.mock.calls[0]?.[0]).toMatchObject({ articleSizeId: "as-1", color: "RED", direction: "OUT", cartons: 3, reason: "counted" });
    expect(await screen.findByText(text.saved("OUT", 3))).toBeInTheDocument();
    await waitFor(() => expect(api.getCartonStockReconciliation.mock.calls.length).toBeGreaterThan(1));
  });

  it("says a refusal in the main process's words, and keeps what was typed", async () => {
    api.adjustCartonStock.mockResolvedValue({ accepted: false, reason: "The store does not hold 3 carton(s)." });
    show();
    await fillForm();
    await userEvent.type(screen.getByLabelText(text.reasonLabel), "counted");
    await userEvent.click(screen.getByRole("button", { name: text.save }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The store does not hold 3 carton(s).");
    expect(screen.getByLabelText(text.reasonLabel)).toHaveValue("counted");
  });

  it("a Save pressed again after no answer asks about the same movement, so it cannot happen twice", async () => {
    api.adjustCartonStock.mockRejectedValueOnce(new Error("")).mockResolvedValueOnce({ accepted: true, duplicate: true });
    show();
    await fillForm();
    await userEvent.type(screen.getByLabelText(text.reasonLabel), "counted");
    await userEvent.click(screen.getByRole("button", { name: text.save }));
    expect(await screen.findByRole("alert")).toHaveTextContent(text.noAnswer);
    await userEvent.click(screen.getByRole("button", { name: text.save }));
    expect(await screen.findByText(text.alreadySaved)).toBeInTheDocument();
    const ids = api.adjustCartonStock.mock.calls.map((call) => (call[0] as { requestId: string }).requestId);
    expect(ids[0]).toBe(ids[1]);
  });

  it("a definite answer gives the next adjustment a new id", async () => {
    show();
    await fillForm();
    await userEvent.type(screen.getByLabelText(text.reasonLabel), "one");
    await userEvent.click(screen.getByRole("button", { name: text.save }));
    await screen.findByText(text.saved("IN", 3));
    await userEvent.type(screen.getByLabelText(text.cartonsLabel), "2");
    await userEvent.type(screen.getByLabelText(text.reasonLabel), "two");
    await userEvent.click(screen.getByRole("button", { name: text.save }));
    await screen.findByText(text.saved("IN", 2));
    const ids = api.adjustCartonStock.mock.calls.map((call) => (call[0] as { requestId: string }).requestId);
    expect(ids[0]).not.toBe(ids[1]);
  });
});

describe("the reconciliation", () => {
  it("shows the movement history to compare, and says all is well in words", async () => {
    show();
    expect(await screen.findByText("abc123")).toBeInTheDocument();
    expect(screen.getByText(`✓ ${text.allAgree}`)).toBeInTheDocument();
    expect(screen.getByText(text.agrees)).toBeInTheDocument();
  });

  it("names what is wrong in words, never only by colour", async () => {
    api.getCartonStockReconciliation.mockResolvedValue({
      accepted: true,
      reconciliation: reconciliation({
        differences: 1, refused: 2, waiting: 3, entriesBeforeFreshStart: 4,
        rows: [{ variantId: "v-1", article: "SK6", size: "7/10", color: "RED", produced: 20, adjusted: 0, issued: 0, movementStock: 20, qrInStore: 1, storeFigure: 28, difference: 7 }],
      }),
    });
    show();
    expect(await screen.findByText(`⚠ ${text.differencesWarning(1)}`)).toBeInTheDocument();
    expect(screen.getByText(`⚠ ${text.refusedWarning(2)}`)).toBeInTheDocument();
    expect(screen.getByText(`⚠ ${text.waitingWarning(3)}`)).toBeInTheDocument();
    expect(screen.getByText(`⚠ ${text.beforeFreshStart(4)}`)).toBeInTheDocument();
    expect(screen.getByText("⚠ 7")).toBeInTheDocument();
  });

  it("empty says so", async () => {
    api.getCartonStockReconciliation.mockResolvedValue({ accepted: true, reconciliation: reconciliation({ rows: [], total: 0, movements: 0 }) });
    show();
    expect(await screen.findByText(text.emptyTitle)).toBeInTheDocument();
  });

  it("a read that fails says so, with a retry", async () => {
    api.getCartonStockReconciliation.mockResolvedValueOnce({ accepted: false, reason: "Only an administrator can do this." });
    show();
    expect(await screen.findByText("Only an administrator can do this.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });
});

// LIVE UPDATES FROM OTHER COMPUTERS. A sync pass that applies another computer's carton movement
// announces CARTONS (main/cloudSyncPass.ts -> shared/dataChange.ts); the doorbell starts that pass
// within seconds, and on every reconnect (packages/sync doorbell.test.ts, "catches up again after the
// gap"). These prove the open page answers the announcement by re-reading the main process's ledger.
describe("live updates from other computers, with the page open", () => {
  /** The movement ledger as the main process would read it, changed by "another computer". */
  let ledger: CartonReconciliation;
  const row = (over: Partial<CartonReconciliation["rows"][number]>) => ({ ...reconciliation().rows[0]!, ...over });

  const installLiveBridge = () => {
    const listeners = new Set<(change: unknown) => void>();
    const onDataChanged = vi.fn((listener: (change: unknown) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    });
    const traceDataChange = vi.fn(async (_trace: unknown) => undefined);
    Object.defineProperty(window, "desktop", {
      value: { versions: { node: "22", chrome: "128", electron: "43" }, api: { ...api, onDataChanged, traceDataChange } },
      configurable: true,
    });
    const announce = (kinds: string[], id?: string) => act(() => listeners.forEach((listener) => listener(id ? { kinds, id } : { kinds })));
    return { announce, listeners, traceDataChange };
  };

  const cell = (name: string) => screen.findByRole("row", { name: new RegExp(name) });

  beforeEach(() => {
    ledger = reconciliation();
    api.getCartonStockReconciliation.mockReset().mockImplementation(async () => ({ accepted: true, reconciliation: ledger }));
  });

  it("a production saved on another computer shows here without a reload", async () => {
    const { announce } = installLiveBridge();
    show();
    expect(await cell("SK6 7/10 RED 20 -3 5 12")).toBeInTheDocument();

    ledger = reconciliation({ movements: 5, fingerprint: "after-production", rows: [row({ produced: 30, movementStock: 22, storeFigure: 22 })] });
    announce(["CARTONS", "SYNC"]);

    expect(await screen.findByText("after-production")).toBeInTheDocument();
    expect(await cell("SK6 7/10 RED 30 -3 5 22")).toBeInTheDocument();
  });

  it("a gatepass on another computer takes its cartons off here without a reload", async () => {
    const { announce } = installLiveBridge();
    show();
    await cell("SK6 7/10 RED 20 -3 5 12");

    ledger = reconciliation({ movements: 5, fingerprint: "after-gatepass", rows: [row({ issued: 9, movementStock: 8, storeFigure: 8 })] });
    announce(["BILLING", "CARTONS", "SYNC"]);

    expect(await cell("SK6 7/10 RED 20 -3 9 8")).toBeInTheDocument();
  });

  it("a burst of announcements reads once, and a repeated one cannot count a movement twice", async () => {
    const { announce } = installLiveBridge();
    show();
    await cell("SK6 7/10 RED 20 -3 5 12");
    const readsBefore = api.getCartonStockReconciliation.mock.calls.length;

    ledger = reconciliation({ movements: 5, fingerprint: "one-movement", rows: [row({ produced: 21, movementStock: 13, storeFigure: 13 })] });
    announce(["CARTONS"]);
    announce(["CARTONS"]);
    announce(["CARTONS", "PRODUCTS"]);
    expect(await screen.findByText("one-movement")).toBeInTheDocument();
    expect(api.getCartonStockReconciliation.mock.calls.length).toBe(readsBefore + 1);

    // The same movement announced again later: the page shows the ledger, not ledger + movement.
    announce(["CARTONS"]);
    await waitFor(() => expect(api.getCartonStockReconciliation.mock.calls.length).toBe(readsBefore + 2));
    expect(await cell("SK6 7/10 RED 21 -3 5 13")).toBeInTheDocument();
    expect(screen.queryByText(/SK6 7\/10 RED 22/)).not.toBeInTheDocument();
  });

  it("after a connection gap, the catch-up announcement brings every missed movement", async () => {
    const { announce } = installLiveBridge();
    show();
    await cell("SK6 7/10 RED 20 -3 5 12");

    // Offline: three movements land on the other computer and nothing is announced here.
    ledger = reconciliation({ movements: 7, fingerprint: "caught-up", rows: [row({ produced: 26, adjusted: -4, issued: 7, movementStock: 15, storeFigure: 15 })] });
    expect(screen.queryByText("caught-up")).not.toBeInTheDocument();

    // Reconnected: the doorbell rings once, the pass pulls the gap, and announces.
    announce(["CARTONS", "SYNC"]);
    expect(await cell("SK6 7/10 RED 26 -4 7 15")).toBeInTheDocument();
  });

  it("other kinds of data do not re-read carton stock", async () => {
    const { announce } = installLiveBridge();
    show();
    await cell("SK6 7/10 RED 20 -3 5 12");
    const readsBefore = api.getCartonStockReconciliation.mock.calls.length;
    announce(["STOCK", "MATERIALS", "CASH", "SYNC"]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(api.getCartonStockReconciliation.mock.calls.length).toBe(readsBefore);
  });

  it("leaving the page lets go of its subscription", async () => {
    const { listeners } = installLiveBridge();
    const page = show();
    await cell("SK6 7/10 RED 20 -3 5 12");
    expect(listeners.size).toBe(1);
    page.unmount();
    expect(listeners.size).toBe(0);
  });

  it("traces one change from the moment it is heard to the moment it is on screen, under the change's id", async () => {
    const { announce, traceDataChange } = installLiveBridge();
    show();
    await cell("SK6 7/10 RED 20 -3 5 12");
    ledger = reconciliation({ movements: 5, fingerprint: "traced", rows: [row({ produced: 30, movementStock: 22, storeFigure: 22 })] });

    announce(["CARTONS", "SYNC"], "change-27608");
    expect(await cell("SK6 7/10 RED 30 -3 5 22")).toBeInTheDocument();

    await waitFor(() => expect(traceDataChange.mock.calls.map((call) => (call[0] as { stage: string }).stage)).toEqual(["received", "reread-started", "reread-done", "shown"]));
    for (const [trace] of traceDataChange.mock.calls) expect(trace).toMatchObject({ id: "change-27608", screen: CARTON_STOCK_TRACE_SCREEN });
    const steps = traceDataChange.mock.calls.map((call) => call[0] as { stage: string; detail?: string });
    expect(steps[0]?.detail).toBe("CARTONS,SYNC");
    expect(steps[2]?.detail).toBe("movements=5 fingerprint=traced");
    expect(steps[3]?.detail).toBe("movements=5 fingerprint=traced");
  });

  it("a re-read the main process refuses is traced as refused, and the figures on screen are not replaced", async () => {
    const { announce, traceDataChange } = installLiveBridge();
    show();
    await cell("SK6 7/10 RED 20 -3 5 12");
    api.getCartonStockReconciliation.mockResolvedValueOnce({ accepted: false, reason: "Only an administrator can do this.", reconciliation: null });

    announce(["CARTONS"], "change-refused");
    await waitFor(() => expect(traceDataChange.mock.calls.map((call) => (call[0] as { stage: string }).stage)).toContain("reread-done"));
    const done = traceDataChange.mock.calls.map((call) => call[0] as { stage: string; detail?: string }).find((step) => step.stage === "reread-done");
    expect(done?.detail).toBe("refused: Only an administrator can do this.");
    expect(traceDataChange.mock.calls.map((call) => (call[0] as { stage: string }).stage)).not.toContain("shown");
    expect(await cell("SK6 7/10 RED 20 -3 5 12")).toBeInTheDocument();
  });

  it("polls only as a fallback, once a minute", () => {
    expect(CARTON_STOCK_FALLBACK_POLL_MS).toBe(60000);
  });
});
