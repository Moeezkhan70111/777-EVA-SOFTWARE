import { useCallback, useEffect, useRef, useState } from "react";
import type { StoreDirection } from "@erp/domain";
import { useDesktopApi } from "../../../hooks/useDesktopApi";
import { useNotifications } from "../../../state/NotificationsContext";
import { copy } from "../../../config/copy";
import type { HandVoucher, HandVoucherBodyInput, HandVoucherView } from "../../../types/desktopApi";
import { parseVoucherReply, parseViewReply } from "./handVoucherReply";

// The store hand voucher on screen, for one direction: which one, where it sits in that run, and what can be done.
//
//   NEW    a voucher being written. ◄ goes to the newest stored one.
//   VIEW   a stored voucher, read by number. Edit and Delete are offered while it is today's.
//   EDIT   the stored voucher's lines in the form, saved from the revision shown.
//
// Every write answers with the voucher as it now stands, and the screen shows that, never its own idea of it.

export type VoucherMode = "new" | "view" | "edit";

interface Neighbours {
  previousNumber: number | null;
  nextNumber: number | null;
  latestNumber: number | null;
}

const NO_NEIGHBOURS: Neighbours = { previousNumber: null, nextNumber: null, latestNumber: null };

/** What a write answered: the voucher, or the reason nothing changed. */
export type VoucherWriteResult = { ok: true; voucher: HandVoucher } | { ok: false; reason: string };

export const useHandVoucher = (token: string, direction: StoreDirection) => {
  const api = useDesktopApi();
  const { push } = useNotifications();
  const [mode, setMode] = useState<VoucherMode>("new");
  const [voucher, setVoucher] = useState<HandVoucher | null>(null);
  const [neighbours, setNeighbours] = useState<Neighbours>(NO_NEIGHBOURS);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A new voucher's id, made once per voucher: a Save retried after a lost answer is the same voucher.
  const requestId = useRef(crypto.randomUUID());

  const read = useCallback(
    async (voucherNumber: number | null): Promise<HandVoucherView | null> => {
      let answer: unknown = null;
      try {
        answer = await api.getHandVoucher(direction, voucherNumber, { token });
      } catch {
        // Read as a failure below: the screen says so and offers Retry.
      }
      const reply = parseViewReply(answer);
      if (!reply.accepted) {
        setLoadError(reply.reason);
        return null;
      }
      setLoadError(null);
      setNeighbours({ previousNumber: reply.view.previousNumber, nextNumber: reply.view.nextNumber, latestNumber: reply.view.latestNumber });
      return reply.view;
    },
    [api, direction, token]
  );

  /** Back to a new, empty voucher. The newest number is read again so ◄ knows where to go. */
  const startNew = useCallback(async () => {
    setLoading(true);
    requestId.current = crypto.randomUUID();
    const view = await read(null);
    if (view) setNeighbours({ previousNumber: view.latestNumber, nextNumber: null, latestNumber: view.latestNumber });
    setVoucher(null);
    setMode("new");
    setLoading(false);
  }, [read]);

  useEffect(() => {
    void startNew();
  }, [startNew]);

  const goTo = useCallback(
    async (voucherNumber: number) => {
      setBusy(true);
      const view = await read(voucherNumber);
      setBusy(false);
      if (!view) return;
      if (!view.voucher) {
        push("warning", copy.handVoucher.notFound(voucherNumber));
        return;
      }
      setVoucher(view.voucher);
      setMode("view");
    },
    [push, read]
  );

  /** Runs one write; on success shows the voucher it answered with, and its place in the run. */
  const write = useCallback(
    async (send: () => Promise<unknown>): Promise<VoucherWriteResult> => {
      setBusy(true);
      try {
        const reply = parseVoucherReply(await send().catch((error: unknown) => ({ accepted: false, reason: error instanceof Error ? error.message : "" })));
        if (!reply.accepted) return { ok: false, reason: reply.reason };
        setVoucher(reply.voucher);
        setMode("view");
        await read(reply.voucher.voucherNumber);
        return { ok: true, voucher: reply.voucher };
      } finally {
        setBusy(false);
      }
    },
    [read]
  );

  const save = (body: HandVoucherBodyInput) => write(() => api.saveHandVoucher({ ...body, direction, requestId: requestId.current }, { token }));

  const saveEdit = (body: HandVoucherBodyInput) => {
    if (!voucher) return Promise.resolve<VoucherWriteResult>({ ok: false, reason: copy.handVoucher.loadFailed });
    return write(() => api.editHandVoucher({ ...body, voucherId: voucher.id, revision: voucher.revision }, { token }));
  };

  const remove = () => {
    if (!voucher) return Promise.resolve<VoucherWriteResult>({ ok: false, reason: copy.handVoucher.loadFailed });
    return write(() => api.deleteHandVoucher({ voucherId: voucher.id, revision: voucher.revision }, { token }));
  };

  return {
    mode,
    voucher,
    neighbours,
    loading,
    loadError,
    busy,
    startNew,
    goTo,
    startEdit: () => setMode("edit"),
    cancelEdit: () => setMode("view"),
    save,
    saveEdit,
    remove,
  };
};

export type HandVoucherState = ReturnType<typeof useHandVoucher>;
