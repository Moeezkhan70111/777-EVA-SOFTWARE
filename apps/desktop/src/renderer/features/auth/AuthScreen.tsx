import React, { useState } from "react";
import { AuthLogo } from "./AuthLogo";

export type AuthView = "login" | "signup";

export const AuthScreen = ({
  view,
  onSubmit,
  onSwitch,
  error,
  onCancel,
}: {
  view: AuthView;
  onSubmit: (
    username: string,
    password: string,
    confirmPassword?: string,
  ) => Promise<void>;
  onSwitch: (view: AuthView) => void;
  error?: string | null;
  onCancel?: () => void;
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
      if (view === "login") {
        await onSubmit(username, password);
      } else {
        await onSubmit(username, password, confirmPassword);
      }
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
          <h1 className="auth-title">
            {view === "login" ? "Login" : "Create Account"}
          </h1>
        </div>
        <form onSubmit={handleSubmit} className="auth-form">
          <div className="input-group">
            <label className="input-label" htmlFor="auth-username">
              Username
            </label>
            <input
              id="auth-username"
              type="text"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="Enter your username"
              autoComplete="username"
            />
          </div>
          <div className="input-group">
            <label className="input-label" htmlFor="auth-password">
              Password
            </label>
            <div className="password-wrap">
              <input
                id="auth-password"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Enter your password"
                autoComplete={
                  view === "login" ? "current-password" : "new-password"
                }
              />
              <button
                type="button"
                className="password-toggle"
                onClick={() => setShowPassword((value) => !value)}
                aria-label={
                  showPassword ? "Hide hidden field" : "Show hidden field"
                }
              >
                {showPassword ? "Hide" : "Show"}
              </button>
            </div>
          </div>
          {view === "signup" && (
            <div className="input-group">
              <label className="input-label" htmlFor="auth-confirm-password">
                Confirm Password
              </label>
              <div className="password-wrap">
                <input
                  id="auth-confirm-password"
                  type={showConfirmPassword ? "text" : "password"}
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  placeholder="Confirm your password"
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  className="password-toggle"
                  onClick={() => setShowConfirmPassword((value) => !value)}
                  aria-label={
                    showConfirmPassword
                      ? "Hide hidden field"
                      : "Show hidden field"
                  }
                >
                  {showConfirmPassword ? "Hide" : "Show"}
                </button>
              </div>
            </div>
          )}
          {error && <div className="auth-error">{error}</div>}
          <button
            type="submit"
            className="btn btn-primary btn-xl auth-submit"
            disabled={isSubmitting}
          >
            {view === "login"
              ? isSubmitting
                ? "Logging in..."
                : "Login"
              : isSubmitting
                ? "Creating..."
                : "Sign Up"}
          </button>
        </form>
        <div className="auth-switch-row">
          {view === "login" ? (
            <button
              type="button"
              className="btn btn-ghost auth-link"
              onClick={() => onSwitch("signup")}
            >
              Sign Up
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-ghost auth-link"
              onClick={() => onSwitch("login")}
            >
              Login
            </button>
          )}
        </div>
        {onCancel && (
          <div style={{ marginTop: 12, textAlign: "center" }}>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={onCancel}
            >
              Cancel (Return to Active Profile)
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
