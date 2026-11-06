import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { copy } from "../../config/copy";
import { NotificationsProvider } from "../../state/NotificationsContext";
import type { CartonReconciliation } from "../../types/desktopApi";
import { CartonStockPage } from "./CartonStockPage";

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
