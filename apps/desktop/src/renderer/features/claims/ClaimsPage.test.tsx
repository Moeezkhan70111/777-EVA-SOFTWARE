import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationsProvider, useNotifications } from "../../state/NotificationsContext";
import { ClaimsPage } from "./ClaimsPage";

// THE CLAIMS SCREEN as Accounts meets it (docs/55): the store's requests, priced on the accounts computer. Everywhere
// else, and for anyone not given Post Claims, it is read-only. Asserted in words (R18), with synthetic parties only.

const request = (overrides: Record<string, unknown> = {}) => ({
  requestId: "r1", requestNumber: "CR-200001", requestDate: "2026-11-21", createdBy: "store-operator", createdAt: "2026-11-21T05:00:00.000Z",
  originDeviceId: "dev-store", partyId: "s1", partyName: "SYNTHETIC SUPPLIER DELTA", role: "SUPPLIER", programId: "p1", programCode: "MP-000012",
  upperLineId: "l1", itemId: "i1", materialName: "UPPER — SK6 RED", pairs: 2, reason: "torn upper", status: "PENDING",
  posted: null, reversed: [], rejection: null, ...overrides,
});
const posting = { claimId: "c1", claimNumber: "CL-000017", claimDate: "2026-11-21", ratePaisa: 5_000, amountPaisa: 10_000, postedBy: "clerk", postedAt: "2026-11-21T06:00:00.000Z", reversedBy: null, reversedAt: null, reversalReason: null };
const page = (rows: unknown[], pending = rows.length) => ({ accepted: true, page: { rows, total: rows.length, pending } });
const REFUSED = new Error("Error invoking remote method 'erp:post-party-claim': LeaseError: Accounts is written on PC1 - ACCOUNTS only. It is read-only here.");

const Notices: React.FC = () => <ul aria-label="notices">{useNotifications().notices.map((notice) => <li key={notice.id}>{notice.title}</li>)}</ul>;

let api: Record<string, ReturnType<typeof vi.fn>>;

const show = (canPost: boolean, accountsHere: boolean) => {
  api.getWriteLeases.mockResolvedValue([
    { domain: "ACCOUNTS", canWrite: accountsHere, reason: accountsHere ? null : "HELD_ELSEWHERE", holderLabel: accountsHere ? null : "PC1 - ACCOUNTS" },
  ]);
  render(<NotificationsProvider><ClaimsPage canPost={canPost} /><Notices /></NotificationsProvider>);
};

beforeEach(() => {
  api = {
    getWriteLeases: vi.fn(),
    listPartyClaimRequests: vi.fn().mockResolvedValue(page([request()])),
    postPartyClaim: vi.fn().mockResolvedValue({ accepted: true, result: request({ status: "POSTED", posted: posting }) }),
    rejectPartyClaimRequest: vi.fn().mockResolvedValue({ accepted: true, result: request({ status: "REJECTED", rejection: { reason: "x", rejectedBy: "clerk", rejectedAt: "2026-11-21T06:00:00.000Z" } }) }),
    reversePartyClaim: vi.fn().mockResolvedValue({ accepted: true, result: { claimNumber: "CL-000017", requestId: "r1" } }),
  };
  Object.defineProperty(window, "desktop", { value: { versions: { node: "22", chrome: "128", electron: "43" }, api }, configurable: true });
});

