// @vitest-environment node
import type { IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACCESS_STATUS, PERMISSION, RAW_MATERIAL_KIND, USER_ROLE } from "@erp/domain";
import { Authorizer, type SessionUser } from "../authorize";
import { IPC } from "../../shared/ipcChannels";
import { registerRawMaterialsHandlers } from "./rawMaterials";
import type { IpcContext } from "./context";

// UPPER STOCK AND DANA STOCK, at the process boundary, with the real Authorizer. Hiding a card
// is not a security boundary: this is. What the list holds is proved in @erp/data (kindStock.test).

const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    },
  },
}));

const event = { sender: { id: 1 } } as unknown as IpcMainInvokeEvent;
const listKindStock = vi.fn(() => ({ kind: "UPPER", items: [], itemCount: 0, totalsByUnit: [], page: 1, pages: 1 }));
const listUpperStockMatrix = vi.fn(() => ({ articles: [], articleCount: 0, page: 1, pages: 1 }));
let signedIn: SessionUser | null = null;

const signIn = (permissions: string[], role: SessionUser["role"] = USER_ROLE.USER, accessStatus: SessionUser["accessStatus"] = ACCESS_STATUS.APPROVED) => {
  signedIn = { id: "u-1", username: "aslam", role, accessStatus, permissions };
};

const read = (kind: unknown, query?: unknown) => handlers.get(IPC.listKindStock)?.(event, kind, query) as { accepted: boolean; code?: string; reason?: string };

beforeEach(() => {
  handlers.clear();
  listKindStock.mockClear();
  listUpperStockMatrix.mockClear();
  signedIn = null;
  const authorizer = new Authorizer(() => signedIn);
  authorizer.bind(event, "token-1");
  registerRawMaterialsHandlers({ db: { listKindStock, listUpperStockMatrix }, authorizer, useCases: {} } as unknown as IpcContext);
});

describe("listKindStock authorisation", () => {
  it("opens each page to its own permission and not to the other's", () => {
    signIn([PERMISSION.STOCK_UPPER_VIEW]);
    expect(read(RAW_MATERIAL_KIND.UPPER).accepted).toBe(true);
    expect(read(RAW_MATERIAL_KIND.DANA)).toMatchObject({ accepted: false, code: "PERMISSION_DENIED" });

    signIn([PERMISSION.STOCK_DANA_VIEW]);
    expect(read(RAW_MATERIAL_KIND.DANA).accepted).toBe(true);
    expect(read(RAW_MATERIAL_KIND.UPPER)).toMatchObject({ accepted: false, code: "PERMISSION_DENIED" });
  });

  it("opens both to a profile holding both", () => {
    signIn([PERMISSION.STOCK_UPPER_VIEW, PERMISSION.STOCK_DANA_VIEW]);
    expect(read(RAW_MATERIAL_KIND.UPPER).accepted).toBe(true);
    expect(read(RAW_MATERIAL_KIND.DANA).accepted).toBe(true);
  });

  it("is not opened by the general Stock permission, or the store's", () => {
    signIn([PERMISSION.STOCK, PERMISSION.STORE_SCANNING, PERMISSION.RAW_MATERIAL_SETUP]);
    expect(read(RAW_MATERIAL_KIND.UPPER)).toMatchObject({ accepted: false, code: "PERMISSION_DENIED" });
    expect(read(RAW_MATERIAL_KIND.DANA)).toMatchObject({ accepted: false, code: "PERMISSION_DENIED" });
    expect(listKindStock).not.toHaveBeenCalled();
  });

  it("refuses nobody signed in, and anyone still waiting for access", () => {
    expect(read(RAW_MATERIAL_KIND.UPPER)).toMatchObject({ accepted: false, code: "SESSION_REQUIRED" });
    signIn([PERMISSION.STOCK_UPPER_VIEW], USER_ROLE.USER, ACCESS_STATUS.PENDING);
    expect(read(RAW_MATERIAL_KIND.UPPER)).toMatchObject({ accepted: false, code: "ACCESS_NOT_APPROVED" });
    expect(listKindStock).not.toHaveBeenCalled();
  });

  it("lets an administrator read both, as everywhere else", () => {
    signIn([], USER_ROLE.ADMIN);
    expect(read(RAW_MATERIAL_KIND.UPPER).accepted).toBe(true);
    expect(read(RAW_MATERIAL_KIND.DANA).accepted).toBe(true);
  });

  it("turns away any other category, whatever the caller holds", () => {
    signIn([], USER_ROLE.ADMIN);
    for (const kind of ["CARTON", "upper", "", undefined, null, 7, "__proto__", "constructor"]) {
      expect(read(kind).accepted, String(kind)).toBe(false);
    }
    expect(listKindStock).not.toHaveBeenCalled();
  });

  it("passes on only the search and the page", () => {
    signIn([PERMISSION.STOCK_UPPER_VIEW]);
    read(RAW_MATERIAL_KIND.UPPER, { search: "black", page: 2, pageSize: 20, categoryId: "something-else" });
    expect(listKindStock).toHaveBeenCalledWith(RAW_MATERIAL_KIND.UPPER, { search: "black", page: 2, pageSize: 20 });
  });
});

describe("listUpperStockMatrix authorisation", () => {
  const matrix = (query?: unknown) => handlers.get(IPC.listUpperStockMatrix)?.(event, query) as { accepted: boolean; code?: string };

  it("opens to Upper Stock's permission and nothing else", () => {
    signIn([PERMISSION.STOCK_UPPER_VIEW]);
    expect(matrix().accepted).toBe(true);

    signIn([PERMISSION.STOCK_DANA_VIEW, PERMISSION.STOCK, PERMISSION.STORE_SCANNING]);
    expect(matrix()).toMatchObject({ accepted: false, code: "PERMISSION_DENIED" });
  });

  it("refuses nobody signed in", () => {
    expect(matrix()).toMatchObject({ accepted: false, code: "SESSION_REQUIRED" });
    expect(listUpperStockMatrix).not.toHaveBeenCalled();
  });

  it("lets through only a known category and sort", () => {
    signIn([PERMISSION.STOCK_UPPER_VIEW]);
    matrix({ category: "PVC UPPER", sort: "STOCK_DESC", search: "sk6", page: 2 });
    expect(listUpperStockMatrix).toHaveBeenLastCalledWith({ category: "PVC UPPER", sort: "STOCK_DESC", search: "sk6", page: 2 });

    matrix({ category: "DANA", sort: "DROP" });
    expect(listUpperStockMatrix).toHaveBeenLastCalledWith({ category: undefined, sort: undefined, search: undefined, page: undefined });
  });
});
