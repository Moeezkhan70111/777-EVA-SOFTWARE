import { useCallback, useEffect, useState } from "react";
import { PARTY_CLAIM_REQUEST_STATUS, fromPaisa, type PartyClaimRequestStatus } from "@erp/domain";
import { formatMoney } from "../../app/format";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { useDataChanged } from "../../hooks/useDataChanged";
import { DATA_KIND } from "../../../shared/dataChange";
import { leaseRefusalText } from "../../../shared/leaseRefusal";
import { copy } from "../../config/copy";
import { readClaimDecision, readClaimPage, readClaimReversal, type ClaimPage, type ClaimRequest, type ClaimPosting } from "./claimReplies";

// The Claims screen's data (docs/55): one page of requests by status, reloaded when a request arrives from the store or
// a claim is posted, rejected or reversed (here or on the accounts computer). And the three writes, each answered with
// the operator's sentence: the data layer's own refusal, or the lease gate's ("Accounts is written on PC1 only").

export type ClaimFilter = PartyClaimRequestStatus | "ALL";

export type ClaimsState =
  | { status: "loading" }
  | { status: "error"; reason: string | null }
  | { status: "ready"; page: ClaimPage };

const CHANGES = [DATA_KIND.CASH];
export const CLAIMS_PAGE_SIZE = 50;

export function useClaims(filter: ClaimFilter, page: number) {
  const api = useDesktopApi();
  const [state, setState] = useState<ClaimsState>({ status: "loading" });
  const [reloads, setReloads] = useState(0);
  const reload = useCallback(() => setReloads((count) => count + 1), []);
  useDataChanged(CHANGES, reload);

  useEffect(() => {
    let current = true;
    setState((before) => (before.status === "ready" ? before : { status: "loading" }));
    api
      .listPartyClaimRequests({ filter, limit: CLAIMS_PAGE_SIZE, offset: (page - 1) * CLAIMS_PAGE_SIZE })
      .then((raw) => {
        if (!current) return;
        const reply = readClaimPage(raw);
        setState(reply.ok ? { status: "ready", page: reply.value } : { status: "error", reason: reply.reason });
      })
      .catch(() => {
        if (current) setState({ status: "error", reason: null });
      });
    return () => {
      current = false;
    };
  }, [api, filter, page, reloads]);

  return { state, reload };
}

/** What a write came to: done with the operator's sentence, or refused with it. */
export type ClaimOutcome = { ok: true; message: string } | { ok: false; message: string };

const refusedWith = (error: unknown): ClaimOutcome => ({ ok: false, message: leaseRefusalText(error) ?? copy.claims.notSaved });

export function useClaimActions(onDone: () => void) {
  const api = useDesktopApi();
  const [busy, setBusy] = useState(false);
  const words = copy.claims;

  const run = useCallback(
    async (write: () => Promise<ClaimOutcome>): Promise<ClaimOutcome> => {
      setBusy(true);
      try {
        const outcome = await write();
        if (outcome.ok) onDone();
        return outcome;
      } catch (error) {
        return refusedWith(error);
      } finally {
        setBusy(false);
      }
    },
    [onDone]
  );

  /** Posts `request` at `ratePaisa` a pair. One claim id per attempt, so a retry of the same attempt never posts twice. */
  const post = (request: ClaimRequest, ratePaisa: number, claimId: string) =>
    run(async () => {
      const reply = readClaimDecision(await api.postPartyClaim({ claimId, requestId: request.requestId, ratePaisa }));
      if (!reply.ok) return { ok: false, message: reply.reason ?? words.notSaved };
      const posted = reply.value.posted;
      return { ok: true, message: posted ? words.posted(posted.claimNumber, rupees(posted.amountPaisa)) : words.notSaved };
    });

  const reject = (request: ClaimRequest, reason: string) =>
    run(async () => {
      const reply = readClaimDecision(await api.rejectPartyClaimRequest({ requestId: request.requestId, reason }));
      return reply.ok ? { ok: true, message: words.rejected(request.requestNumber) } : { ok: false, message: reply.reason ?? words.notSaved };
    });

  const reverse = (claim: ClaimPosting, reason: string) =>
    run(async () => {
      const reply = readClaimReversal(await api.reversePartyClaim({ claimId: claim.claimId, reason }));
      return reply.ok ? { ok: true, message: words.reversed(reply.value.claimNumber) } : { ok: false, message: reply.reason ?? words.notSaved };
    });

  return { busy, post, reject, reverse };
}

/** Integer paisa as the screen shows rupees. One formatter, the app's. */
export const rupees = (paisa: number): string => formatMoney(fromPaisa(paisa));

export const DEFAULT_CLAIM_FILTER: ClaimFilter = PARTY_CLAIM_REQUEST_STATUS.PENDING;
