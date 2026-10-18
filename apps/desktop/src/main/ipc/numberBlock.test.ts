// @vitest-environment node
import type { IpcMainInvokeEvent } from "electron";
import type { NumberBlockStatus, NumberRange } from "@erp/data";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Authorizer, type SessionUser } from "../authorize";
import { IPC } from "../../shared/ipcChannels";
import { registerNumberBlockHandlers, type NumberBlockContext } from "./numberBlock";

// What the renderer can and cannot do to this computer's document-number range.
//
// The range decides which numbers this computer hands out, so three things have to hold at the
// process boundary: anyone signed in may READ the status, only an administrator may record a
// range, and a range typed in by hand reaches the data layer as a number and nothing else.
// Whether a particular range may be recorded is the data layer's rule — proved in @erp/data's
// numberRangeProvisioning tests — so here the database is a stand-in that answers or refuses on
// cue. The second computer's channel is deliberately separate from adoption: adoption proves
// from this computer's own data which machine it is, and assignment cannot, which is why one
// takes no range and the other takes one an administrator is answerable for.

const handlers = new Map<string, (event: IpcMainInvokeEvent) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: IpcMainInvokeEvent) => unknown) => {
      handlers.set(channel, handler);
    },
  },
}));

// The handlers only hand the event to the authoriser, which reads `event.sender.id` to find the
// session that window proved. A stand-in is enough, and keeps a real window out of the test.
const windowEvent = { sender: { id: 1 } } as unknown as IpcMainInvokeEvent;

const ADMIN: SessionUser = {
  id: "u-admin",
  username: "owner",
  role: "ADMIN",
  accessStatus: "APPROVED",
  permissions: [],
};
const CLERK: SessionUser = { ...ADMIN, id: "u-clerk", username: "babar", role: "USER" };

/** assignableRanges(): rangeForBlock for blocks 2-5, exactly as getNumberBlockStatus returns them. */
const ASSIGNABLE = [
  { block: 2, lo: 100_000, hi: 199_999 },
  { block: 3, lo: 200_000, hi: 299_999 },
  { block: 4, lo: 300_000, hi: 399_999 },
  { block: 5, lo: 400_000, hi: 499_999 },
];

const UNCONFIGURED: NumberBlockStatus = {
  block: null,
  range: null,
  confirmed: false,
  problem: "NOT_CONFIGURED",
  storedValue: null,
  adoption: {
    allowed: false,
    refusal: "NO_EXISTING_DATA",
    detail: "This is a new installation with no numbered documents.",
  },
  // What the data layer offers while nothing is recorded here: blocks 2-5, never 1.
  assignable: ASSIGNABLE,
};

const BLOCK_ONE: NumberBlockStatus = {
  block: 1,
  range: { block: 1, lo: 1, hi: 99_999 },
  confirmed: true,
  problem: null,
  storedValue: null,
  adoption: { allowed: false, refusal: "ALREADY_CONFIGURED", detail: "Already recorded." },
  // Nothing is offered once a range is recorded here: a range is never reassigned.
  assignable: [],
};

/** The refusal @erp/data throws. Rebuilt here because it arrives from a dynamically loaded module,
 *  which is exactly why the handler recognises it by shape rather than with `instanceof`. */
const refusal = (reason: string, message: string): Error =>
  Object.assign(new Error(message), { name: "NumberRangeError", reason });

let signedIn: SessionUser | null;
let status: NumberBlockStatus;
let adoptOutcome: NumberRange | Error;
let assignOutcome: NumberRange | Error;
let logged: Array<{ severity: string; operation: string }>;
let adoptedBy: string[];
/** Exactly what the data layer was asked to assign, and by whom. Types included: the boundary's
 *  job is to settle whatever the renderer sent into a number before the rule ever sees it. */
let assignCalls: Array<{ block: unknown; updatedBy: string }>;

// A window proves its session once, on sign-in; the authoriser remembers it against the window
// and every later handler resolves from that. The test binds the same way rather than passing a
// token the real handlers never take.
const boundAuthorizer = (): Authorizer => {
  const authorizer = new Authorizer(() => signedIn);
  authorizer.bind(windowEvent, "session-token");
  return authorizer;
};

