import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BulkOpeningBalanceDialog } from "./BulkOpeningBalanceDialog";
import { WithdrawArchiveDialog } from "./WithdrawArchiveDialog";

// Moving the previous software's ledgers in (docs/53): every party's opening balance at a cutover the administrator
// types, and withdrawing an import with a reason. Nothing is posted or withdrawn until the person confirms.

const withApi = (api: Record<string, unknown>) =>
  Object.defineProperty(window, "desktop", { value: { versions: { node: "22", chrome: "128", electron: "43" }, api }, configurable: true });

const proposal = (fields: Record<string, unknown>) => ({
  partyId: "p1", partyName: "SYNTHETIC CUSTOMER ALPHA", partyCode: "PTY-1", originalPartyCode: "1301901", status: "READY", skipReason: null,
  direction: "DEBIT", amountPaisa: 548_210_500, sidePaisa: 548_210_500, archiveStatementId: "st1", balanceAsOf: "2026-11-19", linesOnOrAfterCutover: 0, firstLiveDate: null, warnings: [], ...fields,
});
const PREVIEW = {
  accepted: true,
  preview: {
    side: "CUSTOMER", cutoverDate: "2026-11-21",
    proposals: [proposal({}), proposal({ partyId: "p2", partyName: "ZERO TRADERS", status: "SKIP", skipReason: "The archive closes at zero: there is nothing to post.", direction: null, amountPaisa: null, archiveStatementId: null })],
  },
};

