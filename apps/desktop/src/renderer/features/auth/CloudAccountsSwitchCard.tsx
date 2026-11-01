import React, { useState } from "react";
import { ConfirmDialog } from "../../components/shared/ConfirmDialog";
import { copy } from "../../config/copy";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { useNotifications } from "../../state/NotificationsContext";
import type { AuthUser } from "../../types/desktopApi";
import { PasswordField } from "./PasswordField";
import { useSession } from "./SessionContext";
import { useAccountsStatus } from "./useAccountsStatus";

// THE SWITCH TO CLOUD ACCOUNTS, BY HAND (docs/41 sections 7 and 12; owner, 2026-11-01).
//
// Shown only to an admin, on a computer still using local accounts and set up to reach its cloud.
// Before anything happens it shows the SQL line that names the first admin, with this computer's id
// in it. Pressing the button opens a confirmation that says plainly what it will do -- everyone else
// is signed out now, and nobody works until approved -- and only that confirmation switches.

export const CloudAccountsSwitchCard = ({ onSwitched }: { onSwitched: (user: AuthUser, token: string) => Promise<void> }) => {
  const api = useDesktopApi();
  const { token, isAdmin } = useSession();
  const { state, reload } = useAccountsStatus(api);

  if (!isAdmin || state.kind === "loading") return null;
  if (state.kind === "error") {
    return (
      <section className="card cloud-accounts-card" aria-label={copy.cloudAccounts.cardTitle}>
        <p role="alert">{copy.cloudAccounts.statusFailed}</p>
        <button type="button" className="btn btn-secondary btn-sm" onClick={reload}>
          {copy.cloudAccounts.retry}
        </button>
      </section>
    );
  }
  if (state.status.mode !== "LOCAL" || !state.status.cloudConfigured || token === null) return null;
  if (!state.status.switchReady) return <NotReady />;
  return <SwitchForm token={token} deviceId={state.status.deviceId} onSwitched={onSwitched} />;
};

/** This build cannot approve anyone under cloud accounts, so it offers no switch -- and says why. */
const NotReady = () => (
  <section className="card cloud-accounts-card" aria-labelledby="cloud-accounts-title">
    <div className="card-eyebrow">{copy.cloudAccounts.cardEyebrow}</div>
    <h2 className="card-title" id="cloud-accounts-title">
      {copy.cloudAccounts.cardTitle}
    </h2>
    <p>{copy.cloudAccounts.cardBody}</p>
    <p className="text-muted" role="status">
      {copy.cloudAccounts.notReady}
    </p>
  </section>
);

const SwitchForm = ({
  token,
  deviceId,
  onSwitched,
}: {
  token: string;
  deviceId: string;
  onSwitched: (user: AuthUser, token: string) => Promise<void>;
}) => {
  const api = useDesktopApi();
  const { push } = useNotifications();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const open = () => {
    if (!email.trim() || !password) {
      setProblem(copy.cloudAccounts.needsBoth);
      return;
    }
    setProblem(null);
    setConfirming(true);
  };

  /** Resolves with the reason to stay open, or null once switched (ConfirmDialog's contract). */
  const switchNow = async (): Promise<string | null> => {
    const result = await api.switchToCloudAccounts?.(token, email.trim(), password);
    if (!result) return copy.cloudAccounts.statusFailed;
    if (!result.accepted) return result.reason;
    if (result.user) await onSwitched(result.user, result.token);
    push("success", copy.cloudAccounts.switchedTitle, copy.cloudAccounts.switchedBody(result.people));
    return null;
  };

  return (
    <section className="card cloud-accounts-card" aria-labelledby="cloud-accounts-title">
      <div className="card-eyebrow">{copy.cloudAccounts.cardEyebrow}</div>
      <h2 className="card-title" id="cloud-accounts-title">
        {copy.cloudAccounts.cardTitle}
      </h2>
      <p>{copy.cloudAccounts.cardBody}</p>
      <p className="text-muted text-small">{copy.cloudAccounts.beforeYouPress}</p>
      <pre className="cloud-accounts-sql">{copy.cloudAccounts.sqlLine(deviceId)}</pre>
      <div className="input-group">
        <label className="input-label" htmlFor="cloud-switch-email">
          {copy.cloudAccounts.emailLabel}
        </label>
        <input id="cloud-switch-email" type="email" value={email} autoComplete="email" onChange={(event) => setEmail(event.target.value)} />
      </div>
      <PasswordField id="cloud-switch-password" label={copy.cloudAccounts.passwordLabel} value={password} onChange={setPassword}
        autoComplete="current-password" hint={copy.cloudAccounts.passwordHint} />
      {problem && (
        <p className="auth-error" role="alert">
          {problem}
        </p>
      )}
      <button type="button" className="btn btn-danger" onClick={open}>
        {copy.cloudAccounts.switchButton}
      </button>
      {confirming && (
        <ConfirmDialog
          title={copy.cloudAccounts.dialogTitle}
          facts={[
            { label: copy.cloudAccounts.factComputer, value: deviceId },
            { label: copy.cloudAccounts.factAdmin, value: email.trim() },
            { label: copy.cloudAccounts.factOthers, value: copy.cloudAccounts.factOthersValue },
            { label: copy.cloudAccounts.factWork, value: copy.cloudAccounts.factWorkValue },
          ]}
          explain={copy.cloudAccounts.explain}
          warning={copy.cloudAccounts.warning}
          confirmLabel={copy.cloudAccounts.confirm}
          busyLabel={copy.cloudAccounts.switching}
          tone="danger"
          onConfirm={switchNow}
          onClose={() => setConfirming(false)}
        />
      )}
    </section>
  );
};
