import React, { useState } from "react";
import { copy } from "../../config/copy";

export const ChangePasswordPage = ({
  onSubmit,
  onCancel,
  error,
  success,
}: {
  onSubmit: (current: string, next: string, confirm: string) => Promise<void>;
  onCancel: () => void;
  error?: string | null;
  success?: string | null;
}) => {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsSubmitting(true);
    try {
      await onSubmit(currentPassword, newPassword, confirmPassword);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="auth-page-shell">
      <div className="auth-card auth-card-small">
        <div className="card-eyebrow">Security</div>
        <h1 className="page-title">Change Password</h1>
        <form onSubmit={handleSubmit} className="auth-form">
          <div className="input-group">
            <label className="input-label" htmlFor="current-password">
              Current Password
            </label>
            <div className="password-wrap">
              <input
                id="current-password"
                type={showCurrent ? "text" : "password"}
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                placeholder="Enter current password"
                autoComplete="current-password"
              />
              <button
                type="button"
                className="password-toggle"
                onClick={() => setShowCurrent((value) => !value)}
                aria-label={
                  showCurrent ? "Hide hidden field" : "Show hidden field"
                }
              >
                {showCurrent ? "Hide" : "Show"}
              </button>
            </div>
          </div>
          <div className="input-group">
            <label className="input-label" htmlFor="new-password">
              New Password
            </label>
            <div className="password-wrap">
              <input
                id="new-password"
                type={showNew ? "text" : "password"}
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                placeholder="Enter new password"
                autoComplete="new-password"
              />
              <button
                type="button"
                className="password-toggle"
                onClick={() => setShowNew((value) => !value)}
                aria-label={showNew ? "Hide hidden field" : "Show hidden field"}
              >
                {showNew ? "Hide" : "Show"}
              </button>
            </div>
          </div>
          <div className="input-group">
            <label className="input-label" htmlFor="confirm-new-password">
              Confirm New Password
            </label>
            <div className="password-wrap">
              <input
                id="confirm-new-password"
                type={showConfirm ? "text" : "password"}
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                placeholder="Confirm new password"
                autoComplete="new-password"
              />
              <button
                type="button"
                className="password-toggle"
                onClick={() => setShowConfirm((value) => !value)}
                aria-label={
                  showConfirm ? "Hide hidden field" : "Show hidden field"
                }
              >
                {showConfirm ? "Hide" : "Show"}
              </button>
            </div>
          </div>
          {error && <div className="auth-error">{error}</div>}
          {success && <div className="auth-success">{success}</div>}
          <div className="auth-actions-row">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onCancel}
            >{copy.common.cancel}</button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={isSubmitting}
            >
              {isSubmitting ? "Saving..." : "Save Password"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
