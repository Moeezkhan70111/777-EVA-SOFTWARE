import React from "react";
import { GATEPASS_STATUS } from "@erp/domain";
import { copy } from "../../config/copy";
import type { Gatepass } from "../../types/desktopApi";
import { canEditGatepass } from "./gatepassEdit";

// The Gatepass screen's buttons, for what it is doing: viewing a stored gatepass, editing one, or writing a new one.
//
//   viewing   Open in list · Print · Edit (allowed and possible) · Make Bill / Open Bill (not cancelled)
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

export const ViewingActions: React.FC<ViewingActionsProps> = ({ document, onOpenInList, onPrint, onEdit, onMakeBill }) => (
  <>
    <button type="button" className="btn btn-secondary" onClick={onOpenInList}>
      {copy.gatepass.openInList}
    </button>
    <button type="button" className="btn btn-primary" onClick={onPrint} data-testid="gatepass-print">
      🖨 {copy.gatepass.printGatepass}
    </button>
    {onEdit && canEditGatepass(document) ? (
      <button type="button" className="btn btn-secondary" onClick={onEdit} data-testid="gatepass-edit">
        {copy.gatepass.edit}
      </button>
    ) : null}
    {/* A cancelled gatepass is never billed. One already billed opens its bill instead (Sale Voucher decides). */}
    {onMakeBill && document.status !== GATEPASS_STATUS.CANCELLED && !document.deletedAt ? (
      <button type="button" className="btn btn-primary" onClick={onMakeBill} data-testid="gatepass-make-bill">
        {document.status === GATEPASS_STATUS.CREATED ? copy.gatepass.makeBill : copy.gatepass.openBill}
      </button>
    ) : null}
  </>
);

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