const build = (): NumberBlockContext => ({
  db: {
    getNumberBlockStatus: () => status,
    adoptExistingDataNumberBlock: (updatedBy: string) => {
      adoptedBy.push(updatedBy);
      if (adoptOutcome instanceof Error) throw adoptOutcome;
      return adoptOutcome;
    },
    assignNumberBlock: (block: number, updatedBy: string) => {
      assignCalls.push({ block, updatedBy });
      if (assignOutcome instanceof Error) throw assignOutcome;
      return assignOutcome;
    },
  },
  logger: { log: (entry) => logged.push({ severity: entry.severity, operation: entry.operation }) },
  authorizer: boundAuthorizer(),
  deviceId: "device-under-test",
});

const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
  const handler = handlers.get(channel) as
    | ((event: IpcMainInvokeEvent, ...rest: unknown[]) => unknown)
    | undefined;
  if (!handler) throw new Error(`no handler registered for ${channel}`);
  return handler(windowEvent, ...args);
};

type RecordOutcome = Promise<{
  accepted: boolean;
  code?: string;
  reason?: string;
  range?: NumberRange;
}>;

const readStatus = () => invoke(IPC.getNumberBlockStatus) as Promise<NumberBlockStatus>;
const assign = (block?: unknown) => invoke(IPC.assignNumberBlock, block) as RecordOutcome;
const adopt = () =>
  invoke(IPC.adoptNumberBlock) as Promise<{
    accepted: boolean;
    code?: string;
    reason?: string;
    range?: NumberRange;
  }>;

beforeEach(() => {
  handlers.clear();
  signedIn = ADMIN;
  status = UNCONFIGURED;
  adoptOutcome = { block: 1, lo: 1, hi: 99_999 };
  assignOutcome = { block: 3, lo: 200_000, hi: 299_999 };
  logged = [];
  adoptedBy = [];
  assignCalls = [];
  registerNumberBlockHandlers(build());
});

