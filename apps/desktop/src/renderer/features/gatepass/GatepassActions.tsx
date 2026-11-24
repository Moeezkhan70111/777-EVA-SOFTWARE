import React from "react";
import { GATEPASS_STATUS } from "@erp/domain";
import { ActionMenu, type ActionMenuItem } from "../../components/shared/ActionMenu";
import { copy } from "../../config/copy";
import type { Gatepass } from "../../types/desktopApi";
import { canEditGatepass } from "./gatepassEdit";

// The Gatepass screen's buttons, for what it is doing: viewing a stored gatepass, editing one, or writing a new one.
//
//   viewing   More (Open in list · Edit, when allowed and possible) · Make Bill / Open Bill (not cancelled) · Print
//   editing   Cancel edit · Save changes
//   writing   Create Gatepass

interface ViewingActionsProps {
  document: Gatepass;
  onOpenInList: () => void;
  onPrint: () => void;
  /** Absent for someone who may not edit a gatepass. */
  onEdit?: () => void;
  /** Absent for someone who may not open Sale Voucher here. */
  onMakeBill?: () => void;
}

// Hick's law (owner, 24 Nov 2026: eight equal buttons were too many to choose from). One main action, Print, in the
// blue; the bill, the next step of the flow, beside it in white; Open in list and Edit, used now and then, under More.
export const ViewingActions: React.FC<ViewingActionsProps> = ({ document, onOpenInList, onPrint, onEdit, onMakeBill }) => {
  const moreItems: ActionMenuItem[] = [{ id: "open-in-list", label: copy.gatepass.openInList, onSelect: onOpenInList, testId: "gatepass-open-in-list" }];
  if (onEdit && canEditGatepass(document)) moreItems.push({ id: "edit", label: copy.gatepass.edit, onSelect: onEdit, testId: "gatepass-edit" });
  // A cancelled gatepass is never billed. One already billed opens its bill instead (Sale Voucher decides).
  const billable = Boolean(onMakeBill) && document.status !== GATEPASS_STATUS.CANCELLED && !document.deletedAt;
  return (
    <>
      <ActionMenu label={copy.gatepass.moreActions} groups={[{ label: copy.gatepass.moreActionsGroup, items: moreItems }]} />
      {billable ? (
        <button type="button" className="btn btn-secondary" onClick={onMakeBill} data-testid="gatepass-make-bill">
          {document.status === GATEPASS_STATUS.CREATED ? copy.gatepass.makeBill : copy.gatepass.openBill}
        </button>
      ) : null}
      <button type="button" className="btn btn-primary" onClick={onPrint} data-testid="gatepass-print">
        {copy.gatepass.printGatepass}
      </button>
    </>
  );
};

interface EditingActionsProps {
  saving: boolean;
  /** Why Save cannot be pressed yet, or null. */
  blocked: boolean;
  onCancel: () => void;
  onSave: () => void;
}

export const EditingActions: React.FC<EditingActionsProps> = ({ saving, blocked, onCancel, onSave }) => (
  <>
    <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={saving} data-testid="gatepass-edit-cancel">
      {copy.gatepass.cancelEdit}
    </button>
    <button type="button" className="btn btn-primary" onClick={onSave} disabled={blocked || saving} data-testid="gatepass-edit-save">
      {saving ? copy.gatepass.savingChanges : copy.gatepass.saveChanges}
    </button>
  </>
);
