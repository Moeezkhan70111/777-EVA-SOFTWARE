import React, { useState } from "react";
import { Modal } from "../../components/shared/Modal";
import { copy } from "../../config/copy";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { useNotifications } from "../../state/NotificationsContext";
import { PasswordField } from "./PasswordField";
import { useSession } from "./SessionContext";
import { useAccountsStatus } from "./useAccountsStatus";

// An admin setting a new password for someone who forgot theirs, under cloud accounts only (020's
// admin_reset_password). Nothing sends email, so this is how a forgotten password is fixed (docs/41).
// In local accounts it renders nothing: there a person changes their own password on this computer.

export const CloudPasswordReset = ({ userId }: { userId: string }) => {
  const api = useDesktopApi();
  const { state } = useAccountsStatus(api);
  const [open, setOpen] = useState(false);
  if (state.kind !== "ready" || state.status.mode !== "CLOUD") return null;
  return (
    <>
      <button type="button" className="btn btn-secondary" onClick={() => setOpen(true)}>
        {copy.cloudAccounts.resetPasswordButton}
      </button>
      {open && <ResetDialog userId={userId} onClose={() => setOpen(false)} />}
    </>
  );
};

const ResetDialog = ({ userId, onClose }: { userId: string; onClose: () => void }) => {
  const api = useDesktopApi();
  const { token } = useSession();
  const { push } = useNotifications();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async () => {
    if (token === null) return;
    setBusy(true);
    setProblem(null);
    try {
      const result = await api.resetMemberPassword?.(token, userId, password);
      if (result?.accepted) {
        push("success", copy.cloudAccounts.resetPasswordDoneTitle, copy.cloudAccounts.resetPasswordDoneBody);
        onClose();
      } else {
        setProblem(result?.reason ?? copy.cloudAccounts.statusFailed);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={copy.cloudAccounts.resetPasswordTitle}
      onClose={onClose}
      footer={
        <button type="button" className="btn btn-primary" disabled={busy || !password} onClick={() => void submit()}>
          {copy.cloudAccounts.resetPasswordConfirm}
        </button>
      }
    >
      <p className="confirm-note">{copy.cloudAccounts.resetPasswordExplain}</p>
      <PasswordField id="cloud-reset-password" label={copy.cloudAccounts.resetPasswordLabel} value={password} onChange={setPassword} autoComplete="new-password" />
      {problem && (
        <p className="confirm-problem" role="alert">
          ⚠ {problem}
        </p>
      )}
    </Modal>
  );
};
