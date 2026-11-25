// @vitest-environment node
import type { IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACCESS_STATUS, PERMISSION, USER_ROLE } from "@erp/domain";
import { Authorizer, type SessionUser } from "../authorize";
import { IPC } from "../../shared/ipcChannels";
import { MAX_PARTIES_IN_LIST, registerPartiesHandlers } from "./parties";
import type { IpcContext } from "./context";

// PASTE PARTIES at the process boundary (owner, 25 Nov 2026), with the real Authorizer: only the Party Form permission
// adds them, and the list is checked before the database sees it. The lease (PC1) is leaseChannels.test.ts's; what
// the database does with the list is @erp/data's partiesFromList.test.

const { handlers, register } = vi.hoisted(() => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const register = (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => { handlers.set(channel, handler); };
  return { handlers, register };
});
vi.mock("electron", () => ({ ipcMain: { handle: register } }));
vi.mock("../leaseGuard", () => ({ ipcMain: { handle: register } }));

const event = { sender: { id: 1 } } as unknown as IpcMainInvokeEvent;
const addPartiesFromList = vi.fn(() => ({ created: [{ partyName: "QZ Hyderabad", partyCode: "PTY-000101" }], skipped: [] }));
let signedIn: SessionUser | null = null;
const signIn = (permissions: string[]) => { signedIn = { id: "u-1", username: "accounts", role: USER_ROLE.USER, accessStatus: ACCESS_STATUS.APPROVED, permissions }; };
const send = (input: unknown) => handlers.get(IPC.addPartiesFromList)?.(event, input) as { accepted: boolean; reason?: string; code?: string };
const LIST = { rows: [{ partyName: "QZ Hyderabad", partyNameUrdu: "حیدرآباد QZ" }], city: "Hyderabad", groupName: "Hyderabad", partyType: "CUSTOMER" };

beforeEach(() => {
  handlers.clear();
  addPartiesFromList.mockClear();
  signedIn = null;
  const authorizer = new Authorizer(() => signedIn);
  authorizer.bind(event, "token-1");
  const logger = { log: vi.fn() };
  registerPartiesHandlers({ db: { addPartiesFromList }, logger, authorizer, deviceId: "pc1", useCases: {} } as unknown as IpcContext);
});

describe("Paste parties", () => {
  it("adds the list for someone with the Party Form permission", () => {
    signIn([PERMISSION.PARTY_FORM]);
    expect(send(LIST)).toMatchObject({ accepted: true, created: [{ partyCode: "PTY-000101" }] });
    expect(addPartiesFromList).toHaveBeenCalledWith(LIST);
  });

  it("refuses anyone without it, before the database is touched", () => {
    signIn([]);
    expect(send(LIST).accepted).toBe(false);
    expect(addPartiesFromList).not.toHaveBeenCalled();
  });

  it("refuses an empty list, a blank name, an unknown party type and a list too long", () => {
    signIn([PERMISSION.PARTY_FORM]);
    expect(send({ ...LIST, rows: [] }).accepted).toBe(false);
    expect(send({ ...LIST, rows: [{ partyName: "  ", partyNameUrdu: "x" }] }).accepted).toBe(false);
    expect(send({ ...LIST, partyType: "FRIEND" }).accepted).toBe(false);
    expect(send({ ...LIST, rows: Array.from({ length: MAX_PARTIES_IN_LIST + 1 }, (_, index) => ({ partyName: `P${index}`, partyNameUrdu: "" })) }).accepted).toBe(false);
    expect(addPartiesFromList).not.toHaveBeenCalled();
  });
});
