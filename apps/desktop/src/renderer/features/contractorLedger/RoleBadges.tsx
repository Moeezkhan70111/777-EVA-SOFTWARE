import React from "react";
import { CONTRACTOR_ROLE, type ContractorRole } from "@erp/domain";
import { copy } from "../../config/copy";
import { roleLabel } from "./contractorLedgerView";

// "Machine Contractor", "Packing Contractor" — who a contractor is paid as. The words carry the
// meaning; the badge colour only helps the eye tell them apart.

const BADGE_TONE: Record<ContractorRole, string> = {
  [CONTRACTOR_ROLE.MACHINE]: "badge-info",
  [CONTRACTOR_ROLE.PACKING]: "badge-ok",
  [CONTRACTOR_ROLE.PRINTING]: "badge-warn",
};

export const RoleBadges: React.FC<{ roles: readonly ContractorRole[] }> = ({ roles }) => (
  <span className="contractor-ledger-roles">
    {roles.length === 0 ? (
      <span className="badge badge-muted">{copy.contractorLedger.noRoleYet}</span>
    ) : (
      roles.map((role) => (
        <span key={role} className={`badge ${BADGE_TONE[role]}`}>
          {roleLabel(role)}
        </span>
      ))
    )}
  </span>
);
