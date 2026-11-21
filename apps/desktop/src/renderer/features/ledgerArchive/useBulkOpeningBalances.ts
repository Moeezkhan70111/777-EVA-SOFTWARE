import { useCallback, useState } from "react";
import type { LedgerSide } from "@erp/domain";
import { copy } from "../../config/copy";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { readBulkPostOutcome, readBulkPreview, type BulkPostOutcome, type BulkPreview } from "./bulkOpeningReplies";

// EVERY PARTY'S OPENING BALANCE AT A CUTOVER (docs/53). The administrator types the cutover date (there is no default),
// sees each party's balance on its last archived line before it, chooses which to post, confirms, and they are posted
// together or not at all. Each preview gets its own request id, so a retry after a lost answer is answered, not
// repeated; the main process works every figure out again and refuses the post if any changed since the preview.

const text = copy.openingBalance;

export type BulkState = { status: "idle" } | { status: "loading" } | { status: "error"; reason: string | null } | { status: "ready"; preview: BulkPreview };

export function useBulkOpeningBalances(side: LedgerSide) {
  const api = useDesktopApi();
  const [cutoverDate, setCutoverDate] = useState("");
  const [state, setState] = useState<BulkState>({ status: "idle" });
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [confirming, setConfirming] = useState(false);
  const [posting, setPosting] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<BulkPostOutcome | null>(null);

  const runPreview = useCallback(async () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoverDate)) {
      setRefusal(text.cutoverNeeded);
      return;
    }
    setRefusal(null);
    setConfirming(false);
    setState({ status: "loading" });
    const reply = readBulkPreview(await api.previewBulkOpeningBalances(side, cutoverDate).catch(() => null));
    if (!reply.ok) {
      setState({ status: "error", reason: reply.reason });
      return;
    }
    setState({ status: "ready", preview: reply.value });
    setChosen(new Set(reply.value.proposals.filter((proposal) => proposal.status === "READY").map((proposal) => proposal.partyId)));
    setRequestId(crypto.randomUUID());
  }, [api, cutoverDate, side]);

  const changeCutover = useCallback((value: string) => {
    setCutoverDate(value);
    // A preview is for one date: a new date needs a new one.
    setState({ status: "idle" });
    setConfirming(false);
  }, []);

  const toggle = useCallback((partyId: string) => {
    setConfirming(false);
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(partyId)) next.delete(partyId);
      else next.add(partyId);
      return next;
    });
  }, []);

  const post = useCallback(async () => {
    if (state.status !== "ready") return;
    const expected = state.preview.proposals
      .filter((proposal) => proposal.status === "READY" && chosen.has(proposal.partyId))
      .map((proposal) => ({ partyId: proposal.partyId, direction: proposal.direction, amountPaisa: proposal.amountPaisa, archiveStatementId: proposal.archiveStatementId }));
    setPosting(true);
    setRefusal(null);
    const reply = readBulkPostOutcome(await api.postBulkOpeningBalances({ requestId, side, cutoverDate: state.preview.cutoverDate, expected }).catch(() => null));
    setPosting(false);
    setConfirming(false);
    if (reply.ok) setOutcome(reply.value);
    else setRefusal(reply.reason ?? text.bulkPostFailed);
  }, [api, chosen, requestId, side, state]);

  return { cutoverDate, changeCutover, state, chosen, toggle, runPreview, confirming, setConfirming, posting, refusal, outcome, post };
}

export type BulkOpeningFlow = ReturnType<typeof useBulkOpeningBalances>;
