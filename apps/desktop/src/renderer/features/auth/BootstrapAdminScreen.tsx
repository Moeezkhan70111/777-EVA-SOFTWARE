import React, { useState } from "react";
import { AuthLogo } from "./AuthLogo";
import { copy } from "../../config/copy";

/**
 * One-time first-run screen: shown instead of AuthScreen only while no ADMIN account exists
 * yet (see useAuthSession's `needsBootstrap`). Submits to the dedicated bootstrap-admin IPC
 * operation, which the backend rejects once any ADMIN exists — this screen never appears again
 * after the first administrator is created.
 */
export const BootstrapAdminScreen = ({
  error,
  onSubmit,
}: {
  error?: string | null;
  onSubmit: (username: string, password: string, confirmPassword: string) => Promise<void>;
}) => {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsSubmitting(true);
    try {
      await onSubmit(username, password, confirmPassword);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="auth-page-shell">
      <div className="auth-card">
        <div className="auth-brand">
          <AuthLogo />
        </div>
        <div className="auth-title-wrap">
          <h1 className="auth-title">{copy.auth.bootstrapTitle}</h1>
          <p className="text-muted text-small">{copy.auth.bootstrapSubtitle}</p>
        </div>
        <form onSubmit={handleSubmit} className="auth-form">
          <div className="input-group">
            <label className="input-label" htmlFor="bootstrap-username">
              {copy.auth.username}
            </label>
            <input
              id="bootstrap-username"
              type="text"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="Choose an administrator username"
              autoComplete="username"
            />
          </div>
          <div className="input-group">
            <label className="input-label" htmlFor="bootstrap-password">
              {copy.auth.password}
            </label>
            <div className="password-wrap">
              <input
                id="bootstrap-password"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Choose a password"
                autoComplete="new-password"
              />
              <button
                type="button"
                className="password-toggle"
                onClick={() => setShowPassword((value) => !value)}
                aria-label={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? "Hide" : "Show"}
              </button>
            </div>
          </div>
          <div className="input-group">
            <label className="input-label" htmlFor="bootstrap-confirm-password">
              {copy.auth.confirmPassword}
            </label>
            <div className="password-wrap">
              <input
                id="bootstrap-confirm-password"
                type={showConfirmPassword ? "text" : "password"}
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                placeholder="Re-enter the password"
                autoComplete="new-password"
              />
              <button
                type="button"
                className="password-toggle"
                onClick={() => setShowConfirmPassword((value) => !value)}
                aria-label={showConfirmPassword ? "Hide password" : "Show password"}
              >
                {showConfirmPassword ? "Hide" : "Show"}
              </button>
            </div>
          </div>
          {error && <div className="auth-error">{error}</div>}
          <button type="submit" className="btn btn-primary btn-xl auth-submit" disabled={isSubmitting}>
            {isSubmitting ? copy.auth.bootstrapSubmitting : copy.auth.bootstrapButton}
          </button>
        </form>
      </div>
    </div>
  );
};
