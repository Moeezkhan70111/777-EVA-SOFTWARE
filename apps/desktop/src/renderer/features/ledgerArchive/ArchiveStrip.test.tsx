import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SessionProvider } from "../auth/SessionContext";
import type { AuthUser } from "../../types/desktopApi";
import type { ArchiveStatement } from "./archiveReplies";
import { ArchiveStrip } from "./ArchiveStrip";

// The old software's figures on a ledger (docs/53): an administrator sees one withdraw button per import, each naming
// in plain words the file it brought in and when, so two imports are never confused. Nobody else sees them.

const statement = (fields: Partial<ArchiveStatement>): ArchiveStatement => ({
  id: "s1", batchId: "b1", ledgerSide: "CUSTOMER", balanceRule: "DEBIT_LESS_CREDIT", originalPartyCode: "1301901", originalPartyName: "SYNTHETIC CUSTOMER ALPHA",
  periodFrom: "2026-06-01", periodTo: "2026-09-30", rowCount: 10, closingBalancePaisa: 100, sourceFileName: "first.xls", sourceDocumentName: null, sourceDocumentHash: null,
  importedBy: "accounts", importedAt: "2026-11-20T07:00:00.000Z", withdrawnAt: null, withdrawnBy: null, withdrawalReason: null, ...fields,
});
const TWO_IMPORTS = [statement({}), statement({ id: "s2", batchId: "b2", sourceFileName: "second.xls", periodFrom: "2026-10-01", periodTo: "2026-11-20", importedAt: "2026-11-21T09:30:00.000Z" })];
const SUMMARY = { rows: 0, debitPaisa: 0, creditPaisa: 0, quantity: 0, lastBalancePaisa: null, lastDate: null };
const user = (role: "ADMIN" | "USER"): AuthUser => ({ id: "u1", username: "owner", role, accessStatus: "APPROVED", permissions: [], lastLoginAt: null });

const renderStrip = (role: "ADMIN" | "USER") => {
  Object.defineProperty(window, "desktop", { value: { versions: { node: "22", chrome: "128", electron: "43" }, api: {} }, configurable: true });
  return render(
    <SessionProvider user={user(role)} token="t">
      <ArchiveStrip state={{ status: "ready", view: { statements: TWO_IMPORTS, entries: [] } }} summary={SUMMARY} statements={TWO_IMPORTS} onRetry={() => undefined} />
    </SessionProvider>
  );
};

describe("ArchiveStrip withdraw buttons", () => {
  it("names each import's file and time in the button's own words", () => {
    renderStrip("ADMIN");
    const buttons = screen.getAllByRole("button", { name: /^Withdraw / });
    expect(buttons.map((button) => button.textContent)).toEqual([expect.stringMatching(/^Withdraw first\.xls \(imported .+\)…$/), expect.stringMatching(/^Withdraw second\.xls \(imported .+\)…$/)]);
    expect(new Set(buttons.map((button) => button.textContent)).size).toBe(2);
  });

  it("shows none to anyone but an administrator", () => {
    renderStrip("USER");
    expect(screen.queryAllByRole("button", { name: /^Withdraw / })).toEqual([]);
  });
});
