import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CashVoucherFormPage } from "./CashVoucherFormPage";
import { NotificationsProvider } from "../state/NotificationsContext";
import { NotificationCenter } from "../components/layout/NotificationCenter";
import { copy } from "../config/copy";
import { REQUEST_STORAGE_KEY } from "../hooks/useRequestId";

// ONE PRESS OF SAVE IS ONE PAYMENT (migration 105). The main process decides: it returns the voucher a request id
// already made (ALREADY_SAVED) or refuses a different one under the same id (REQUEST_CONFLICT). The screen's part:
// one request per press, held at once against a double click, kept across a lost answer, said once.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PARTY = { id: "p-1", partyName: "MAMA CHAPPAL", status: "ACTIVE" };

const makeApi = () => ({
  listParties: vi.fn(async () => ({ rows: [PARTY], total: 1, page: 1, pageSize: 1000 })),
  getNextCashVoucherNumber: vi.fn(async () => 12),
  getCurrentPartyBalance: vi.fn(async () => 0),
  getHeldLeases: vi.fn(async () => ["ACCOUNTS"]),
  getCashVoucher: vi.fn(async () => null),
  getCashVoucherByNumber: vi.fn(async () => null),
  findCashVoucherByRequest: vi.fn(async (_id: string) => ({ accepted: true, saved: null as { id: string; label: string } | null })),
  createCashVoucher: vi.fn(async (input: { requestId: string }) => ({ accepted: true, voucherId: input.requestId, voucherNumber: "12", outcome: "CREATED" })),
});

let api: ReturnType<typeof makeApi>;

const show = () =>
  render(
    <NotificationsProvider>
      <CashVoucherFormPage onNavigate={vi.fn()} />
      <NotificationCenter />
    </NotificationsProvider>
  );

/** One receipt row: the party and an amount, ready to save. */
async function fillReceipt(container: HTMLElement, amount = "1000"): Promise<void> {
  await waitFor(() => expect(container.querySelector(".cash-party-entry-row select option[value='p-1']")).not.toBeNull());
  await act(async () => {
    fireEvent.change(container.querySelector(".cash-party-entry-row select") as HTMLSelectElement, { target: { value: "p-1" } });
  });
  const amounts = container.querySelectorAll<HTMLInputElement>(".cash-party-entry-row input[type='number']");
  await act(async () => {
    fireEvent.change(amounts[0] as HTMLInputElement, { target: { value: amount } });
  });
}

const save = () => act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });
const requestIdOf = (call: number) => (api.createCashVoucher.mock.calls[call]?.[0] as { requestId: string }).requestId;

beforeEach(() => {
  window.localStorage.clear();
  api = makeApi();
  Object.defineProperty(window, "desktop", { value: { versions: { node: "22", chrome: "128", electron: "43" }, api }, configurable: true });
});

describe("cash voucher: one press of Save is one payment (migration 105)", () => {
  it("a double click sends one voucher, under a request id, and says it was created once", async () => {
    let answer: (value: unknown) => void = () => undefined;
    api.createCashVoucher.mockImplementationOnce((input) => new Promise((resolve) => { answer = () => resolve({ accepted: true, voucherId: input.requestId, voucherNumber: "12", outcome: "CREATED" }); }));
    const { container } = show();
    await fillReceipt(container);
    const button = screen.getByRole("button", { name: "Save" });
    await act(async () => {
      fireEvent.click(button);
      fireEvent.click(button);
      fireEvent.click(button);
    });
    await act(async () => answer(undefined));
    await waitFor(() => expect(api.createCashVoucher).toHaveBeenCalledTimes(1));
    expect(requestIdOf(0)).toMatch(UUID);
    expect(await screen.findAllByText("Cash voucher #12 created")).toHaveLength(1);
  });

  it("a lost answer keeps the request id, and the retry is answered as already saved, once", async () => {
    api.createCashVoucher
      .mockRejectedValueOnce(new Error("no answer"))
      .mockImplementationOnce(async (input) => ({ accepted: true, voucherId: input.requestId, voucherNumber: "12", outcome: "ALREADY_SAVED" }));
    const { container } = show();
    await fillReceipt(container);
    await save();
    expect(await screen.findByText("Failed to save voucher")).toBeInTheDocument();
    expect(window.localStorage.getItem(REQUEST_STORAGE_KEY.CASH_VOUCHER)).toBe(requestIdOf(0));
    await save();
    await waitFor(() => expect(api.createCashVoucher).toHaveBeenCalledTimes(2));
    expect(requestIdOf(1)).toBe(requestIdOf(0));
    expect(await screen.findByText(copy.requests.cashAlreadySaved("12"))).toBeInTheDocument();
    expect(screen.queryByText("Cash voucher #12 created")).not.toBeInTheDocument();
    expect(window.localStorage.getItem(REQUEST_STORAGE_KEY.CASH_VOUCHER)).toBeNull();
  });

  it("an edited retry the main process refuses is never reported as saved, and Save again keeps the same request", async () => {
    const conflict = "This Save was already recorded as cash voucher #12, with different details. Nothing new was saved.";
    api.createCashVoucher.mockResolvedValue({ accepted: false, errorCode: "REQUEST_CONFLICT", reason: conflict, existingId: "x", existingNumber: "12" } as never);
    const { container } = show();
    await fillReceipt(container, "900");
    await save();
    expect(await screen.findByText(conflict)).toBeInTheDocument();
    expect(screen.queryByText(/created/)).not.toBeInTheDocument();
    await save();
    await waitFor(() => expect(api.createCashVoucher).toHaveBeenCalledTimes(2));
    expect(requestIdOf(1)).toBe(requestIdOf(0));
  });

  it("reopened after a restart, it says the Save it never heard back from was recorded", async () => {
    const leftover = crypto.randomUUID();
    window.localStorage.setItem(REQUEST_STORAGE_KEY.CASH_VOUCHER, leftover);
    api.findCashVoucherByRequest.mockResolvedValue({ accepted: true, saved: { id: leftover, label: "Cash Voucher #12" } });
    show();
    expect(await screen.findByText(copy.requests.lastSaveBody("Cash Voucher #12"))).toBeInTheDocument();
    expect(api.findCashVoucherByRequest).toHaveBeenCalledWith(leftover);
    expect(window.localStorage.getItem(REQUEST_STORAGE_KEY.CASH_VOUCHER)).toBeNull();
  });

  it("a restart whose last Save made nothing says nothing, and forgets it", async () => {
    window.localStorage.setItem(REQUEST_STORAGE_KEY.CASH_VOUCHER, crypto.randomUUID());
    show();
    await waitFor(() => expect(api.findCashVoucherByRequest).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(window.localStorage.getItem(REQUEST_STORAGE_KEY.CASH_VOUCHER)).toBeNull());
    expect(screen.queryByText(copy.requests.lastSaveTitle)).not.toBeInTheDocument();
  });
});
