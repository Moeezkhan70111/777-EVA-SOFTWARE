import React, { useState } from "react";
import { AuthLogo } from "./AuthLogo";
import { PasswordField } from "./PasswordField";
import { copy } from "../../config/copy";

export type AuthView = "login" | "signup";

/** What the person typed. `email` and `displayName` are used only under cloud accounts. */
export interface AuthForm {
  username: string;
  password: string;
  confirmPassword: string;
  email: string;
  displayName: string;
}

// Under cloud accounts (docs/41) the same screen signs in by email on any computer, and signs up with
// a name and an email. An old username still works the first time: the main process checks it here
// and answers that it needs an email, which `needsEmail` then asks for.

export const AuthScreen = ({
  view,
  onSubmit,
  onSwitch,
  error,
  onCancel,
  cloudAccounts = false,
  needsEmail = false,
}: {
  view: AuthView;
  onSubmit: (form: AuthForm) => Promise<void>;
  onSwitch: (view: AuthView) => void;
  error?: string | null;
  onCancel?: () => void;
  cloudAccounts?: boolean;
  needsEmail?: boolean;
}) => {
  const [form, setForm] = useState<AuthForm>({ username: "", password: "", confirmPassword: "", email: "", displayName: "" });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const set = (field: keyof AuthForm) => (value: string) => setForm((current) => ({ ...current, [field]: value }));
  const isLogin = view === "login";

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsSubmitting(true);
    try {
      await onSubmit(form);
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
          <h1 className="auth-title">{isLogin ? copy.auth.loginHeading : copy.auth.signupHeading}</h1>
        </div>
        <form onSubmit={handleSubmit} className="auth-form">
          {cloudAccounts && !isLogin && (
            <TextField id="auth-name" label={copy.auth.cloudNameLabel} value={form.displayName} onChange={set("displayName")}
              placeholder={copy.auth.cloudNamePlaceholder} autoComplete="name" />
          )}
          <TextField
            id="auth-username"
            label={cloudAccounts ? copy.auth.cloudSignInLabel : copy.auth.username}
            value={form.username}
            onChange={set("username")}
            placeholder={cloudAccounts ? copy.auth.cloudSignInPlaceholder : copy.auth.usernamePlaceholder}
            autoComplete={cloudAccounts ? "email" : "username"}
            hint={cloudAccounts && isLogin ? copy.auth.cloudSignInHint : undefined}
          />
          <PasswordField id="auth-password" label={copy.auth.password} value={form.password} onChange={set("password")}
            placeholder={copy.auth.passwordPlaceholder} autoComplete={isLogin ? "current-password" : "new-password"} />
          {!isLogin && (
            <PasswordField id="auth-confirm-password" label={copy.auth.confirmPassword} value={form.confirmPassword}
              onChange={set("confirmPassword")} placeholder={copy.auth.confirmPlaceholder} autoComplete="new-password" />
          )}
          {cloudAccounts && isLogin && needsEmail && (
            <TextField id="auth-email" label={copy.auth.cloudEmailLabel} value={form.email} onChange={set("email")}
              placeholder={copy.auth.cloudEmailPlaceholder} autoComplete="email" type="email" />
          )}
          {error && (
            <div className="auth-error" role="alert">
              {error}
            </div>
          )}
          <button type="submit" className="btn btn-primary btn-xl auth-submit" disabled={isSubmitting}>
            {submitLabel(isLogin, isSubmitting, cloudAccounts && needsEmail)}
          </button>
        </form>
        <div className="auth-switch-row">
          <button type="button" className="btn btn-ghost auth-link" onClick={() => onSwitch(isLogin ? "signup" : "login")}>
            {isLogin ? copy.auth.signUpLink : copy.auth.loginLink}
          </button>
        </div>
        {onCancel && (
          <div className="auth-switch-row">
            <button type="button" className="btn btn-secondary btn-sm" onClick={onCancel}>
              {copy.auth.cancelToProfile}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

function submitLabel(isLogin: boolean, isSubmitting: boolean, movingUp: boolean): string {
  if (isSubmitting) return isLogin ? copy.auth.loggingIn : copy.auth.creating;
  if (!isLogin) return copy.auth.signUpLink;
  return movingUp ? copy.auth.cloudMoveUpButton : copy.auth.loginButton;
}

const TextField = ({
  id,
  label,
  value,
  onChange,
  placeholder,
  autoComplete,
  hint,
  type = "text",
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  autoComplete: string;
  hint?: string;
  type?: "text" | "email";
}) => (
  <div className="input-group">
    <label className="input-label" htmlFor={id}>
      {label}
    </label>
    <input id={id} type={type} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder}
      autoComplete={autoComplete} aria-describedby={hint ? `${id}-hint` : undefined} />
    {hint ? (
      <p className="text-muted text-small" id={`${id}-hint`}>
        {hint}
      </p>
    ) : null}
  </div>
);
