import React, { useState } from "react";
import { LEASE_DOMAIN, PARTY_CLAIM_REQUEST_STATUS } from "@erp/domain";
import { Pager } from "../../components/shared/Pager";
import { ReadOnlyNotice } from "../../components/shared/ReadOnlyNotice";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import { useNotifications } from "../../state/NotificationsContext";
import { useWriteLease } from "../sync/useWriteLease";
import { ClaimReasonDialog } from "./ClaimReasonDialog";
import { ClaimRequestCard, type ClaimCardActions } from "./ClaimRequestCard";
import { PostClaimDialog } from "./PostClaimDialog";
import { CLAIMS_PAGE_SIZE, DEFAULT_CLAIM_FILTER, useClaimActions, useClaims, type ClaimFilter, type ClaimOutcome } from "./useClaims";
import type { ClaimPosting, ClaimRequest } from "./claimReplies";

// CLAIMS (docs/55): the store's claim requests, priced and posted by Accounts.
//
//   Show [Waiting] [Posted] [Rejected] [All]                          3 requests waiting for Accounts
//   CR-000041 · MP-000012   ABC UPPER — Supplier   2 pairs of …   ⏳ Waiting    [Price and post…] [Reject…]
//
// On every computer it is read-only, but on the accounts computer, to someone given Post Claims, it prices, posts,
// rejects and reverses. That is only what the screen offers: the main process refuses a claim write anywhere but the
// ACCOUNTS holder, whatever is sent (leaseChannels.ts). Every figure is the main process's: this screen adds nothing up.

const words = copy.claims;
const FILTERS: readonly ClaimFilter[] = [PARTY_CLAIM_REQUEST_STATUS.PENDING, PARTY_CLAIM_REQUEST_STATUS.POSTED, PARTY_CLAIM_REQUEST_STATUS.REJECTED, "ALL"];

type Dialog =
  | { kind: "post"; request: ClaimRequest }
  | { kind: "reject"; request: ClaimRequest }
  | { kind: "reverse"; request: ClaimRequest; claim: ClaimPosting };

export const ClaimsPage: React.FC<{ canPost: boolean }> = ({ canPost }) => {
  const lease = useWriteLease(LEASE_DOMAIN.ACCOUNTS);
  const notices = useNotifications();
  const [filter, setFilter] = useState<ClaimFilter>(DEFAULT_CLAIM_FILTER);
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const claims = useClaims(filter, page);
  const actions = useClaimActions(claims.reload);
  const writable = canPost && lease.canWrite;

  const cardActions: ClaimCardActions | null = writable
    ? {
        onPost: (request) => setDialog({ kind: "post", request }),
        onReject: (request) => setDialog({ kind: "reject", request }),
        onReverse: (request, claim) => setDialog({ kind: "reverse", request, claim }),
      }
    : null;

  /** Tells the operator what was done, and passes the outcome back to the dialog. */
  const announced = async (outcome: Promise<ClaimOutcome>): Promise<ClaimOutcome> => {
    const result = await outcome;
    if (result.ok) notices.push("success", result.message);
    return result;
  };

  const choose = (next: ClaimFilter) => { setFilter(next); setPage(1); };

  const body = (() => {
    if (claims.state.status === "loading") return <StateView kind="loading" message={words.loading} />;
    if (claims.state.status === "error") return <StateView kind="error" message={claims.state.reason ?? words.notLoaded} onRetry={claims.reload} />;
    const { rows } = claims.state.page;
    if (rows.length === 0) {
      return filter === DEFAULT_CLAIM_FILTER || filter === "ALL"
        ? <StateView kind="empty" title={words.emptyTitle} hint={words.emptyHint} />
        : <StateView kind="empty" title={words.emptyFilteredTitle} hint={words.emptyFilteredHint} />;
    }
    return <ul className="claims-list">{rows.map((request) => <ClaimRequestCard key={request.requestId} request={request} actions={cardActions} />)}</ul>;
  })();

  const ready = claims.state.status === "ready" ? claims.state.page : null;
  const pages = ready ? Math.max(1, Math.ceil(ready.total / CLAIMS_PAGE_SIZE)) : 1;

  return (
    <div className="claims-page">
      <ReadOnlyNotice status={lease.status} />
      {writable ? null : <p className="claims-muted">{words.readOnlyHint}</p>}
      <div className="ord-toolbar">
        <div className="sa-toggle" role="group" aria-label={words.filterLabel}>
          {FILTERS.map((option) => (
            <button key={option} type="button" className={option === filter ? "sa-toggle-btn is-on" : "sa-toggle-btn"} aria-pressed={option === filter} onClick={() => choose(option)}>
              {words.filters[option]}
            </button>
          ))}
        </div>
        {ready ? <span className="ord-toolbar-total" aria-live="polite"><strong>{words.pendingCount(ready.pending)}</strong></span> : null}
      </div>
      {body}
      {pages > 1 ? <Pager page={page} pages={pages} onPage={setPage} numbered /> : null}
      {dialog?.kind === "post" ? (
        <PostClaimDialog request={dialog.request} busy={actions.busy} onClose={() => setDialog(null)}
          onPost={(ratePaisa, claimId) => announced(actions.post(dialog.request, ratePaisa, claimId))} />
      ) : null}
      {dialog?.kind === "reject" ? (
        <ClaimReasonDialog title={words.rejectTitle(dialog.request.requestNumber)} explain={words.rejectExplain} confirm={words.rejectConfirm}
          busy={actions.busy} onClose={() => setDialog(null)} onConfirm={(reason) => announced(actions.reject(dialog.request, reason))} />
      ) : null}
      {dialog?.kind === "reverse" ? (
        <ClaimReasonDialog title={words.reverseTitle(dialog.claim.claimNumber)} explain={words.reverseExplain} confirm={words.reverseConfirm}
          busy={actions.busy} onClose={() => setDialog(null)} onConfirm={(reason) => announced(actions.reverse(dialog.claim, reason))} />
      ) : null}
    </div>
  );
};
