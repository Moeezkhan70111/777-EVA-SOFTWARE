import React, { useState } from "react";
import { AuthLogo } from "./AuthLogo";
import type { AccessStatus } from "@erp/domain";
import { copy } from "../../config/copy";

export type RequestStatus = AccessStatus | null;

// The waiting screen: an account that exists but is not approved yet. Under cloud accounts
// (docs/41) signing up already was the request, so there is nothing to press -- only what happens next.

export const RookieScreen = ({
  requestStatus,
  onRequest,
  error,
  cloudAccounts = false,
}: {
  requestStatus: "PENDING" | "APPROVED" | "REJECTED" | null;
  onRequest: () => Promise<void>;
  error?: string | null;
  cloudAccounts?: boolean;
}) => {
  const [isRequesting, setIsRequesting] = useState(false);
  const submitRequest = async () => {
    setIsRequesting(true);
    try {
      await onRequest();
    } finally {
      setIsRequesting(false);
    }
  };

  return (
    <div className="auth-page-shell">
      <div className="auth-card rookie-card">
        <div className="auth-brand">
          <AuthLogo />
        </div>
        <h1 className="auth-title">{copy.auth.rookieTitle}</h1>
        <p className="rookie-subtext">{cloudAccounts ? copy.auth.cloudWaitingBody : copy.auth.rookieBody}</p>
        {error && (
          <div className="auth-error" role="alert">
            {error}
          </div>
        )}
        {!cloudAccounts && <RequestAction sent={requestStatus === "PENDING"} busy={isRequesting} onRequest={() => void submitRequest()} />}
      </div>
    </div>
  );
};

/** Local accounts only: the request an admin on this computer will see. */
const RequestAction = ({ sent, busy, onRequest }: { sent: boolean; busy: boolean; onRequest: () => void }) => {
  if (sent) {
    return (
      <div className="rookie-sent" role="status">
        {copy.auth.requestSent}
      </div>
    );
  }
  return (
    <button type="button" className="btn btn-primary btn-xl auth-submit" onClick={onRequest} disabled={busy}>
      {busy ? copy.auth.requestSending : copy.auth.requestAccess}
    </button>
  );
};
