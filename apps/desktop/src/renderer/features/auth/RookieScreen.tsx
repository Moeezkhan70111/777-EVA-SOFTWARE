import React, { useState } from "react";
import { AuthLogo } from "./AuthLogo";
import type { AccessStatus } from "@erp/domain";

export type RequestStatus = AccessStatus | null;

export const RookieScreen = ({
  requestStatus,
  onRequest,
  error,
}: {
  requestStatus: "PENDING" | "APPROVED" | "REJECTED" | null;
  onRequest: () => Promise<void>;
  error?: string | null;
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
        <h1 className="auth-title">Hey Rookie 👋</h1>
        <p className="rookie-subtext">Please ask the admin for access.</p>
        {error && (
          <div className="auth-error" role="alert">
            {error}
          </div>
        )}
        {requestStatus === "PENDING" ? (
          <div className="rookie-sent" role="status">
            Request Sent
          </div>
        ) : (
          <button
            type="button"
            className="btn btn-primary btn-xl auth-submit"
            onClick={() => void submitRequest()}
            disabled={isRequesting}
          >
            {isRequesting ? "Sending..." : "Request Access"}
          </button>
        )}
      </div>
    </div>
  );
};
