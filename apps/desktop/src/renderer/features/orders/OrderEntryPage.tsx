import React, { useState } from "react";
import { LEASE_DOMAIN } from "@erp/domain";
import { ConfirmDialog } from "../../components/shared/ConfirmDialog";
import { DocumentNavigator, type DocumentNavigatorLabels } from "../../components/shared/DocumentNavigator";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import { LeasedStation } from "../store/LeasedStation";
import { useOrderColourAccess } from "../../hooks/useCanAddColour";
import { OrderDetails } from "./OrderDetails";
import { OrderForm } from "./OrderForm";
import { useOrderChoices } from "./useOrderChoices";
import { useOrderEntry } from "./useOrderEntry";
import { orderDozens } from "./orderUnits";

// ENTER ORDERS (docs/52): what a party ordered, by article, colour and size, typed and shown in DOZENS and stored in
// cartons (1 dozen = 2 cartons; owner, 24 Nov 2026).
//
//   ‹ [ ORD- 14  of 14 ] ›  [ + New order ]      the compact pager (Hick's law, owner, 24 Nov 2026)
//   ── the order being written, or the stored one with what was dispatched, Edit and Cancel ──
//
// Orders are written on the computer that holds ORDERS, the boss's PC3 (cloud 042, 24 Nov 2026); gatepasses stay on PC1
// (SALES_DISPATCH) and allocate against the orders that have reached it. Elsewhere the page says so and writes nothing. Every refusal is the main process's.

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
}

const OrderEntry: React.FC<OrderEntryPageProps> = ({ token, canCancel }) => {
  const state = useOrderEntry(token);
  const choices = useOrderChoices();
  // A new colour is Product Master: added here on its computer, asked for on the orders computer (useCanAddColour.ts).
  const colourAccess = useOrderColourAccess();
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  const { mode, order, neighbours, busy } = state;

  const body = (() => {
    if (state.loading || choices.parties.loading || choices.articles.loading) return <StateView kind="loading" compact />;
    if (state.loadError) return <StateView kind="error" compact message={state.loadError} onRetry={() => void state.startNew()} />;
    if (mode === "view" && order) {
      return <OrderDetails order={order} busy={busy} canEdit canCancel={canCancel} onEdit={() => void state.startEdit()} onCancel={() => { setReason(""); setCancelling(true); }}
        justSaved={state.justSaved} onNewOrder={() => void state.startNew()} />;
    }
    return <OrderForm entry={state.entry} choices={choices} busy={busy} editing={mode === "edit"} onSave={() => void (mode === "edit" ? state.saveEdit() : state.save())} onDiscard={state.cancelEdit}
      colourAccess={colourAccess} />;
  })();

  return (
    // doc-themed: Create Gatepass's look (theme.css), in the Orders colours its Dashboard card gives the page.
    <div className="ord-page doc-themed">
      <div className="siv-toolbar ord-toolbar-row">
        <div className="gp-topbar-group">
          <DocumentNavigator
            compact
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
          {/* Hidden while the saved banner offers it, so the next step is one button, not two. */}
          {mode === "new" || state.justSaved ? null : (
            <button type="button" className="btn btn-secondary siv-new" disabled={busy || mode === "edit"} onClick={() => void state.startNew()}>+ {words.newOrder}</button>
          )}
        </div>
      </div>
      {body}
      {cancelling && order ? (
        <ConfirmDialog
          title={words.cancelDialogTitle(order.code)}
          facts={[
            { label: words.factParty, value: order.partyName },
            { label: words.factOrdered, value: orderDozens(order.totals.ordered) },
            { label: words.factDispatched, value: orderDozens(order.totals.dispatched) },
            { label: words.factPending, value: orderDozens(order.totals.pending) },
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
  <LeasedStation domain={LEASE_DOMAIN.ORDERS}>
    <OrderEntry {...props} />
  </LeasedStation>
);
