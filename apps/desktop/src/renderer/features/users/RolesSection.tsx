import React, { useState } from "react";
import { NAV_PERMISSION_MODULES } from "../../components/layout/Navbar";
import { describePerm } from "./permissions";
import { copy } from "../../config/copy";

export const RolesSection = ({
  roles,
  onCreate,
  onUpdate,
  onDelete,
}: {
  roles: Array<{
    code: string;
    name: string;
    description: string | null;
    permissions: string[];
    memberCount: number;
    loginPolicy?: "ALWAYS_LOGGED_IN" | "DAILY_LOGIN";
  }>;
  onCreate: (input: { name: string; description?: string; permissions: string[]; loginPolicy?: "ALWAYS_LOGGED_IN" | "DAILY_LOGIN" }) => Promise<void>;
  onUpdate: (
    code: string,
    input: { name?: string; description?: string; permissions?: string[]; loginPolicy?: "ALWAYS_LOGGED_IN" | "DAILY_LOGIN" },
  ) => Promise<void>;
  onDelete: (code: string) => Promise<void>;
}) => {
  const [editing, setEditing] = useState<
    | { mode: "new" }
    | { mode: "edit"; code: string; name: string; description: string | null; permissions: string[]; loginPolicy?: "ALWAYS_LOGGED_IN" | "DAILY_LOGIN" }
    | null
  >(null);
  const [draftName, setDraftName] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [draftPerms, setDraftPerms] = useState<string[]>([]);
  const [draftLoginPolicy, setDraftLoginPolicy] = useState<"ALWAYS_LOGGED_IN" | "DAILY_LOGIN">("ALWAYS_LOGGED_IN");
  const [saving, setSaving] = useState(false);
  const [savedOk, setSavedOk] = useState(false);

  const openNew = () => {
    setEditing({ mode: "new" });
    setDraftName("");
    setDraftDescription("");
    setDraftPerms([]);
    setDraftLoginPolicy("ALWAYS_LOGGED_IN");
    setSavedOk(false);
  };
  const openEdit = (role: typeof roles[number]) => {
    setEditing({ mode: "edit", code: role.code, name: role.name, description: role.description, permissions: [...role.permissions], loginPolicy: role.loginPolicy });
    setDraftName(role.name);
    setDraftDescription(role.description ?? "");
    setDraftPerms([...role.permissions]);
    setDraftLoginPolicy(role.loginPolicy ?? "ALWAYS_LOGGED_IN");
    setSavedOk(false);
  };
  const submit = async () => {
    if (!draftName.trim()) return;
    setSaving(true);
    try {
      if (editing?.mode === "new") {
        await onCreate({
          name: draftName,
          description: draftDescription || undefined,
          permissions: draftPerms,
          loginPolicy: draftLoginPolicy,
        });
      } else if (editing?.mode === "edit") {
        await onUpdate(editing.code, {
          name: draftName,
          description: draftDescription,
          permissions: draftPerms,
          loginPolicy: draftLoginPolicy,
        });
      }
      setSavedOk(true);
      setTimeout(() => {
        setEditing(null);
        setSavedOk(false);
      }, 600);
    } finally {
      setSaving(false);
    }
  };
  const doDelete = async (code: string) => {
    if (!window.confirm("Delete this role? It can only be deleted if no member is using it.")) return;
    await onDelete(code);
  };

  return (
    <section className="members-section">
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 6,
        }}
      >
        <div className="card-eyebrow" style={{ marginBottom: 0 }}>
          Roles
        </div>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={openNew}
        >
          + Create Role
        </button>
      </div>
      {roles.map((role) => (
        <div
          key={role.code}
          className="member-row"
          style={{ alignItems: "flex-start" }}
        >
          <span className="member-avatar" style={{ background: "#e0e7ff", color: "#4338ca" }}>
            {role.name.slice(0, 2).toUpperCase()}
          </span>
          <span className="member-row-main">
            <span className="member-heading" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <strong>{role.name}</strong>
              <span className="member-status approved">
                {role.memberCount} {role.memberCount === 1 ? "member" : "members"}
              </span>
              <span
                className="member-status"
                style={{
                  background: role.loginPolicy === "DAILY_LOGIN" ? "rgba(249,115,22,0.12)" : "rgba(34,197,94,0.12)",
                  color: role.loginPolicy === "DAILY_LOGIN" ? "#ea580c" : "var(--ok)",
                  fontSize: "0.68rem",
                  fontWeight: 700,
                }}
              >
                {role.loginPolicy === "DAILY_LOGIN" ? "Daily Login" : "Always Logged In"}
              </span>
            </span>
            <span className="member-login">
              {role.description || "No description"}
              <br />
              {role.permissions.length === 0 ? (
                <span style={{ color: "#9ca3af" }}>No permissions</span>
              ) : (
                <span style={{ color: "var(--text-2-soft)" }}>
                  {role.permissions.slice(0, 4).map(describePerm).join(" · ")}
                  {role.permissions.length > 4 &&
                    ` · +${role.permissions.length - 4} more`}
                </span>
              )}
            </span>
          </span>
          <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => openEdit(role)}
            >{copy.actions.edit}</button>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              onClick={() => void doDelete(role.code)}
              disabled={role.memberCount > 0}
              title={role.memberCount > 0 ? "Cannot delete role in use" : undefined}
            >{copy.actions.delete}</button>
          </div>
        </div>
      ))}

      {editing && (
        <div
          className="member-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setEditing(null);
          }}
        >
          <section className="member-modal" role="dialog" aria-modal="true">
            <div className="member-modal-header">
              <div className="member-modal-identity">
                <div>
                  <h2 id="member-access-title">
                    {editing.mode === "new" ? "Create Role" : "Edit Role"}
                  </h2>
                  <span className="member-modal-role">
                    Reusable access profile
                  </span>
                </div>
                <button
                  type="button"
                  className="member-modal-close"
                  aria-label={copy.common.close}
                  onClick={() => setEditing(null)}
                >
                  ×
                </button>
              </div>
            </div>

            <label className="member-role-field">
              <span>{copy.columns.name}</span>
              <input
                type="text"
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                placeholder="e.g. Billing Manager"
              />
            </label>
            <label className="member-role-field">
              <span>Description (optional)</span>
              <input
                type="text"
                value={draftDescription}
                onChange={(event) => setDraftDescription(event.target.value)}
                placeholder="Short summary of this role's purpose"
              />
            </label>

            <div className="member-modal-section-title">Session / Login Policy</div>
            <div
              style={{
                display: "flex",
                gap: 16,
                padding: "8px 12px",
                background: "var(--surface-faint)",
                borderRadius: 8,
                marginBottom: 12,
                border: "1px solid var(--neutral-200)",
              }}
            >
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 12,
                  cursor: "pointer",
                  fontWeight: 600,
                  color: "var(--neutral-700)",
                }}
              >
                <input
                  type="radio"
                  name="loginPolicy"
                  value="ALWAYS_LOGGED_IN"
                  checked={draftLoginPolicy === "ALWAYS_LOGGED_IN"}
                  onChange={() => setDraftLoginPolicy("ALWAYS_LOGGED_IN")}
                />
                Always Logged In
              </label>
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 12,
                  cursor: "pointer",
                  fontWeight: 600,
                  color: "var(--neutral-700)",
                }}
              >
                <input
                  type="radio"
                  name="loginPolicy"
                  value="DAILY_LOGIN"
                  checked={draftLoginPolicy === "DAILY_LOGIN"}
                  onChange={() => setDraftLoginPolicy("DAILY_LOGIN")}
                />
                Daily Login (Requires Daily Sign-in)
              </label>
            </div>

            <div className="member-modal-section-title">Assigned Permissions</div>
            <div
              style={{
                padding: "10px",
                background: "var(--surface-faint)",
                borderRadius: 8,
                display: "grid",
                gridTemplateColumns: "repeat(2, 1fr)",
                gap: "4px 12px",
                marginBottom: 12,
                border: "1px solid var(--neutral-200)",
              }}
            >
              {NAV_PERMISSION_MODULES.flatMap((module) => {
                const items =
                  module.children.length > 0
                    ? (module.children as unknown as Array<[string, string]>)
                    : ([[module.id, module.label]] as Array<[string, string]>);
                return items.map(([id, label]) => (
                  <label
                    key={id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      fontSize: 12,
                      fontWeight: id === "navbar" ? 700 : 500,
                      color: id === "navbar" ? "var(--accent-deep)" : "var(--neutral-700)",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={draftPerms.includes(id)}
                      onChange={(event) =>
                        setDraftPerms((curr) =>
                          event.target.checked
                            ? [...curr, id]
                            : curr.filter((p) => p !== id),
                        )
                      }
                    />
                    {label}
                  </label>
                ));
              })}
            </div>

            {savedOk && (
              <div className="auth-success" role="status">
                Saved
              </div>
            )}
            <div className="member-modal-actions">
              <span />
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setEditing(null)}
              >{copy.common.cancel}</button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void submit()}
                disabled={!draftName.trim() || saving}
              >
                {saving ? "Saving…" : "Save Role"}
              </button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
};
