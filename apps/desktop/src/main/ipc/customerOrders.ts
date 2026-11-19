// Customer orders and Pending Orders (docs/52; data layer, database/customerOrders.ts and pendingOrders.ts).
//
//   saveCustomerOrder        a new order: every line, or none
//   editCustomerOrder        the order said again, from the revision shown
//   cancelCustomerOrder      the order closed, with a reason
//   getCustomerOrder         one order by number (or the newest), with the numbers either side
//   getCustomerOrderArticle  one article's live colours and sizes, for the entry grid
//   listPendingOrderParties  Pending Orders: one row per party, a page at a time
//   listPendingOrderLines    Pending Orders: one party's products
//
// WHO. Three permissions, given to nobody by default (an administrator holds them): orders-enter to save and edit,
// orders-cancel to cancel, pending-orders to read. Writes are made only where SALES_DISPATCH is held (leaseChannels.ts),
// the computer that makes gatepasses, so a gatepass allocates against every order there is. Nothing the screen sends is
// trusted: who wrote it comes from the session; the party, every line and the revision are checked again by the data
// layer inside its write lock.
//
// Orders move no stock, money or ledger. A gatepass's allocation is written by the gatepass's own use cases, not here.

import type { IpcMainInvokeEvent } from "electron";
import { ipcMain } from "../leaseGuard";
import { IPC } from "../../shared/ipcChannels";
import type { IpcContext } from "./context";
import { CUSTOMER_ORDER_MAX_LINES, PERMISSION, asRecord, asString, isPendingOrderFilter, type PermissionCode } from "@erp/domain";
import { CustomerOrderRefused } from "@erp/data";
import { rejection } from "../authorize";
import { isDatabaseBusy } from "../writeRefusal";

/** What an operator is told. One place, for translation later (R21). */
export const CUSTOMER_ORDER_MESSAGES = {
  BUSY: "The order was not saved because another operation is in progress. Nothing was changed. Please try again.",
  NOT_SAVED: "The order could not be saved. Nothing was changed.",
  NOT_LOADED: "Orders could not be loaded. Try again.",
  NOT_ALLOWED_ENTER: "Your account cannot enter orders. Ask an administrator for Enter Orders access.",
  NOT_ALLOWED_CANCEL: "Your account cannot cancel orders. Ask an administrator.",
  NOT_ALLOWED_VIEW: "Your account does not have Pending Orders access.",
  TOO_MANY: `One order may hold at most ${String(CUSTOMER_ORDER_MAX_LINES)} lines. Split it into two orders.`,
} as const;

/** Reading an order or its grid: anyone who may view pending orders, enter them or cancel them. */
const READ_ACCESS: readonly PermissionCode[] = [PERMISSION.ORDERS_VIEW, PERMISSION.ORDERS_ENTER, PERMISSION.ORDERS_CANCEL];

/** The lines as sent, each field read as text. More than the limit is refused before anything is read. */
const linesOf = (value: unknown) => {
  const lines = Array.isArray(value) ? value : [];
  if (lines.length > CUSTOMER_ORDER_MAX_LINES) throw new CustomerOrderRefused(CUSTOMER_ORDER_MESSAGES.TOO_MANY);
  return lines.map((line) => {
    const fields = asRecord(line);
    return { productVariantId: asString(fields.productVariantId), quantity: fields.quantity };
  });
};

const bodyOf = (fields: Record<string, unknown>) => ({ partyId: asString(fields.partyId), note: asString(fields.note) || null, lines: linesOf(fields.lines) });

const positiveInteger = (value: unknown): number | null => {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
};

