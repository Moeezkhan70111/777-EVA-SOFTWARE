import React, { useState } from "react";
import { ConfirmDialog } from "../../components/shared/ConfirmDialog";
import { copy } from "../../config/copy";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { useNotifications } from "../../state/NotificationsContext";
import { useSession } from "./SessionContext";
import { useAccountsStatus } from "./useAccountsStatus";

// Making another administrator, or taking it away, under cloud accounts (owner, 2026-11-01: the SQL
// editor is the gap being closed everywhere else). Not shown for oneself -- the cloud refuses an admin
// removing their own rights, and the last admin's -- nor for anyone not approved, nor in local accounts.

export const CloudAdminToggle = ({
  userId,
  username,
  isAdmin,
  approved,
}: {
  userId: string;
  username: string;
  isAdmin: boolean;
  approved: boolean;
}) => {
  const api = useDesktopApi();
  const { state } = useAccountsStatus(api);
  const { user, token } = useSession();
  const { push } = useNotifications();
  const [confirming, setConfirming] = useState(false);

  if (state.kind !== "ready" || state.status.mode !== "CLOUD" || !approved || user?.id === userId || token === null) return null;

  const change = async (): Promise<string | null> => {
    const result = await api.setMemberAdmin?.(token, userId, !isAdmin);
    if (!result) return copy.cloudAccounts.statusFailed;
    if (!result.accepted) return result.reason ?? copy.cloudAccounts.statusFailed;
    push("success", copy.cloudAccounts.adminChangedTitle, username);
    return null;
  };

  return (
    <>
      <button type="button" className="btn btn-secondary" onClick={() => setConfirming(true)}>
        {isAdmin ? copy.cloudAccounts.adminToggleRemove : copy.cloudAccounts.adminToggleMake}
      </button>
      {confirming && (
        <ConfirmDialog
          title={isAdmin ? copy.cloudAccounts.adminRemoveTitle : copy.cloudAccounts.adminMakeTitle}
          facts={[
            { label: copy.cloudAccounts.adminFactPerson, value: username },
            { label: copy.cloudAccounts.adminFactWhere, value: copy.cloudAccounts.adminFactWhereValue },
          ]}
          explain={isAdmin ? copy.cloudAccounts.adminRemoveExplain : copy.cloudAccounts.adminMakeExplain}
          confirmLabel={isAdmin ? copy.cloudAccounts.adminRemoveConfirm : copy.cloudAccounts.adminMakeConfirm}
          tone={isAdmin ? "danger" : "primary"}
          onConfirm={change}
          onClose={() => setConfirming(false)}
        />
      )}
    </>
  );
};
