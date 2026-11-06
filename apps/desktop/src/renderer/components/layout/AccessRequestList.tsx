import React, { useState } from "react";
import { copy } from "../../config/copy";
import { NAV_PERMISSION_MODULES } from "./Navbar";

// An administrator's access and permission requests, listed in the bell under their own
// notifications (HeaderActions). Moved here unchanged from the sidebar, where the bell used to
// live: approving a request still sends the role and the permissions picked on its card.

type ReviewStatus = "PENDING" | "APPROVED" | "REJECTED";
type Decision = "APPROVED" | "REJECTED";

export interface AccessRequestSummary {
  id: string;
  username: string;
  status: ReviewStatus;
}

export interface PermissionRequestSummary {
  id: string;
  userId: string;
  username: string;
  permissionCode: string;
  reason: string | null;
  status: ReviewStatus;
}

export interface RoleChoice {
  code: string;
  name: string;
  permissions: string[];
}

export interface AccessRequestListProps {
  isAdmin: boolean;
  accessRequests: readonly AccessRequestSummary[];
  roleOptions: readonly RoleChoice[];
  onReviewAccessRequest?: (requestId: string, decision: Decision, permissions?: string[], roleCode?: string) => void;
  permissionRequests: readonly PermissionRequestSummary[];
  onReviewPermissionRequest?: (requestId: string, decision: Decision) => void;
}

/** What is waiting for an administrator: shown on the bell beside the user's own unread notifications. */
export const pendingRequestCount = (
  accessRequests: readonly AccessRequestSummary[],
  permissionRequests: readonly PermissionRequestSummary[]
): number =>
  accessRequests.filter((request) => request.status === "PENDING").length +
  permissionRequests.filter((request) => request.status === "PENDING").length;

const permLabelMap: Record<string, string> = {};
for (const module of NAV_PERMISSION_MODULES) {
  permLabelMap[module.id] = module.label;
  for (const [childId, childLabel] of module.children) {
    permLabelMap[childId] = childLabel;
  }
}
const describePermission = (code: string) => permLabelMap[code] ?? code;

const withPermission = (current: string[], code: string, on: boolean): string[] =>
  on ? [...new Set([...current, code])] : current.filter((item) => item !== code);

interface PermissionPickerProps {
  selected: string[];
  onChange: (next: string[]) => void;
}

/** The "Additional Access (override)" checklist on an access request. */
const PermissionPicker: React.FC<PermissionPickerProps> = ({ selected, onChange }) => (
  <div className="permission-selector" style={{ background: "var(--surface-faint)", padding: "10px", borderRadius: "8px", marginBottom: "8px" }}>
    {NAV_PERMISSION_MODULES.map((module) => {
      const hasChildren = module.children.length > 0;
      return (
        <div key={module.id} style={{ marginBottom: "4px" }}>
          <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px" }}>
            <span style={{ fontWeight: hasChildren ? 600 : 400 }}>{module.label}</span>
            {!hasChildren && (
              <input
                type="checkbox"
                checked={selected.includes(module.id)}
                onChange={(event) => onChange(withPermission(selected, module.id, event.target.checked))}
              />
            )}
          </label>
          {hasChildren && (
            <div style={{ paddingLeft: "16px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px 12px" }}>
              {module.children.map(([childId, childLabel]) => (
                <label key={childId} style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "11px", color: "var(--text-2)" }}>
                  <input
                    type="checkbox"
                    checked={selected.includes(childId)}
                    onChange={(event) => onChange(withPermission(selected, childId, event.target.checked))}
                  />
                  {childLabel}
                </label>
              ))}
            </div>
          )}
        </div>
      );
    })}
  </div>
);

interface AccessRequestCardProps {
  request: AccessRequestSummary;
  roleOptions: readonly RoleChoice[];
  onReview?: AccessRequestListProps["onReviewAccessRequest"];
}

