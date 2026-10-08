import React, { useState } from "react";
import { NAV_PERMISSION_MODULES } from "../../components/layout/Navbar";
import { describePerm } from "./permissions";
import { formatDateTime } from "../../utils/dates";
import type { Member } from "./types";
import { copy } from "../../config/copy";

export const MemberSection = ({
  members,
  roleOptions,
  onPermissions,
  onRevoke,
  onReview,
  onJobRole,
  onAuthority,
  onAssignRole,
  onSetAdditionalPermissions,
}: {
  members: Member[];
  roleOptions: Array<{ code: string; name: string; permissions: string[] }>;
  onPermissions: (id: string, permissions: string[]) => Promise<void>;
  onRevoke: (id: string) => Promise<void>;
  onReview: (
    requestId: string,
    decision: "APPROVED" | "REJECTED",
    permissions: string[],
    roleCode?: string,
  ) => Promise<void>;
  onJobRole: (id: string, jobRole: string) => Promise<void>;
  onAuthority: (id: string, authorityLevel: number) => Promise<void>;
  onAssignRole: (userId: string, roleCode: string) => Promise<void>;
  onSetAdditionalPermissions: (userId: string, permissions: string[]) => Promise<void>;
}) => {
  const [selectedMember, setSelectedMember] = useState<Member | null>(null);
  const [draftAdditional, setDraftAdditional] = useState<string[]>([]);
  const [draftJobRole, setDraftJobRole] = useState("");
  const [draftAuthority, setDraftAuthority] = useState(10);
  const [selectedRoleCode, setSelectedRoleCode] = useState<string>("");
  const [saved, setSaved] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const openMember = (member: Member) => {
    setSelectedMember(member);
    setDraftAdditional(member.additionalPermissions ?? []);
    setDraftJobRole(member.jobRole);
    setSelectedRoleCode(member.roleCode ?? "");
    setDraftAuthority(member.authorityLevel);
    setSaved(false);
    setShowAdvanced(false);
  };
  const save = async () => {
    if (!selectedMember) return;
    if (selectedRoleCode) {
      await onAssignRole(selectedMember.id, selectedRoleCode);
      const role = roleOptions.find((r) => r.code === selectedRoleCode);
      if (role) await onJobRole(selectedMember.id, role.name);
    } else if (draftJobRole) {
      await onJobRole(selectedMember.id, draftJobRole);
    }
    await onAuthority(selectedMember.id, draftAuthority);
    await onSetAdditionalPermissions(selectedMember.id, draftAdditional);
    setSelectedMember({
      ...selectedMember,
      additionalPermissions: draftAdditional,
      authorityLevel: draftAuthority,
      roleCode: selectedRoleCode || selectedMember.roleCode,
      roleName: selectedRoleCode
        ? roleOptions.find((r) => r.code === selectedRoleCode)?.name ?? selectedMember.roleName
        : selectedMember.roleName,
    });
    setSaved(true);
  };
  return (
    <>
      <section className="members-section">
        <div className="card-eyebrow">Members</div>
        {members.map((member) => (
          <button
            type="button"
            className="member-row member-row-button"
            key={member.id}
            onClick={() => openMember(member)}
            disabled={member.role === "ADMIN"}
          >
            <span className="member-avatar">
              {member.username.slice(0, 2).toUpperCase()}
            </span>
            <span className="member-row-main">
              <span className="member-heading">
                <strong>{member.username}</strong>
                <span
                  className={`member-status ${member.accessStatus.toLowerCase()}`}
                >
                  {member.role === "ADMIN"
                    ? "Admin"
                    : (member.roleName ?? member.jobRole) || member.accessStatus}
                </span>
              </span>
              <span className="member-login">
                Last login:{" "}
                {member.lastLoginAt
                  ? formatDateTime(member.lastLoginAt)
                  : "Never"}
                {(member.additionalPermissions ?? []).length > 0 && (
                  <span
                    style={{
                      marginLeft: 12,
                      color: "var(--accent)",
                      fontWeight: 500,
                      borderRadius: 4,
                      padding: "1px 6px",
                      fontSize: 11,
                      background: "var(--accent-soft)",
                      border: "1px solid var(--accent-line)",
                    }}
                  >
                    +{" "}
                    {(member.additionalPermissions ?? [])
                      .slice(0, 2)
                      .map(describePerm)
                      .join(", ")}
                    {(member.additionalPermissions ?? []).length > 2 &&
                      ` +${(member.additionalPermissions ?? []).length - 2} more`}
                  </span>
                )}
              </span>
            </span>
          </button>
        ))}
      </section>
      {selectedMember && selectedMember.role !== "ADMIN" && (
        <div
          className="member-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setSelectedMember(null);
          }}
        >
          <section
            className="member-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="member-access-title"
          >
            <div className="member-modal-header">
              <div className="member-modal-identity">
                <span className="member-modal-avatar">
                  {selectedMember.username.slice(0, 2).toUpperCase()}
                </span>
                <div>
                  <h2 id="member-access-title">{selectedMember.username}</h2>
                  <span className="member-modal-role">
                    {selectedMember.role}
                  </span>
                </div>
              </div>
              <button
                type="button"
                className="member-modal-close"
                aria-label="Close member access panel"
                onClick={() => setSelectedMember(null)}
              >
                ×
              </button>
            </div>
            <div className="member-modal-meta">
              <span>{copy.columns.status}<strong>{selectedMember.accessStatus}</strong>
              </span>
              <span>
                Last login{" "}
                <strong>
                  {selectedMember.lastLoginAt
                    ? formatDateTime(selectedMember.lastLoginAt)
                    : "Never"}
                </strong>
              </span>
            </div>
            <label className="member-role-field">
              <span>Role</span>
              <select
                value={selectedRoleCode}
                onChange={(event) => {
                  setSelectedRoleCode(event.target.value);
                }}
              >
                <option value="">No role assigned</option>
                {roleOptions.map((role) => (
                  <option value={role.code} key={role.code}>
                    {role.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="member-role-field">
              <span>Authority Level</span>
              <input
                type="number"
                min="1"
                max="99"
                value={draftAuthority}
                onChange={(event) =>
                  setDraftAuthority(Number(event.target.value))
                }
              />
            </label>

            {selectedMember.accessStatus === "PENDING" &&
              selectedMember.accessRequestId && (
                <div className="member-review-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => {
                      const eff = new Set<string>(draftAdditional);
                      const r = roleOptions.find((role) => role.code === selectedRoleCode);
                      if (r) r.permissions.forEach((p) => eff.add(p));
                      void onReview(
                        selectedMember.accessRequestId!,
                        "APPROVED",
                        Array.from(eff),
                        selectedRoleCode || undefined,
                      );
                    }}
                  >
                    Approve Access
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() =>
                      void onReview(
                        selectedMember.accessRequestId!,
                        "REJECTED",
                        [],
                      )
                    }
                  >
                    Reject
                  </button>
                </div>
              )}

            <div className="member-modal-section-title">
              Additional Access
              <span style={{ fontSize: 11, color: "var(--text-3)", fontWeight: 400, marginLeft: 8 }}>
                Individual permissions granted on top of the role
              </span>
            </div>
            {draftAdditional.length === 0 ? (
              <div
                style={{
                  padding: "10px 14px",
                  background: "var(--surface-faint)",
                  borderRadius: 8,
                  color: "var(--text-3)",
                  fontSize: 12,
                  marginBottom: 8,
                }}
              >
                No additional access. User inherits everything from role.
              </div>
            ) : (
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 6,
                  marginBottom: 8,
                }}
              >
                {draftAdditional.map((code) => (
                  <span
                    key={code}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      background: "var(--accent-soft)",
                      color: "var(--accent-strong)",
                      border: "1px solid var(--accent-line)",
                      borderRadius: 999,
                      padding: "3px 10px",
                      fontSize: 12,
                    }}
                  >
                    + {describePerm(code)}
                    <button
                      type="button"
                      aria-label={`Remove ${describePerm(code)}`}
                      onClick={() =>
                        setDraftAdditional((curr) =>
                          curr.filter((p) => p !== code),
                        )
                      }
                      style={{
                        border: "none",
                        background: "transparent",
                        cursor: "pointer",
                        color: "var(--accent-muted)",
                        fontSize: 14,
                        lineHeight: 1,
                        padding: 0,
                      }}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(2, 1fr)",
                gap: "4px 12px",
                padding: "10px",
                background: "var(--surface-faint)",
                borderRadius: 8,
                marginBottom: 12,
              }}
            >
              {NAV_PERMISSION_MODULES.flatMap((module) => {
                const all = module.children.length > 0
                  ? module.children.map(([id, label]) => [id, label] as const)
                  : ([[module.id, module.label] as const]);
                return all.map(([id, label]) => {
                  const inRole = selectedRoleCode
                    ? roleOptions
                        .find((r) => r.code === selectedRoleCode)
                        ?.permissions.includes(id)
                    : false;
                  const checked = draftAdditional.includes(id);
                  return (
                    <label
                      key={id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        fontSize: 12,
                        opacity: inRole ? 0.55 : 1,
                      }}
                      title={inRole ? "Inherited from role — grant as additional only if NOT in role" : undefined}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={inRole}
                        onChange={(event) =>
                          setDraftAdditional((curr) =>
                            event.target.checked
                              ? [...curr, id]
                              : curr.filter((p) => p !== id),
                          )
                        }
                      />
                      {label}
                      {inRole && (
                        <span style={{ fontSize: 10, color: "var(--success-text)", fontWeight: 500 }}>
                          (role)
                        </span>
                      )}
                    </label>
                  );
                });
              })}
            </div>

            <button
              type="button"
              className="btn btn-ghost"
              style={{ width: "100%", fontSize: 12, color: "var(--text-2-soft)", marginBottom: 8 }}
              onClick={() => setShowAdvanced((curr) => !curr)}
            >
              {showAdvanced ? "▾ Effective access (view all)" : "▸ Effective access (view all)"}
            </button>
            {showAdvanced && (
              <>
                <div className="member-modal-section-title">
                  Effective Permissions
                </div>
                <div
                  style={{
                    padding: "10px",
                    background: "var(--surface-faint)",
                    borderRadius: 8,
                    marginBottom: 12,
                    fontSize: 12,
                    lineHeight: 1.8,
                  }}
                >
                  {(() => {
                    const combined = Array.from(
                      new Set([
                        ...(roleOptions.find((r) => r.code === selectedRoleCode)
                          ?.permissions ?? []),
                        ...draftAdditional,
                      ]),
                    );
                    if (combined.length === 0) {
                      return <span style={{ color: "var(--text-3)" }}>No permissions assigned.</span>;
                    }
                    return NAV_PERMISSION_MODULES.map((module) => {
                      const items: Array<[string, string, "role" | "extra"]> = [];
                      const rolePerms =
                        roleOptions.find((r) => r.code === selectedRoleCode)
                          ?.permissions ?? [];
                      if (module.children.length === 0) {
                        const fromRole = rolePerms.includes(module.id);
                        const fromExtra = draftAdditional.includes(module.id);
                        if (fromRole || fromExtra)
                          items.push([
                            module.id,
                            module.label,
                            fromRole ? "role" : "extra",
                          ]);
                      } else {
                        for (const [cid, clabel] of module.children) {
                          const fromRole = rolePerms.includes(cid);
                          const fromExtra = draftAdditional.includes(cid);
                          if (fromRole || fromExtra)
                            items.push([cid, clabel, fromRole ? "role" : "extra"]);
                        }
                      }
                      if (items.length === 0) return null;
                      return (
                        <div key={module.id} style={{ marginBottom: 4 }}>
                          <div style={{ fontWeight: 600 }}>{module.label}</div>
                          <div style={{ paddingLeft: 12 }}>
                            {items.map(([id, label, source]) => (
                              <div key={id}>
                                • {label}
                                <span
                                  style={{
                                    marginLeft: 6,
                                    fontSize: 10,
                                    color:
                                      source === "role" ? "var(--success-text)" : "var(--accent)",
                                  }}
                                >
                                  [{source}]
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    });
                  })()}
                </div>
              </>
            )}

            {saved && (
              <div className="auth-success" role="status">
                Changes saved
              </div>
            )}
            <div className="member-modal-actions">
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => {
                  void onRevoke(selectedMember.id);
                  setSelectedMember(null);
                }}
              >
                Revoke Access
              </button>
              <span />
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setSelectedMember(null)}
              >{copy.common.cancel}</button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void save()}
              >
                Save Changes
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
};
