import { useCallback, useEffect, useState } from "react";
import { copy } from "../../config/copy";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { useRequestId } from "../../hooks/useRequestId";
import { useNotifications } from "../../state/NotificationsContext";
import { leaseRefusalText } from "../../../shared/leaseRefusal";
import type { CustomerOrder, CustomerOrderArticleProduct, CustomerOrderView } from "../../types/desktopApi";
import { draftFromOrder, draftLines } from "./orderDraft";
import { parseOrderReply, parseOrderViewReply, type Reply } from "./orderReply";
import { useOrderDraft } from "./useOrderDraft";

// The Enter Orders page's document: which order is on screen, where it sits in the run, and what can be done.
//
//   NEW    an order being typed. ◄ goes to the newest stored one.
//   VIEW   a stored order, read by number, with what was dispatched against it. Edit and Cancel while it is open.
//   EDIT   the stored order back in the draft, saved from the revision shown.
//
// Every write answers with the order as it now stands, and the screen shows that, never its own idea of it. Save is
// one request id per press (useRequestId), so a retry after a lost answer finds the order it already made.

export type OrderMode = "new" | "view" | "edit";

const REQUEST_KEY = "orders.pending-request";
const words = copy.orders;
type Neighbours = Omit<CustomerOrderView, "order">;
const NO_NEIGHBOURS: Neighbours = { previousNumber: null, nextNumber: null, latestNumber: null };

/** An answer that never came (thrown) is read as a refusal the screen can show. */
const refusedBy = (error: unknown) => ({ accepted: false, reason: leaseRefusalText(error) ?? (error instanceof Error ? error.message : words.loadFailed) });

export const useOrderEntry = (token: string) => {
  const api = useDesktopApi();
  const { push } = useNotifications();
  const request = useRequestId(REQUEST_KEY);
  const entry = useOrderDraft(token);
  const [mode, setMode] = useState<OrderMode>("new");
  const [order, setOrder] = useState<CustomerOrder | null>(null);
  const [neighbours, setNeighbours] = useState<Neighbours>(NO_NEIGHBOURS);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The order just saved here (peak-end rule, 24 Nov 2026): its page opens with a "saved" banner and the next step. */
  const [savedOrderId, setSavedOrderId] = useState<string | null>(null);

  const read = useCallback(
    async (orderNumber: number | null): Promise<CustomerOrderView | null> => {
      const reply = parseOrderViewReply(await api.getCustomerOrder(orderNumber, { token }).catch(() => null));
      if (!reply.accepted) { setLoadError(reply.reason); return null; }
      setLoadError(null);
      setNeighbours({ previousNumber: reply.value.previousNumber, nextNumber: reply.value.nextNumber, latestNumber: reply.value.latestNumber });
      return reply.value;
    },
    [api, token]
  );

  const { reset } = entry;
  const startNew = useCallback(async () => {
    setLoading(true);
    setSavedOrderId(null);
    request.renew();
    const view = await read(null);
    if (view) setNeighbours({ previousNumber: view.latestNumber, nextNumber: null, latestNumber: view.latestNumber });
    setOrder(null);
    reset();
    setMode("new");
    setLoading(false);
  }, [read, request, reset]);

  useEffect(() => { void startNew(); }, [startNew]);

  const show = (stored: CustomerOrder) => { setOrder(stored); setMode("view"); };

  const goTo = async (orderNumber: number) => {
    setBusy(true);
    setSavedOrderId(null);
    const view = await read(orderNumber);
    setBusy(false);
    if (!view) return;
    if (!view.order) { push("warning", copy.toast.notFound, words.notFound(orderNumber)); return; }
    show(view.order);
  };

  /** The stored order back in the draft, with every article's live colours and sizes read again. */
  const startEdit = async () => {
    if (!order) return;
    setSavedOrderId(null);
    setBusy(true);
    const articles = [...new Set(order.lines.map((line) => line.article))];
    const products = new Map<string, CustomerOrderArticleProduct[]>();
    for (const article of articles) products.set(article, (await entry.productsOf(article)) ?? []);
    entry.setDraft(draftFromOrder(order, (article) => products.get(article) ?? []));
    setBusy(false);
    setMode("edit");
  };

  /** Sends one write and shows the order it answers with. */
  const write = async (send: () => Promise<unknown>): Promise<Reply<CustomerOrder>> => {
    setBusy(true);
    try {
      const reply = parseOrderReply(await send().catch(refusedBy));
      if (reply.accepted) { show(reply.value); await read(reply.value.orderNumber); }
      return reply;
    } finally {
      setBusy(false);
    }
  };

  const body = () => ({ partyId: entry.draft.partyId, note: entry.draft.note.trim() || null, lines: draftLines(entry.draft) });

  const save = async () => {
    const requestId = request.start();
    if (requestId === null) return;
    const reply = await write(() => api.saveCustomerOrder({ ...body(), requestId }, { token }));
    if (reply.accepted) { request.settle({ renew: true }); setSavedOrderId(reply.value.id); }
    else { request.unanswered(); push("error", copy.toast.saveFailed, reply.reason); }
  };

  const saveEdit = async () => {
    if (!order) return;
    const before = order.revision;
    const reply = await write(() => api.editCustomerOrder({ ...body(), orderId: order.id, revision: order.revision }, { token }));
    if (!reply.accepted) push("error", copy.toast.saveFailed, reply.reason);
    else if (reply.value.revision === before) push("info", words.unchangedTitle, words.unchangedBody);
    // Saved: the order's page says so in its banner (OrderDetails), so no toast repeats it.
    else setSavedOrderId(reply.value.id);
  };

  /** Resolves with a reason to keep the dialog open and show it, or null when the order was cancelled. */
  const cancelOrder = async (reason: string): Promise<string | null> => {
    if (!order) return words.loadFailed;
    if (!reason.trim()) return words.cancelReasonRequired;
    const reply = await write(() => api.cancelCustomerOrder({ orderId: order.id, revision: order.revision, reason }, { token }));
    if (!reply.accepted) return reply.reason;
    push("success", words.cancelledTitle(reply.value.code), reply.value.partyName);
    return null;
  };

  const justSaved = order !== null && order.id === savedOrderId;
  return { mode, order, neighbours, loading, loadError, busy, justSaved, entry, startNew, goTo, startEdit, cancelEdit: () => setMode("view"), save, saveEdit, cancelOrder };
};

export type OrderEntryState = ReturnType<typeof useOrderEntry>;
