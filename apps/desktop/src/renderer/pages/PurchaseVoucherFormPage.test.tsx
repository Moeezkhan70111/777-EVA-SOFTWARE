import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NotificationsProvider, useNotifications } from "../state/NotificationsContext";
import { PurchaseVoucherFormPage } from "./PurchaseVoucherFormPage";

/** The notices the screen raised, as the app's notice area would show them. */
const Notices: React.FC = () => <ul>{useNotifications().notices.map((notice) => <li key={notice.id}>{notice.message}</li>)}</ul>;

// A purchase bill is written only on the computer holding the Accounts lease (docs/54). Anywhere else the main process
// refuses the write (leaseGuard.ts), and the person must be told who writes bills, not left with a button that did
// nothing.

const BILL = {
  id: "pv1", voucherNumber: "41", partyId: "s1", voucherDate: "2026-11-20", referenceNo: "RT-77", bookNo: "", remarks: "",
  lineItems: [{ id: "l1", itemId: "i1", unitCode: "KG", costPrice: null, quantity: 200, unitPrice: 45 }],
};
// What Electron carries across the process boundary for a refused leased write.
const REFUSED = new Error("Error invoking remote method 'erp:update-purchase-voucher': LeaseError: Accounts is written on PC3 only. It is read-only here.");

function renderForm(updatePurchaseVoucher: ReturnType<typeof vi.fn>) {
  const api = {
    listParties: vi.fn().mockResolvedValue({ rows: [{ id: "s1", partyCode: "PTY-1", partyName: "SYNTHETIC SUPPLIER DELTA", partyType: "SUPPLIER", status: "ACTIVE" }], total: 1 }),
    listInventoryItems: vi.fn().mockResolvedValue([{ id: "i1", item_code: "RM-1", display_name: "DANA EVA", default_unit_code: "KG" }]),
    getNextPurchaseVoucherNumber: vi.fn().mockResolvedValue("42"),
    getPurchaseVoucher: vi.fn().mockResolvedValue(BILL),
    updatePurchaseVoucher,
  };
  Object.defineProperty(window, "desktop", { value: { versions: { node: "22", chrome: "128", electron: "43" }, api }, configurable: true });
  const onNavigate = vi.fn();
  render(<NotificationsProvider><PurchaseVoucherFormPage voucherId="pv1" onNavigate={onNavigate} /><Notices /></NotificationsProvider>);
  return { onNavigate };
}

describe("PurchaseVoucherFormPage off the accounts computer", () => {
  it("says who writes purchase bills when the write is refused, and stays on the bill", async () => {
    const updatePurchaseVoucher = vi.fn().mockRejectedValue(REFUSED);
    const { onNavigate } = renderForm(updatePurchaseVoucher);
    fireEvent.click(await screen.findByRole("button", { name: "Update Bill" }));
    expect((await screen.findAllByText("Accounts is written on PC3 only. It is read-only here.")).length).toBeGreaterThan(0);
    expect(onNavigate).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Update Bill" })).toBeEnabled());
  });

  it("saves as before on the accounts computer", async () => {
    const updatePurchaseVoucher = vi.fn().mockResolvedValue({ accepted: true });
    const { onNavigate } = renderForm(updatePurchaseVoucher);
    fireEvent.click(await screen.findByRole("button", { name: "Update Bill" }));
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith("purchase-voucher-list"));
    expect(updatePurchaseVoucher).toHaveBeenCalledWith("pv1", expect.objectContaining({ partyId: "s1", lines: [{ itemId: "i1", quantity: 200, unitPrice: 45 }] }));
  });
});