describe("Claims", () => {
  it("shows what the store asked for: program, party, material, pairs and reason, waiting for Accounts", async () => {
    show(true, true);
    const card = await screen.findByRole("listitem", { name: "CR-200001 · MP-000012" });
    expect(within(card).getByText(/SYNTHETIC SUPPLIER DELTA/)).toBeInTheDocument();
    expect(within(card).getByText(/2 pairs of UPPER — SK6 RED — “torn upper”/)).toBeInTheDocument();
    expect(within(card).getByText("⏳ Waiting for Accounts")).toBeInTheDocument();
    expect(screen.getByText("1 request waiting for Accounts")).toBeInTheDocument();
    expect(api.listPartyClaimRequests).toHaveBeenCalledWith({ filter: "PENDING", limit: 50, offset: 0 });
  });

  it("prices and posts: the total is shown before anything is saved, and one claim id goes with the attempt", async () => {
    show(true, true);
    await userEvent.click(await screen.findByRole("button", { name: "Price and post…" }));
    const dialog = await screen.findByRole("dialog", { name: "Post claim CR-200001" });
    expect(within(dialog).getByRole("button", { name: "Post Rs —" })).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("Amount for one pair (Rs)"), "50");
    expect(within(dialog).getByText("2 × Rs 50.00 = Rs 100.00")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Post Rs 100.00" }));
    await waitFor(() => expect(api.postPartyClaim).toHaveBeenCalledTimes(1));
    const sent = api.postPartyClaim.mock.calls[0]![0] as { claimId: string; requestId: string; ratePaisa: number };
    expect({ requestId: sent.requestId, ratePaisa: sent.ratePaisa }).toEqual({ requestId: "r1", ratePaisa: 5_000 });
    expect(sent.claimId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await screen.findByText("✓ CL-000017 posted: Rs 100.00")).toBeInTheDocument();
  });

  it("refuses an amount that is not money, and says who posts claims when the gate refuses", async () => {
    api.postPartyClaim.mockRejectedValue(REFUSED);
    show(true, true);
    await userEvent.click(await screen.findByRole("button", { name: "Price and post…" }));
    const dialog = await screen.findByRole("dialog", { name: "Post claim CR-200001" });
    await userEvent.type(within(dialog).getByLabelText("Amount for one pair (Rs)"), "5.555");
    expect(within(dialog).getByRole("button", { name: "Post Rs —" })).toBeDisabled();
    await userEvent.clear(within(dialog).getByLabelText("Amount for one pair (Rs)"));
    await userEvent.type(within(dialog).getByLabelText("Amount for one pair (Rs)"), "50");
    await userEvent.click(within(dialog).getByRole("button", { name: "Post Rs 100.00" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Accounts is written on PC1 - ACCOUNTS only. It is read-only here.");
  });

  it("rejecting needs a reason, and sends it", async () => {
    show(true, true);
    await userEvent.click(await screen.findByRole("button", { name: "Reject…" }));
    const dialog = await screen.findByRole("dialog", { name: "Reject claim request CR-200001" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Reject request" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent(/Say why/);
    expect(api.rejectPartyClaimRequest).not.toHaveBeenCalled();
    await userEvent.type(within(dialog).getByLabelText("Reason"), "supplier replaced the uppers");
    await userEvent.click(within(dialog).getByRole("button", { name: "Reject request" }));
    await waitFor(() => expect(api.rejectPartyClaimRequest).toHaveBeenCalledWith({ requestId: "r1", reason: "supplier replaced the uppers" }));
  });

  it("a posted claim shows its number and amount, and is reversed with a reason", async () => {
    api.listPartyClaimRequests.mockResolvedValue(page([request({ status: "POSTED", posted: posting })], 0));
    show(true, true);
    const card = await screen.findByRole("listitem", { name: "CR-200001 · MP-000012" });
    expect(within(card).getByText("CL-000017 · 2 × Rs 50.00 = Rs 100.00")).toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: "Reverse…" }));
    const dialog = await screen.findByRole("dialog", { name: "Reverse claim CL-000017" });
    await userEvent.type(within(dialog).getByLabelText("Reason"), "wrong rate");
    await userEvent.click(within(dialog).getByRole("button", { name: "Reverse claim" }));
    await waitFor(() => expect(api.reversePartyClaim).toHaveBeenCalledWith({ claimId: "c1", reason: "wrong rate" }));
  });

  it("is read-only on the store and the boss computers: every request is seen, nothing can be posted", async () => {
    show(true, false);
    expect(await screen.findByRole("listitem", { name: "CR-200001 · MP-000012" })).toBeInTheDocument();
    expect(screen.getByTestId("read-only-notice")).toHaveTextContent(/PC1 - ACCOUNTS/);
    expect(screen.queryByRole("button", { name: "Price and post…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject…" })).toBeNull();
  });

  it("is read-only on the accounts computer too for someone not given Post Claims", async () => {
    show(false, true);
    expect(await screen.findByRole("listitem", { name: "CR-200001 · MP-000012" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Price and post…" })).toBeNull();
  });

  it("has an empty state, and an error state with Retry", async () => {
    api.listPartyClaimRequests.mockResolvedValueOnce(page([])).mockResolvedValueOnce({ accepted: false, reason: "The claims could not be loaded. Try again." });
    show(true, true);
    expect(await screen.findByText("No claim requests yet")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Posted" }));
    expect(await screen.findByText("The claims could not be loaded. Try again.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Retry/ })).toBeInTheDocument();
  });
});
