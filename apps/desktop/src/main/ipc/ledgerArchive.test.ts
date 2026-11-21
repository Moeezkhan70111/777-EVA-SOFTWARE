// @vitest-environment node
import type { IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PERMISSION } from "@erp/domain";
import { Authorizer, type SessionUser } from "../authorize";
import { IPC } from "../../shared/ipcChannels";
import { LEASED_CHANNELS } from "../leaseChannels";
import type { IpcContext } from "./context";
import { registerLedgerArchiveHandlers } from "./ledgerArchive";

// THE OLD LEDGER IMPORT AT THE PROCESS BOUNDARY (docs/50, 53): what each statement of a several-file import carries
// through, and who may withdraw an import. What they do to the data is proved in @erp/data against a real database.

const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();

vi.mock("electron", () => ({ shell: { openPath: async () => "" } }));
vi.mock("../leaseGuard", () => ({
  ipcMain: { handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => void handlers.set(channel, handler) },
}));

const windowEvent = { sender: { id: 1 } } as unknown as IpcMainInvokeEvent;
const ADMIN: SessionUser = { id: "u-admin", username: "owner", role: "ADMIN", accessStatus: "APPROVED", permissions: [] };
const ACCOUNTS: SessionUser = { id: "u-acc", username: "babar", role: "USER", accessStatus: "APPROVED", permissions: [PERMISSION.CASH_VOUCHER_FORM] };
const HASH = "a".repeat(64);
const REPORT = { title: "Supplier Ledger Report", side: "SUPPLIER", partyCode: "1201903", partyName: "FOXTROT", periodFrom: "2026-09-01", periodTo: "2026-11-20", printedTotals: { quantity: "140", debit: "0", credit: "123000", closing: "-123000" } };

let signedIn: SessionUser | null;
let calls: Array<{ method: string; input: Record<string, unknown> }>;
let announced: Array<readonly string[]>;

const build = (): IpcContext => {
  const authorizer = new Authorizer(() => signedIn);
  authorizer.bind(windowEvent, "session-token");
  const record = (method: string) => (input: Record<string, unknown>) => {
    calls.push({ method, input });
    return method === "withdraw" ? { batchId: input.batchId, duplicate: false, statements: [] } : { alreadyImported: null, statements: [] };
  };
  const db = { previewLedgerArchiveImport: record("preview"), withdrawLedgerArchiveBatch: record("withdraw"), getLedgerArchiveBatch: () => [] };
  return { db, logger: { log: () => undefined }, authorizer, deviceId: "device-under-test", paths: { dataRoot: "C:/nowhere" }, announce: (kinds: readonly string[]) => void announced.push(kinds) } as unknown as IpcContext;
};

const invoke = async (channel: string, ...args: unknown[]): Promise<Record<string, unknown>> => {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no handler registered for ${channel}`);
  return (await handler(windowEvent, ...args)) as Record<string, unknown>;
};

beforeEach(() => {
  handlers.clear();
  signedIn = ACCOUNTS;
  calls = [];
  announced = [];
  registerLedgerArchiveHandlers(build());
});

describe("the old ledger import at the process boundary", () => {
  it("each statement keeps its own side, file and report; nothing else the screen sends is carried", async () => {
    const statements = [
      { rows: [], side: "SUPPLIER", sourceFile: { name: "foxtrot.xls", hash: HASH, path: "C:/x" }, report: { ...REPORT, extra: "dropped" } },
      { rows: [], side: "SIDEWAYS", sourceFile: { name: "bad.csv", hash: "not-a-hash" } },
    ];
    await expect(invoke(IPC.previewLedgerArchive, { side: "CUSTOMER", fileHash: "", statements })).resolves.toMatchObject({ accepted: true });
    const sent = calls[0]?.input.statements as Array<Record<string, unknown>>;
    expect(sent[0]).toMatchObject({ side: "SUPPLIER", sourceFile: { name: "foxtrot.xls", hash: HASH }, report: REPORT });
    expect(sent[0]?.report).not.toHaveProperty("extra");
    expect(sent[0]?.sourceFile).not.toHaveProperty("path");
    expect(sent[1]).toMatchObject({ side: undefined, sourceFile: null, report: null });
  });

  it("a report whose details cannot be read is refused, not half-read", async () => {
    const statements = [{ rows: [], report: { ...REPORT, side: "BOTH" } }];
    await expect(invoke(IPC.previewLedgerArchive, { statements })).resolves.toMatchObject({ accepted: false, reason: expect.stringMatching(/report details could not be read/) });
    expect(calls).toHaveLength(0);
  });

  it("withdrawing an import is an administrator's, under the ACCOUNTS lease, and who withdrew comes from the session", async () => {
    expect([...(LEASED_CHANNELS[IPC.withdrawLedgerArchiveBatch] ?? [])]).toEqual(["ACCOUNTS"]);
    expect(LEASED_CHANNELS[IPC.getLedgerArchiveBatch]).toBeUndefined();
    await expect(invoke(IPC.withdrawLedgerArchiveBatch, { requestId: "r", batchId: "b", reason: "wrong period" })).resolves.toMatchObject({ accepted: false });
    expect(calls).toHaveLength(0);
    expect(announced).toEqual([]);
    signedIn = ADMIN;
    await expect(invoke(IPC.withdrawLedgerArchiveBatch, { requestId: "r", batchId: "b", reason: "wrong period", actor: "someone-else" })).resolves.toMatchObject({ accepted: true });
    expect(calls[0]).toEqual({ method: "withdraw", input: { requestId: "r", batchId: "b", reason: "wrong period", actor: "owner" } });
    // Open ledgers reload their archive and reconciliation (useLedgerArchive listens for BILLING).
    expect(announced).toEqual([["BILLING"]]);
  });
});
