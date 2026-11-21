// @vitest-environment node
import type { IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PERMISSION } from "@erp/domain";
import { Authorizer, type SessionUser } from "../authorize";
import { IPC } from "../../shared/ipcChannels";
import { LEASED_CHANNELS } from "../leaseChannels";
import { registerPartyOpeningBalanceHandlers, type OpeningBalanceContext } from "./partyOpeningBalances";

// WHO MAY SEE AND CHANGE AN OPENING BALANCE (docs/53), at the process boundary. What a posting does to the balances
// is proved in @erp/data against a real database; here the database is a stand-in that records what it was asked.

const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();

vi.mock("../leaseGuard", () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    },
  },
}));

const windowEvent = { sender: { id: 1 } } as unknown as IpcMainInvokeEvent;
const ADMIN: SessionUser = { id: "u-admin", username: "owner", role: "ADMIN", accessStatus: "APPROVED", permissions: [] };
const ACCOUNTS: SessionUser = { id: "u-acc", username: "babar", role: "USER", accessStatus: "APPROVED", permissions: [PERMISSION.CUSTOMER_LEDGER, PERMISSION.CASH_VOUCHER_FORM] };

const PARTIES: Record<string, { id: string; partyType: string }> = { c1: { id: "c1", partyType: "CUSTOMER" }, s1: { id: "s1", partyType: "SUPPLIER" } };
const VIEW = { partyId: "c1", version: 1, status: "POSTED" };

let signedIn: SessionUser | null;
let posted: Array<Record<string, unknown>>;
let announced: Array<readonly string[]>;

const build = (): OpeningBalanceContext => {
  const authorizer = new Authorizer(() => signedIn);
  authorizer.bind(windowEvent, "session-token");
  const db = {
    getParty: (id: string) => PARTIES[id] ?? null,
    getPartyOpeningBalance: () => VIEW,
    postPartyOpeningBalance: (input: Record<string, unknown>) => { posted.push(input); return VIEW; },
    reversePartyOpeningBalance: () => VIEW,
    correctPartyOpeningBalance: () => VIEW,
    partyLedgerReconciliation: (side: string) => ({ side, rows: [] }),
    previewBulkOpeningBalances: (side: string, cutoverDate: string) => ({ side, cutoverDate, proposals: [] }),
    postBulkOpeningBalances: (input: Record<string, unknown>) => { posted.push(input); return { duplicate: false, posted: 1, partyIds: ["c1"] }; },
  };
  return { db: db as unknown as OpeningBalanceContext["db"], logger: { log: () => undefined }, authorizer, deviceId: "device-under-test", announce: (kinds) => void announced.push(kinds) };
};

const invoke = async (channel: string, ...args: unknown[]): Promise<Record<string, unknown>> => {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no handler registered for ${channel}`);
  return (await handler(windowEvent, ...args)) as Record<string, unknown>;
};

beforeEach(() => {
  handlers.clear();
  signedIn = ADMIN;
  posted = [];
  announced = [];
  registerPartyOpeningBalanceHandlers(build());
});

describe("opening balances at the process boundary", () => {
  it("posting, correcting and reversing are writes under the ACCOUNTS lease", () => {
    for (const channel of [IPC.postPartyOpeningBalance, IPC.correctPartyOpeningBalance, IPC.reversePartyOpeningBalance]) {
      expect([...(LEASED_CHANNELS[channel] ?? [])]).toEqual(["ACCOUNTS"]);
    }
    expect(LEASED_CHANNELS[IPC.getPartyOpeningBalance]).toBeUndefined();
  });

  it("only an administrator posts, and who posted comes from the session, never the screen", async () => {
    await expect(invoke(IPC.postPartyOpeningBalance, { partyId: "c1", requestId: "r", actor: "someone-else", amountPaisa: 100 })).resolves.toMatchObject({ accepted: true });
    expect(posted[0]).toMatchObject({ partyId: "c1", actor: "owner", amountPaisa: 100 });
    signedIn = ACCOUNTS;
    await expect(invoke(IPC.postPartyOpeningBalance, { partyId: "c1" })).resolves.toMatchObject({ accepted: false });
    await expect(invoke(IPC.reversePartyOpeningBalance, { partyId: "c1" })).resolves.toMatchObject({ accepted: false });
    await expect(invoke(IPC.correctPartyOpeningBalance, { partyId: "c1" })).resolves.toMatchObject({ accepted: false });
    expect(posted).toHaveLength(1);
  });

  it("a customer's opening balance is read with Customer Ledger access, a supplier's with Supplier Ledger access", async () => {
    signedIn = ACCOUNTS;
    await expect(invoke(IPC.getPartyOpeningBalance, "c1")).resolves.toMatchObject({ accepted: true });
    await expect(invoke(IPC.getPartyOpeningBalance, "s1")).resolves.toMatchObject({ accepted: false });
    await expect(invoke(IPC.getLedgerReconciliation, "CUSTOMER")).resolves.toMatchObject({ accepted: true });
    await expect(invoke(IPC.getLedgerReconciliation, "SUPPLIER")).resolves.toMatchObject({ accepted: false });
    await expect(invoke(IPC.getPartyOpeningBalance, "nobody")).resolves.toMatchObject({ accepted: false });
  });

  it("every party at a cutover: an administrator's, under the ACCOUNTS lease, the date and figures passed on as sent", async () => {
    expect([...(LEASED_CHANNELS[IPC.postBulkOpeningBalances] ?? [])]).toEqual(["ACCOUNTS"]);
    expect(LEASED_CHANNELS[IPC.previewBulkOpeningBalances]).toBeUndefined();
    await expect(invoke(IPC.previewBulkOpeningBalances, "SUPPLIER", "2026-11-21")).resolves.toMatchObject({ accepted: true, preview: { side: "SUPPLIER", cutoverDate: "2026-11-21" } });
    const expected = [{ partyId: "c1", direction: "DEBIT", amountPaisa: 100, archiveStatementId: "st", extra: "dropped" }];
    await expect(invoke(IPC.postBulkOpeningBalances, { requestId: "r", side: "CUSTOMER", cutoverDate: "2026-11-21", expected, actor: "someone-else" })).resolves.toMatchObject({ accepted: true });
    expect(posted[0]).toEqual({ requestId: "r", side: "CUSTOMER", cutoverDate: "2026-11-21", expected: [{ partyId: "c1", direction: "DEBIT", amountPaisa: 100, archiveStatementId: "st" }], actor: "owner" });
    // Open ledgers are told, so the selected party's Opening balance panel reloads (useOpeningBalance listens for CASH).
    expect(announced).toEqual([["CASH"]]);
    signedIn = ACCOUNTS;
    await expect(invoke(IPC.previewBulkOpeningBalances, "CUSTOMER", "2026-11-21")).resolves.toMatchObject({ accepted: false });
    await expect(invoke(IPC.postBulkOpeningBalances, { requestId: "r2", side: "CUSTOMER", cutoverDate: "2026-11-21", expected })).resolves.toMatchObject({ accepted: false });
    expect(posted).toHaveLength(1);
    expect(announced).toHaveLength(1);
  });
});
