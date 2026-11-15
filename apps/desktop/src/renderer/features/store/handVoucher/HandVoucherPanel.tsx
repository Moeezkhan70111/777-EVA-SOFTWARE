import React, { useEffect, useMemo, useState } from "react";
import { LEASE_DOMAIN, handVoucherPrefix, type StoreDirection } from "@erp/domain";
import { ConfirmDialog } from "../../../components/shared/ConfirmDialog";
import { DocumentNavigator, type DocumentNavigatorLabels } from "../../../components/shared/DocumentNavigator";
import { StateView } from "../../../components/shared/StateView";
import { ReadOnlyNotice } from "../../../components/shared/ReadOnlyNotice";
import { copy } from "../../../config/copy";
import { useNotifications } from "../../../state/NotificationsContext";
import { announceVoucherPrint } from "../../rawMaterial/storeVoucher";
import { LeasedStation } from "../LeasedStation";
import { printHandSlip } from "./handSlip";
import { useVoucherChoices } from "./useVoucherChoices";
import { useHandVoucher } from "./useHandVoucher";
import { VoucherDetails } from "./VoucherDetails";
import { VoucherForm } from "./VoucherForm";
import { draftOf, emptyDraft, heldBackOf, type LineContext } from "./voucherDraft";

// STORE > MOVE IN / MOVE OUT > BY HAND: the store hand voucher (docs/49), one panel for either direction.
//
//   ◄ Previous  [ SIV- 100012  of 100015 ]  Load  Next ►                 [ + New voucher ]      (Move Out: SOV-)
//   ── the voucher being written, or the stored one with Print slip · Edit · Delete ──
//
// Several materials moved without labels, to or from one party, saved as one numbered voucher. Every line is a hand
// move (rawMaterialHandMove.ts); every refusal is the data layer's.

const words = copy.handVoucher;

const navLabels = (direction: StoreDirection): DocumentNavigatorLabels => ({
  group: words[direction].navigator,
  number: words.voucherNumber,
  previous: words.previous,
  next: words.next,
  load: words.load,
  placeholder: words.numberPlaceholder,
  ofLatest: words.ofLatest,
  unsaved: words.unsaved,
});

interface HandVoucherPanelProps {
  /** IN: received from a supplier (SIV-). OUT: issued to a supplier or contractor (SOV-). */
  direction: StoreDirection;
  token: string;
  username?: string;
  /** This computer only reads the store: browse and print, never write. */
  readOnly?: boolean;
}

const VoucherPanel: React.FC<HandVoucherPanelProps> = ({ direction, token, username, readOnly = false }) => {
  const { push } = useNotifications();
  const side = words[direction];
  const state = useHandVoucher(token, direction);
  const choices = useVoucherChoices(token, direction);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const { mode, voucher, neighbours, busy } = state;
  const today = useMemo(() => new Date().toISOString(), []);
  const newContext = useMemo<LineContext>(() => ({ direction, heldBack: new Map() }), [direction]);

  // A computer that only reads the store has nothing to write: it opens on the newest voucher.
  const { goTo } = state;
  const latest = neighbours.latestNumber;
  useEffect(() => {
    if (readOnly && mode === "new" && latest !== null) void goTo(latest);
  }, [readOnly, mode, latest, goTo]);

  const saveNew = async (body: Parameters<typeof state.save>[0]) => {
    const result = await state.save(body);
    if (!result.ok) return result.reason;
    push("success", words.savedTitle(result.voucher.code), side.savedBody(result.voucher.lines.length));
    return null;
  };

  const saveEdit = async (body: Parameters<typeof state.saveEdit>[0]) => {
    const before = voucher?.revision;
    const result = await state.saveEdit(body);
    if (!result.ok) return result.reason;
    if (result.voucher.revision === before) push("info", words.unchangedTitle, words.unchangedBody);
    else push("success", words.editedTitle(result.voucher.code), side.editedBody);
    return null;
  };

  const confirmDelete = async () => {
    const result = await state.remove();
    if (!result.ok) return result.reason;
    push("success", words.deletedTitle(result.voucher.code), side.deletedBody);
    return null;
  };

  const print = async () => {
    if (voucher) announceVoucherPrint(await printHandSlip(voucher, username ?? null), push);
  };

  const body = (() => {
    if (state.loading || choices.loading) return <StateView kind="loading" compact />;
    if (state.loadError) return <StateView kind="error" compact message={state.loadError} onRetry={() => void state.startNew()} />;
    if (choices.loadError) return <StateView kind="error" compact message={choices.loadError} onRetry={() => void choices.reload()} />;
    if (mode === "new" && readOnly) return <StateView kind="empty" compact title={side.emptyTitle} />;
    if (mode === "new") {
      return <VoucherForm key={`new-${neighbours.latestNumber ?? 0}`} initial={emptyDraft()} context={newContext} dateIso={today} choices={choices} editing={false} busy={busy} onSave={saveNew} />;
    }
    if (!voucher) return <StateView kind="empty" compact title={side.emptyTitle} />;
    if (mode === "edit") {
      return (
        <VoucherForm
          key={`edit-${voucher.id}-${voucher.revision}`}
          initial={draftOf(voucher)}
          context={{ direction, heldBack: heldBackOf(voucher) }}
          dateIso={voucher.createdAt}
          choices={choices}
          editing
          busy={busy}
          onSave={saveEdit}
          onCancel={state.cancelEdit}
        />
      );
    }
    return (
      <VoucherDetails
        voucher={readOnly ? { ...voucher, editable: false } : voucher}
        busy={busy}
        onPrint={() => void print()}
        onEdit={state.startEdit}
        onDelete={() => setConfirmingDelete(true)}
      />
    );
  })();

  return (
    <div className="siv-panel">
      <div className="siv-toolbar">
        <DocumentNavigator
          prefix={`${handVoucherPrefix(direction)} -`}
          labels={navLabels(direction)}
          current={mode === "new" ? null : (voucher?.voucherNumber ?? null)}
          latest={neighbours.latestNumber}
          newNumber={null}
          previousNumber={neighbours.previousNumber}
          nextNumber={mode === "new" ? null : neighbours.nextNumber}
          busy={busy || mode === "edit"}
          onGo={(voucherNumber) => void state.goTo(voucherNumber)}
          onNew={() => void state.startNew()}
          testIdPrefix="hand-voucher"
        />
        {readOnly || mode === "new" ? null : (
          <button type="button" className="btn btn-secondary siv-new" disabled={busy || mode === "edit"} onClick={() => void state.startNew()}>
            + {words.newVoucher}
          </button>
        )}
      </div>
      {body}
      {confirmingDelete && voucher ? (
        <ConfirmDialog
          title={words.confirmDeleteTitle(voucher.code)}
          facts={[
            { label: side.party, value: voucher.partyName },
            { label: words.linesTitle, value: String(voucher.lines.length) },
          ]}
          explain={side.confirmDeleteBody}
          confirmLabel={words.delete}
          tone="danger"
          onConfirm={confirmDelete}
          onClose={() => setConfirmingDelete(false)}
        />
      ) : null}
    </div>
  );
};

/** Writing a voucher moves stock: only where this computer writes the raw material store (docs/37 section W). */
export const HandVoucherPanel: React.FC<HandVoucherPanelProps> = (props) => (
  <LeasedStation
    domain={LEASE_DOMAIN.RAW_MATERIAL_STORE}
    reader={(status) => (
      <>
        <ReadOnlyNotice status={status} />
        <VoucherPanel {...props} readOnly />
      </>
    )}
  >
    <VoucherPanel {...props} />
  </LeasedStation>
);