export function registerCustomerOrderHandlers(ctx: IpcContext): void {
  const { db, logger, authorizer, deviceId } = ctx;

  const log = (severity: "INFO" | "WARNING" | "ERROR", operation: string, message: string, userId?: string) =>
    logger.log({ module: "customer-orders", severity, operation, deviceId, userId, message });

  /** The signed-in user `check` accepts, or the refusal to answer with. */
  const who = (check: () => ReturnType<typeof authorizer.requirePermission>, denied: string) => {
    try {
      return { ok: true as const, user: check() };
    } catch (error) {
      return { ok: false as const, ...rejection(error, denied) };
    }
  };
  const enterer = (event: IpcMainInvokeEvent, opts: unknown) =>
    who(() => authorizer.requirePermission(event, PERMISSION.ORDERS_ENTER, asRecord(opts).token), CUSTOMER_ORDER_MESSAGES.NOT_ALLOWED_ENTER);
  const canceller = (event: IpcMainInvokeEvent, opts: unknown) =>
    who(() => authorizer.requirePermission(event, PERMISSION.ORDERS_CANCEL, asRecord(opts).token), CUSTOMER_ORDER_MESSAGES.NOT_ALLOWED_CANCEL);
  const reader = (event: IpcMainInvokeEvent, opts: unknown) =>
    who(() => authorizer.requireAnyPermission(event, READ_ACCESS, asRecord(opts).token), CUSTOMER_ORDER_MESSAGES.NOT_ALLOWED_VIEW);

  /** Runs one write and answers with the order, or with why nothing was written. Only the data layer's own refusals are shown as they are. */
  const write = (operation: string, user: { id: string }, run: () => unknown) => {
    try {
      const order = run();
      log("INFO", operation, JSON.stringify({ ok: true }), user.id);
      return { accepted: true, order };
    } catch (error) {
      const reason = error instanceof CustomerOrderRefused ? error.message : isDatabaseBusy(error) ? CUSTOMER_ORDER_MESSAGES.BUSY : CUSTOMER_ORDER_MESSAGES.NOT_SAVED;
      log(error instanceof CustomerOrderRefused ? "WARNING" : "ERROR", operation, error instanceof Error ? error.message : String(error), user.id);
      return { accepted: false, reason };
    }
  };

  /** Runs one read; a failure is logged and answered NOT_LOADED. */
  const read = (operation: string, user: { id: string }, run: () => Record<string, unknown>) => {
    try {
      return { accepted: true, ...run() };
    } catch (error) {
      log("ERROR", operation, error instanceof Error ? error.message : String(error), user.id);
      return { accepted: false, reason: CUSTOMER_ORDER_MESSAGES.NOT_LOADED };
    }
  };

  const actorOf = (user: { id: string; username: string }) => ({ actor: user.username, actorUserId: user.id, deviceId });

  ipcMain.handle(IPC.saveCustomerOrder, (event, input?: unknown, opts?: unknown) => {
    const auth = enterer(event, opts);
    if (!auth.ok) return { accepted: false, reason: auth.reason };
    const fields = asRecord(input);
    return write("save", auth.user, () => db.saveCustomerOrder({ requestId: asString(fields.requestId), ...bodyOf(fields), ...actorOf(auth.user) }).order);
  });

  ipcMain.handle(IPC.editCustomerOrder, (event, input?: unknown, opts?: unknown) => {
    const auth = enterer(event, opts);
    if (!auth.ok) return { accepted: false, reason: auth.reason };
    const fields = asRecord(input);
    return write("edit", auth.user, () =>
      db.editCustomerOrder({ orderId: asString(fields.orderId), revision: Number(fields.revision), ...bodyOf(fields), ...actorOf(auth.user) }).order
    );
  });

  ipcMain.handle(IPC.cancelCustomerOrder, (event, input?: unknown, opts?: unknown) => {
    const auth = canceller(event, opts);
    if (!auth.ok) return { accepted: false, reason: auth.reason };
    const fields = asRecord(input);
    return write("cancel", auth.user, () =>
      db.cancelCustomerOrder({ orderId: asString(fields.orderId), revision: Number(fields.revision), reason: asString(fields.reason), ...actorOf(auth.user) })
    );
  });

  ipcMain.handle(IPC.getCustomerOrder, (event, orderNumber?: unknown, opts?: unknown) => {
    const auth = reader(event, opts);
    if (!auth.ok) return { accepted: false, reason: auth.reason };
    return read("read", auth.user, () => ({ view: db.customerOrderView(positiveInteger(orderNumber)) }));
  });

  ipcMain.handle(IPC.getCustomerOrderArticle, (event, article?: unknown, opts?: unknown) => {
    const auth = reader(event, opts);
    if (!auth.ok) return { accepted: false, reason: auth.reason };
    return read("article", auth.user, () => ({ products: db.customerOrderArticle(asString(article)) }));
  });

  ipcMain.handle(IPC.listPendingOrderParties, (event, query?: unknown, opts?: unknown) => {
    const auth = reader(event, opts);
    if (!auth.ok) return { accepted: false, reason: auth.reason };
    const fields = asRecord(query);
    const filter = isPendingOrderFilter(fields.filter) ? fields.filter : undefined;
    return read("pending-parties", auth.user, () => ({
      page: db.pendingOrderParties({ search: asString(fields.search), filter, page: positiveInteger(fields.page) ?? 1, pageSize: positiveInteger(fields.pageSize) ?? undefined }),
    }));
  });

  ipcMain.handle(IPC.listPendingOrderLines, (event, partyId?: unknown, query?: unknown, opts?: unknown) => {
    const auth = reader(event, opts);
    if (!auth.ok) return { accepted: false, reason: auth.reason };
    const fields = asRecord(query);
    const filter = isPendingOrderFilter(fields.filter) ? fields.filter : undefined;
    return read("pending-lines", auth.user, () => ({ lines: db.pendingOrderPartyLines(asString(partyId), { search: asString(fields.search), filter }) }));
  });
}