const AccessRequestCard: React.FC<AccessRequestCardProps> = ({ request, roleOptions, onReview }) => {
  const [permissions, setPermissions] = useState<string[]>([]);
  const [roleCode, setRoleCode] = useState("");
  const [showOverride, setShowOverride] = useState(false);

  const pickRole = (code: string) => {
    setRoleCode(code);
    const role = roleOptions.find((option) => option.code === code);
    if (role) setPermissions([...role.permissions]);
  };

  return (
    <div className="access-request">
      <div className="access-request-head">
        <strong>{request.username}</strong>
        <span className={`access-request-status ${request.status.toLowerCase()}`}>{request.status}</span>
      </div>
      {request.status === "PENDING" && onReview && (
        <>
          <label className="member-role-field" style={{ margin: "8px 0", display: "block" }}>
            <span style={{ fontSize: "12px", color: "var(--text-3)", display: "block", marginBottom: "4px" }}>Role</span>
            <select
              value={roleCode}
              onChange={(event) => pickRole(event.target.value)}
              style={{ width: "100%", padding: "6px 10px", borderRadius: "8px", border: "1px solid var(--border)", fontSize: "13px", background: "var(--white)" }}
            >
              <option value="">Select a role…</option>
              {roleOptions.map((role) => (
                <option value={role.code} key={role.code}>
                  {role.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            style={{ width: "100%", marginBottom: "8px", fontSize: "12px", color: "var(--text-2)" }}
            aria-expanded={showOverride}
            onClick={() => setShowOverride((open) => !open)}
          >
            {showOverride ? "▾ Additional Access (override)" : "▸ Additional Access (override)"}
          </button>
          {showOverride && <PermissionPicker selected={permissions} onChange={setPermissions} />}
          <div className="access-request-actions">
            <button type="button" className="btn btn-primary btn-sm" onClick={() => onReview(request.id, "APPROVED", permissions, roleCode || undefined)}>
              Approve Access
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => onReview(request.id, "REJECTED", permissions, roleCode || undefined)}>
              Reject Access
            </button>
          </div>
        </>
      )}
    </div>
  );
};

interface PermissionRequestCardProps {
  request: PermissionRequestSummary;
  onReview?: AccessRequestListProps["onReviewPermissionRequest"];
}

const PermissionRequestCard: React.FC<PermissionRequestCardProps> = ({ request, onReview }) => (
  <div className="access-request">
    <div className="access-request-head">
      <div>
        <strong>{request.username}</strong>
        <div style={{ fontSize: "12px", color: "var(--text-2)", marginTop: "2px" }}>
          needs <strong>{describePermission(request.permissionCode)}</strong>
        </div>
        {request.reason && (
          <div style={{ fontSize: "11px", color: "var(--text-3)", marginTop: "4px", fontStyle: "italic" }}>“{request.reason}”</div>
        )}
      </div>
      <span className={`access-request-status ${request.status.toLowerCase()}`}>{request.status}</span>
    </div>
    {request.status === "PENDING" && onReview && (
      <div className="access-request-actions">
        <button type="button" className="btn btn-primary btn-sm" onClick={() => onReview(request.id, "APPROVED")}>
          Approve
        </button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => onReview(request.id, "REJECTED")}>
          Reject
        </button>
      </div>
    )}
  </div>
);

export const AccessRequestList: React.FC<AccessRequestListProps> = (props) => {
  const { isAdmin, accessRequests, permissionRequests } = props;
  return (
    <>
      {isAdmin && (accessRequests.length > 0 || permissionRequests.length > 0) && (
        <div className="notification-panel-title notification-panel-subtitle">{copy.appHeader.accessRequests}</div>
      )}
      {accessRequests.map((request) => (
        <AccessRequestCard key={request.id} request={request} roleOptions={props.roleOptions} onReview={props.onReviewAccessRequest} />
      ))}
      {isAdmin && permissionRequests.length > 0 && (
        <div className="notification-panel-title notification-panel-subtitle">{copy.appHeader.permissionRequests}</div>
      )}
      {permissionRequests.map((request) => (
        <PermissionRequestCard key={request.id} request={request} onReview={props.onReviewPermissionRequest} />
      ))}
    </>
  );
};