describe("the document-number range at the process boundary", () => {
  it("exposes the status, the one-time adoption and the one-time assignment, and nothing else", () => {
    expect([...handlers.keys()].sort()).toEqual(
      [IPC.adoptNumberBlock, IPC.assignNumberBlock, IPC.getNumberBlockStatus].sort()
    );
  });

  it("hands back a missing configuration as it is, without recording anything", async () => {
    await expect(readStatus()).resolves.toEqual(UNCONFIGURED);
    await readStatus();
    expect(adoptedBy).toEqual([]);
    expect(logged).toEqual([]);
  });

  it("lets any signed-in user read the status", async () => {
    signedIn = CLERK;
    status = BLOCK_ONE;
    await expect(readStatus()).resolves.toEqual(BLOCK_ONE);
  });

  it("refuses to read the status when nobody is signed in", async () => {
    signedIn = null;
    await expect(readStatus()).rejects.toThrow(/sign in/i);
  });

  it("records the range for an administrator, under their name, and logs it", async () => {
    const accepted = await adopt();
    expect(accepted).toEqual({ accepted: true, range: { block: 1, lo: 1, hi: 99_999 } });
    expect(adoptedBy).toEqual(["owner"]);
    expect(logged).toEqual([{ severity: "CRITICAL", operation: "adopt-number-block" }]);
  });

  it("never lets an ordinary user record a range", async () => {
    signedIn = CLERK;
    const refused = await adopt();
    expect(refused.accepted).toBe(false);
    expect(refused.code).toBe("ADMIN_REQUIRED");
    expect(adoptedBy, "the database is never asked").toEqual([]);
  });

  it("never lets a signed-out window record a range", async () => {
    signedIn = null;
    expect((await adopt()).code).toBe("SESSION_REQUIRED");
    expect(adoptedBy).toEqual([]);
  });

  it("passes the data layer's refusal on with its reason, as a refusal rather than a crash", async () => {
    adoptOutcome = refusal("NO_EXISTING_DATA", "This is a new installation with no numbered documents.");
    const refused = await adopt();
    expect(refused).toEqual({
      accepted: false,
      code: "NO_EXISTING_DATA",
      reason: "This is a new installation with no numbered documents.",
    });
    expect(logged).toEqual([{ severity: "INFO", operation: "adopt-number-block" }]);
  });

  it("passes on a refused reassignment the same way", async () => {
    adoptOutcome = refusal("ALREADY_CONFIGURED", "This computer already has a range recorded.");
    expect((await adopt()).code).toBe("ALREADY_CONFIGURED");
  });

  it("passes on a refusal from numbers that do not fit the range", async () => {
    adoptOutcome = refusal("OUT_OF_RANGE", "This computer's existing documents do not all fit.");
    expect((await adopt()).code).toBe("OUT_OF_RANGE");
  });

  it("does not dress an unexpected fault up as a business refusal", async () => {
    adoptOutcome = new Error("disk is full");
    const failed = await adopt();
    expect(failed.accepted).toBe(false);
    expect(failed.code).toBeUndefined();
    expect(failed.reason).toBe("disk is full");
  });

  // A SECOND COMPUTER'S RANGE. The one thing on this channel that no computer can check is
  // whether the range it was handed is already in use elsewhere; the operator's written record
  // is the authority. What the boundary owes is therefore narrow and testable: only an
  // administrator, under their own name, with exactly the number that was typed, and a refusal
  // carried back as a refusal.
  describe("assigning a range to a second computer", () => {
    it("records the typed range under the administrator's name, and logs it as critical", async () => {
      const accepted = await assign(3);
      expect(accepted).toEqual({ accepted: true, range: { block: 3, lo: 200_000, hi: 299_999 } });
      expect(assignCalls).toEqual([{ block: 3, updatedBy: "owner" }]);
      expect(logged).toEqual([{ severity: "CRITICAL", operation: "assign-number-block" }]);
    });

    it("settles what the renderer sent into a number before the rule sees it", async () => {
      await assign("4");
      expect(assignCalls).toEqual([{ block: 4, updatedBy: "owner" }]);
    });

    it("hands nonsense to the rule as NaN rather than guessing a range", async () => {
      // Guessing here would be the one unrecoverable mistake on this channel: a range recorded
      // is never reassigned. NaN fails the data layer's 2-5 bound, which is where that rule lives.
      await assign("not a number");
      expect(assignCalls).toHaveLength(1);
      expect(Number.isNaN(assignCalls[0]?.block)).toBe(true);
    });

    it("refuses a clerk, and does not let the database see the range at all", async () => {
      signedIn = CLERK;
      const refused = await assign(3);
      expect(refused.accepted).toBe(false);
      expect(refused.code).toBe("ADMIN_REQUIRED");
      expect(assignCalls, "the database is never asked").toEqual([]);
    });

    it("refuses a signed-out window", async () => {
      signedIn = null;
      expect((await assign(3)).code).toBe("SESSION_REQUIRED");
      expect(assignCalls).toEqual([]);
    });

    it("carries the data layer's refusals back with their reasons", async () => {
      for (const [code, message] of [
        ["INVALID", "Block 1 belongs to the computer that holds the existing documents."],
        ["ALREADY_CONFIGURED", "This computer already has a range recorded."],
        ["OUT_OF_RANGE", "This computer already holds documents outside that range."],
      ] as const) {
        logged = [];
        assignCalls = [];
        assignOutcome = refusal(code, message);
        expect(await assign(3)).toEqual({ accepted: false, code, reason: message });
        expect(logged).toEqual([{ severity: "INFO", operation: "assign-number-block" }]);
      }
    });

    it("does not dress an unexpected fault up as a business refusal", async () => {
      assignOutcome = new Error("database is locked");
      const failed = await assign(3);
      expect(failed.accepted).toBe(false);
      expect(failed.code).toBeUndefined();
      expect(failed.reason).toBe("database is locked");
    });
  });
});
