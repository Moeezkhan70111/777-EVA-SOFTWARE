import React, { useState } from "react";
import { LEASE_DOMAIN } from "@erp/domain";
import { ConfirmDialog } from "../../components/shared/ConfirmDialog";
import { DocumentNavigator, type DocumentNavigatorLabels } from "../../components/shared/DocumentNavigator";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import { LeasedStation } from "../store/LeasedStation";
import { useWriteLease } from "../sync/useWriteLease";
import { OrderDetails } from "./OrderDetails";
import { OrderForm } from "./OrderForm";
import { useOrderChoices } from "./useOrderChoices";
import { useOrderEntry } from "./useOrderEntry";

// ENTER ORDERS (docs/52): what a party ordered, by article, colour and size, in cartons.
//
//   ◄ Previous  [ ORD- 14  of 14 ]  Load  Next ►                                      [ + New order ]
//   ── the order being written, or the stored one with what was dispatched, Edit and Cancel ──
//
// Orders are written on the computer that makes gatepasses (SALES_DISPATCH), so a gatepass allocates against every
// order there is. Elsewhere the page says so and writes nothing. Every refusal is the main process's.

const words = copy.orders;

const NAV_LABELS: DocumentNavigatorLabels = {
  group: words.navigator,
  number: words.orderNumber,
  previous: words.previous,
  next: words.next,
  load: words.load,
  placeholder: words.numberPlaceholder,
  ofLatest: words.ofLatest,
  unsaved: words.unsaved,
};

interface OrderEntryPageProps {
  token: string;
  canCancel: boolean;
  /** An administrator: may add a new colour to an article, where Product Master is written here. */
  isAdmin: boolean;
}

const OrderEntry: React.FC<OrderEntryPageProps> = ({ token, canCancel, isAdmin }) => {
  const state = useOrderEntry(token);
  const choices = useOrderChoices();
  // A new colour is Product Master: an administrator, where MASTER_DATA is written (as on Stock Adjustment).
  const masterData = useWriteLease(LEASE_DOMAIN.MASTER_DATA);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  const { mode, order, neighbours, busy } = state;

  const body = (() => {
    if (state.loading || choices.parties.loading || choices.articles.loading) return <StateView kind="loading" compact />;
    if (state.loadError) return <StateView kind="error" compact message={state.loadError} onRetry={() => void state.startNew()} />;
    if (mode === "view" && order) {
      return <OrderDetails order={order} busy={busy} canEdit canCancel={canCancel} onEdit={() => void state.startEdit()} onCancel={() => { setReason(""); setCancelling(true); }} />;
    }
    return <OrderForm entry={state.entry} choices={choices} busy={busy} editing={mode === "edit"} onSave={() => void (mode === "edit" ? state.saveEdit() : state.save())} onDiscard={state.cancelEdit}
      canAddColor={isAdmin && masterData.canWrite} />;
  })();

  return (
    <div className="ord-page">
      <div className="siv-toolbar">
        <DocumentNavigator
          prefix="ORD -"
          labels={NAV_LABELS}
          current={mode === "new" ? null : (order?.orderNumber ?? null)}
          latest={neighbours.latestNumber}
          newNumber={null}
          previousNumber={neighbours.previousNumber}
          nextNumber={mode === "new" ? null : neighbours.nextNumber}
          busy={busy || mode === "edit"}
          onGo={(orderNumber) => void state.goTo(orderNumber)}
          onNew={() => void state.startNew()}
          testIdPrefix="customer-order"
        />
        {mode === "new" ? null : (
          <button type="button" className="btn btn-secondary siv-new" disabled={busy || mode === "edit"} onClick={() => void state.startNew()}>+ {words.newOrder}</button>
        )}
      </div>
      {body}
      {cancelling && order ? (
        <ConfirmDialog
          title={words.cancelDialogTitle(order.code)}
          facts={[
            { label: words.factParty, value: order.partyName },
            { label: words.factOrdered, value: order.totals.ordered.toLocaleString("en-US") },
            { label: words.factDispatched, value: order.totals.dispatched.toLocaleString("en-US") },
            { label: words.factPending, value: order.totals.pending.toLocaleString("en-US") },
          ]}
          explain={words.cancelExplain}
          confirmLabel={words.cancelConfirm}
          tone="danger"
          onConfirm={() => state.cancelOrder(reason)}
          onClose={() => setCancelling(false)}
        >
          <label className="mpr-field">
            <span className="input-label">{words.cancelReason}</span>
            <input className="input" value={reason} maxLength={200} placeholder={words.cancelReasonPlaceholder} onChange={(event) => setReason(event.target.value)} />
          </label>
        </ConfirmDialog>
      ) : null}
    </div>
  );
};

export const OrderEntryPage: React.FC<OrderEntryPageProps> = (props) => (
  <LeasedStation domain={LEASE_DOMAIN.SALES_DISPATCH}>
    <OrderEntry {...props} />
  </LeasedStation>
);
