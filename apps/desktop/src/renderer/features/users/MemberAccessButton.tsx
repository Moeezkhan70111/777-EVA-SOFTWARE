import React, { useState } from "react";
import { ConfirmDialog } from "../../components/shared/ConfirmDialog";
import { copy } from "../../config/copy";
import { MEMBER_STATUS } from "./types";
import type { Member } from "./types";

/** Revoked or rejected: the person cannot sign in, so the card offers Restore instead of Revoke. */
export const isAccessEnded = (member: Pick<Member, "accessStatus">): boolean =>
  member.accessStatus === MEMBER_STATUS.REVOKED || member.accessStatus === MEMBER_STATUS.REJECTED;

/**
 * The member details' access button: Revoke for someone who has access, Restore for someone who
 * does not. Each asks first, names the person and their role, and shows a refusal in the dialog.
 */
export const MemberAccessButton = ({
  member,
  onRevoke,
  onRestore,
  onDone,
}: {
  member: Member;
  onRevoke: (id: string) => Promise<string | null>;
  onRestore: (id: string) => Promise<string | null>;
  /** After a revoke or restore went through: the details close, the list is already re-read. */
  onDone: () => void;
}) => {
  const [asking, setAsking] = useState(false);
  const restoring = isAccessEnded(member);
  const facts = [
    { label: copy.auth.memberFactName, value: member.username },
    { label: copy.auth.memberFactRole, value: member.roleName ?? (member.jobRole || copy.auth.memberNoRole) },
  ];
  const act = async (): Promise<string | null> => {
    const refused = restoring ? await onRestore(member.id) : await onRevoke(member.id);
    if (refused === null) onDone();
    return refused;
  };

  return (
    <>
      <button type="button" className={restoring ? "btn btn-primary" : "btn btn-danger"} onClick={() => setAsking(true)}>
        {restoring ? copy.auth.restoreAccess : copy.auth.revokeAccess}
      </button>
      {asking && (
        <ConfirmDialog
          title={restoring ? copy.auth.restoreTitle : copy.auth.revokeTitle}
          facts={facts}
          explain={restoring ? copy.auth.restoreExplain : copy.auth.revokeExplain}
          confirmLabel={restoring ? copy.auth.restoreConfirm : copy.auth.revokeConfirm}
          tone={restoring ? "primary" : "danger"}
          onConfirm={act}
          onClose={() => setAsking(false)}
        />
      )}
    </>
  );
};