describe("BulkOpeningBalanceDialog", () => {
  it("has no cutover date until one is typed, and works nothing out without it", async () => {
    const previewBulkOpeningBalances = vi.fn();
    withApi({ previewBulkOpeningBalances });
    render(<BulkOpeningBalanceDialog side="CUSTOMER" onPosted={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByLabelText("Cutover date")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Work out balances" }));
    expect(await screen.findByText(/Enter the cutover date first/)).toBeInTheDocument();
    expect(previewBulkOpeningBalances).not.toHaveBeenCalled();
  });

  it("previews at the typed date, says why a party is left out, and posts exactly what was shown after a confirmation", async () => {
    const previewBulkOpeningBalances = vi.fn().mockResolvedValue(PREVIEW);
    const postBulkOpeningBalances = vi.fn().mockResolvedValue({ accepted: true, result: { duplicate: false, posted: 1, partyIds: ["p1"] } });
    const onPosted = vi.fn();
    withApi({ previewBulkOpeningBalances, postBulkOpeningBalances });
    render(<BulkOpeningBalanceDialog side="CUSTOMER" onPosted={onPosted} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Cutover date"), { target: { value: "2026-11-21" } });
    fireEvent.click(screen.getByRole("button", { name: "Work out balances" }));

    expect(await screen.findByText(/nothing to post/)).toBeInTheDocument();
    expect(previewBulkOpeningBalances).toHaveBeenCalledWith("CUSTOMER", "2026-11-21");
    expect(screen.getByRole("checkbox", { name: "Post the opening balance of SYNTHETIC CUSTOMER ALPHA" })).toBeChecked();
    expect(screen.queryByRole("checkbox", { name: /ZERO TRADERS/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Post 1 opening balance" }));
    expect(postBulkOpeningBalances).not.toHaveBeenCalled();
    expect(screen.getByText(/Each can later be corrected or reversed one by one/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Post 1 opening balance" }));
    await screen.findByText("✓ Opening balances posted");
    const sent = postBulkOpeningBalances.mock.calls[0]?.[0] as { requestId: string; side: string; cutoverDate: string; expected: unknown[] };
    expect(sent.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect([sent.side, sent.cutoverDate]).toEqual(["CUSTOMER", "2026-11-21"]);
    expect(sent.expected).toEqual([{ partyId: "p1", direction: "DEBIT", amountPaisa: 548_210_500, archiveStatementId: "st1" }]);
    // The footer Close and the header close both reload: either one.
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]!);
    expect(onPosted).toHaveBeenCalledTimes(1);
  });

  it("shows the refusal as it is, and a party left unchosen is not sent", async () => {
    const postBulkOpeningBalances = vi.fn().mockResolvedValue({ accepted: false, reason: "SYNTHETIC CUSTOMER ALPHA: not what was previewed any more. Preview again. Nothing was saved." });
    withApi({ previewBulkOpeningBalances: vi.fn().mockResolvedValue({ ...PREVIEW, preview: { ...PREVIEW.preview, proposals: [proposal({}), proposal({ partyId: "p3", partyName: "B" })] } }), postBulkOpeningBalances });
    render(<BulkOpeningBalanceDialog side="CUSTOMER" onPosted={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Cutover date"), { target: { value: "2026-11-21" } });
    fireEvent.click(screen.getByRole("button", { name: "Work out balances" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Post the opening balance of B" }));
    fireEvent.click(screen.getByRole("button", { name: "Post 1 opening balance" }));
    fireEvent.click(screen.getByRole("button", { name: "Post 1 opening balance" }));
    expect(await screen.findByText(/not what was previewed any more/)).toBeInTheDocument();
    expect((postBulkOpeningBalances.mock.calls[0]?.[0] as { expected: Array<{ partyId: string }> }).expected.map((item) => item.partyId)).toEqual(["p1"]);
  });
});

const BATCH_STATEMENT = {
  id: "s1", batchId: "11111111-1111-4111-8111-111111111111", ledgerSide: "CUSTOMER", balanceRule: "DEBIT_LESS_CREDIT", originalPartyCode: "1301901", originalPartyName: "SYNTHETIC CUSTOMER ALPHA",
  periodFrom: "2026-05-31", periodTo: "2026-11-19", rowCount: 999, closingBalancePaisa: 548_210_500, sourceFileName: "synthetic-customer-1301901.xls", sourceDocumentName: null, sourceDocumentHash: null,
  importedBy: "accounts", importedAt: "2026-11-20T07:00:00.000Z", withdrawnAt: null, withdrawnBy: null, withdrawalReason: null,
};

describe("WithdrawArchiveDialog", () => {
  it("lists what the import wrote, needs a reason, withdraws once confirmed, and reloads the ledger on close", async () => {
    const withdrawLedgerArchiveBatch = vi.fn().mockResolvedValue({ accepted: true, result: { batchId: BATCH_STATEMENT.batchId, duplicate: false, statements: [{ ...BATCH_STATEMENT, withdrawnAt: "2026-11-20T08:00:00.000Z", withdrawnBy: "owner", withdrawalReason: "wrong period" }] } });
    withApi({ getLedgerArchiveBatch: vi.fn().mockResolvedValue({ accepted: true, statements: [BATCH_STATEMENT] }), withdrawLedgerArchiveBatch });
    const onWithdrawn = vi.fn();
    render(<WithdrawArchiveDialog batchId={BATCH_STATEMENT.batchId} onWithdrawn={onWithdrawn} onClose={vi.fn()} />);
    expect(await screen.findByText("synthetic-customer-1301901.xls")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Withdraw import" }));
    expect(await screen.findByText(/Say why this import is being withdrawn/)).toBeInTheDocument();
    expect(withdrawLedgerArchiveBatch).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "wrong period" } });
    fireEvent.click(screen.getByRole("button", { name: "Withdraw import" }));
    await screen.findByText("✓ Import withdrawn");
    expect(withdrawLedgerArchiveBatch).toHaveBeenCalledWith(expect.objectContaining({ batchId: BATCH_STATEMENT.batchId, reason: "wrong period" }));
    expect(onWithdrawn).not.toHaveBeenCalled();
    // The footer Close and the header close both reload: either one.
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]!);
    expect(onWithdrawn).toHaveBeenCalledTimes(1);
  });

  it("shows the refusal (an opening balance rests on it) and retries under the same request id", async () => {
    const withdrawLedgerArchiveBatch = vi.fn().mockResolvedValue({ accepted: false, reason: "SYNTHETIC CUSTOMER ALPHA's opening balance was checked against this import. Reverse it first. Nothing was changed." });
    withApi({ getLedgerArchiveBatch: vi.fn().mockResolvedValue({ accepted: true, statements: [BATCH_STATEMENT] }), withdrawLedgerArchiveBatch });
    render(<WithdrawArchiveDialog batchId={BATCH_STATEMENT.batchId} onWithdrawn={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText("Reason"), { target: { value: "wrong period" } });
    fireEvent.click(screen.getByRole("button", { name: "Withdraw import" }));
    expect(await screen.findByText(/Reverse it first/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Withdraw import" }));
    await waitFor(() => expect(withdrawLedgerArchiveBatch).toHaveBeenCalledTimes(2));
    const [first, second] = withdrawLedgerArchiveBatch.mock.calls.map((call) => (call[0] as { requestId: string }).requestId);
    expect(second).toBe(first);
  });

  it("says so when the import cannot be loaded, with a retry", async () => {
    withApi({ getLedgerArchiveBatch: vi.fn().mockResolvedValue({ accepted: false, reason: "Your account does not have Cash Voucher access." }) });
    render(<WithdrawArchiveDialog batchId={BATCH_STATEMENT.batchId} onWithdrawn={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByText(/does not have Cash Voucher access/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Withdraw import" })).toBeDisabled();
  });
});
