import { BRAND_LOGO_WHITE_URL } from "../../config/branding";
import React, { useCallback, useRef, useState } from "react";
import type { AppRoute } from "../../app/routes";
import type { AuthUser } from "../../types/desktopApi";
import { SidebarNav } from "../../features/navigation/SidebarNav";
import type { StoreDirection } from "../../features/store/storeOperators";
import { useDismissOnOutsideClick } from "../../hooks/useDismissOnOutsideClick";

/* ── Icon helpers ─────────────────────────────────────── */
const ChevronDown = () => (
  <svg className="chevron" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const UserIcon = () => (
  <svg
    className="profile-menu-user-icon"
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
  >
    <circle cx="12" cy="8" r="3.25" stroke="currentColor" strokeWidth="1.8" />
    <path
      d="M5.5 19c.7-3.15 3.05-4.75 6.5-4.75s5.8 1.6 6.5 4.75"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
    />
  </svg>
);

// Every permission an administrator can give a role or a user (Profile & Roles). A page the
// user holds the permission for appears as a card on their Home and as a row in the sidebar
// (features/navigation/navCatalogue.ts).
//
// "navbar" is no longer offered: every role now has the sidebar. Rows that still hold it in
// the database are harmless and are left untouched.
export const NAV_PERMISSION_MODULES = [
  {
    id: "dashboard",
    label: "Business Overview (KPIs)",
    children: [],
  },
  {
    id: "workspace",
    label: "Workspace",
    children: [],
  },
  {
    id: "scanning",
    label: "Scanning",
    children: [
      ["live-production", "Live Production"],
      ["live-dispatch", "Live Dispatch"],
      ["live-return", "Return Scanning"],
    ],
  },
  {
    id: "store-scanning",
    label: "Store Scanning",
    children: [],
  },
  {
    // The Munshi's station screen. What they may DO there comes from Gatepass and Stock.
    id: "munshi",
    label: "Munshi Station",
    children: [],
  },
  {
    // "gatepass" covers viewing, creating and printing; cancelling is granted separately.
    id: "gatepass",
    label: "Gatepass",
    children: [
      ["gatepass", "Gatepass (view / create / print)"],
      ["gatepass-cancel", "Cancel Gatepass"],
    ],
  },
  {
    id: "inventory",
    label: "Inventory",
    children: [
      ["stock", "Current Stock"],
      ["history", "Stock History"],
      ["daily-production", "Daily Production"],
      ["daily-dispatch", "Daily Dispatch"],
      ["production-history", "Production History"],
      ["dispatch-history", "Dispatch History"],
      ["return-history", "Return History"],
      ["raw-material-qr-generator", "Raw Material Labels"],
      ["raw-material-setup", "Raw Material Setup"],
      ["raw-material-input", "Raw Material Input"],
      ["raw-material-output", "Raw Material Output"],
    ],
  },
  {
    // A page of its own (not under Inventory), the same as in the sidebar.
    id: "machine-program",
    label: "Machine Program",
    children: [],
  },
  {
    id: "masters",
    label: "Setup",
    children: [
      ["party-list", "Party List"],
      ["party-form", "Add / Edit Party"],
      ["product-list", "Product List"],
      ["product-form", "Add / Edit Product"],
      ["product-lists", "Fields Management"],
      ["qr-generator", "QR Generator"],
      ["qr-management", "QR Management"],
      ["qr-journey", "QR Journey"],
      ["discount-policy", "Discount Policy"],
    ],
  },
  {
    id: "billing",
    label: "Billing",
    children: [
      ["sale-voucher-form", "Sale Vouchers"],
      ["sale-voucher-list", "Voucher List"],
      ["cash-voucher-form", "Cash Voucher"],
      ["cash-voucher-list", "Cash Voucher List"],
      ["customer-ledger", "Customer Ledger"],
      ["customer-balance", "Customer Balance"],
      ["purchase-voucher-form", "Purchase Bill"],
      ["purchase-voucher-list", "Purchase Bill List"],
      ["supplier-ledger", "Supplier Ledger"],
      ["supplier-balance", "Supplier Balance"],
    ],
  },
  {
    id: "settings",
    label: "Settings",
    children: [],
  },
  {
    id: "health",
    label: "Health",
    children: [],
  },
  {
    id: "logs",
    label: "Logs",
    children: [],
  },
] as const;

interface NavbarProps {
  current: AppRoute;
  onSelect: (route: AppRoute) => void;
  appVersion: string;
  onBackup: () => void;
  /** The signed-in user. The sidebar lists only the pages their role has been given. */
  user: AuthUser | null;
  /** For a store operator: the job they have picked, whose pages the sidebar lists. */
  storeJob?: StoreDirection | null;
  onProfile: () => void;
  onChangePassword: () => void;
  onLogout: () => void;
  accessRequests?: Array<{
    id: string;
    username: string;
    status: "PENDING" | "APPROVED" | "REJECTED";
  }>;
  roleOptions?: Array<{ code: string; name: string; permissions: string[] }>;
  onReviewAccessRequest?: (
    requestId: string,
    decision: "APPROVED" | "REJECTED",
    permissions?: string[],
    roleCode?: string,
  ) => void;
  permissionRequests?: Array<{
    id: string;
    userId: string;
    username: string;
    permissionCode: string;
    reason: string | null;
    status: "PENDING" | "APPROVED" | "REJECTED";
  }>;
  onReviewPermissionRequest?: (
    requestId: string,
    decision: "APPROVED" | "REJECTED",
  ) => void;
  notifications?: Array<{
    id: string;
    title: string;
    message: string;
    createdAt: string;
    readAt: string | null;
    kind?: string | null;
    entityId?: string | null;
    severity?: "INFO" | "WARNING" | "CRITICAL";
  }>;
  onNotificationClick?: (notification: {
    id: string;
    title: string;
    message: string;
    createdAt: string;
    readAt: string | null;
    kind?: string | null;
    entityId?: string | null;
    severity?: "INFO" | "WARNING" | "CRITICAL";
  }) => void;
  savedProfiles?: Array<{
    id: string;
    username: string;
    token: string;
    role: "USER" | "ADMIN";
    lastUsedAt?: string;
  }>;
  onSwitchProfile?: (token: string) => Promise<void> | void;
  onAddAccount?: () => void;
}

const permLabelMap: Record<string, string> = {};
for (const module of NAV_PERMISSION_MODULES) {
  permLabelMap[module.id] = module.label;
  for (const [childId, childLabel] of module.children) {
    permLabelMap[childId] = childLabel;
  }
}
const describePermission = (code: string) => permLabelMap[code] ?? code;

export const Navbar = ({
  current,
  onSelect,
  appVersion,
  onBackup,
  user,
  storeJob = null,
  onProfile,
  onChangePassword,
  onLogout,
  accessRequests = [],
  roleOptions = [],
  onReviewAccessRequest,
  permissionRequests = [],
  onReviewPermissionRequest,
  notifications = [],
  onNotificationClick,
  savedProfiles = [],
  onSwitchProfile,
  onAddAccount,
}: NavbarProps) => {
  const [openProfile, setOpenProfile] = useState(false);
  const [openNotifications, setOpenNotifications] = useState(false);
  const [requestPermissions, setRequestPermissions] = useState<
    Record<string, string[]>
  >({});
  const [requestRoleCodes, setRequestRoleCodes] = useState<
    Record<string, string>
  >({});
  const [expandedRequests, setExpandedRequests] = useState<
    Record<string, boolean>
  >({});
  const profileRef = useRef<HTMLDivElement | null>(null);
  const notificationsRef = useRef<HTMLDivElement | null>(null);

  // Both pop-ups close on a click anywhere else on the screen, or on Escape.
  const closeProfile = useCallback(() => setOpenProfile(false), []);
  const closeNotifications = useCallback(() => setOpenNotifications(false), []);
  useDismissOnOutsideClick(profileRef, openProfile, closeProfile);
  useDismissOnOutsideClick(notificationsRef, openNotifications, closeNotifications);

  return (
    <nav className="navbar">
      {/* Brand */}
      <div className="navbar-brand">
        <img
          src={BRAND_LOGO_WHITE_URL}
          alt="777 Seven Logo"
          className="navbar-logo-img"
        />
      </div>

      {/* Home and the pages this user's role has been given — the same cards Home shows. */}
      {user && <SidebarNav user={user} current={current} onSelect={onSelect} storeJob={storeJob} />}

      {/* Right side */}
      <div className="navbar-right">
        <span className="navbar-version">{appVersion}</span>
        {user && (
          <div className="notification-menu-wrap" ref={notificationsRef}>
            <button
              type="button"
              className="notification-trigger"
              aria-label="Access requests"
              title="Access requests"
              aria-expanded={openNotifications}
              onClick={() => setOpenNotifications((value) => !value)}
            >
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9Zm-8 12h4"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
              </svg>
              {accessRequests.filter((request) => request.status === "PENDING")
                .length +
                permissionRequests.filter((pr) => pr.status === "PENDING").length +
                notifications.filter((notification) => !notification.readAt)
                  .length >
                0 && (
                <span className="notification-badge">
                  {accessRequests.filter(
                    (request) => request.status === "PENDING",
                  ).length +
                    permissionRequests.filter((pr) => pr.status === "PENDING").length +
                    notifications.filter((notification) => !notification.readAt)
                      .length}
                </span>
              )}
            </button>
            {openNotifications && (
              <div className="notification-panel">
                <div className="notification-panel-title">Notifications</div>
                {notifications.map((notification) => (
                  <div
                    className={`user-notification${notification.readAt ? " read" : ""}${notification.severity === "CRITICAL" ? " is-critical" : notification.severity === "WARNING" ? " is-warning" : ""}`}
                    key={notification.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => onNotificationClick?.(notification)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onNotificationClick?.(notification);
                      }
                    }}
                  >
                    <strong>
                      {notification.severity === "CRITICAL" ? "⚠ " : ""}
                      {notification.title}
                    </strong>
                    <span>{notification.message}</span>
                  </div>
                ))}{" "}
                {user.role === "ADMIN" && (accessRequests.length > 0 || permissionRequests.length > 0) && (
                  <div className="notification-panel-title notification-panel-subtitle">
                    Access Requests
                  </div>
                )}
                {accessRequests.map((request) => (
                  <div className="access-request" key={request.id}>
                    <div className="access-request-head">
                      <strong>{request.username}</strong>
                      <span
                        className={`access-request-status ${request.status.toLowerCase()}`}
                      >
                        {request.status}
                      </span>
                    </div>
                    {request.status === "PENDING" && onReviewAccessRequest && (
                      <>
                        <label className="member-role-field" style={{ margin: "8px 0", display: "block" }}>
                          <span style={{ fontSize: "12px", color: "var(--text-3)", display: "block", marginBottom: "4px" }}>Role</span>
                          <select
                            value={requestRoleCodes[request.id] ?? ""}
                            onChange={(event) => {
                              const nextCode = event.target.value;
                              setRequestRoleCodes((current) => ({
                                ...current,
                                [request.id]: nextCode,
                              }));
                              const nextRole = roleOptions.find((role) => role.code === nextCode);
                              if (nextRole) {
                                setRequestPermissions((current) => ({
                                  ...current,
                                  [request.id]: [...nextRole.permissions],
                                }));
                              }
                            }}
                            style={{
                              width: "100%",
                              padding: "6px 10px",
                              borderRadius: "8px",
                              border: "1px solid #e5e7eb",
                              fontSize: "13px",
                              background: "var(--white)",
                            }}
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
                          style={{
                            width: "100%",
                            marginBottom: "8px",
                            fontSize: "12px",
                            color: "#4b5563",
                          }}
                          onClick={() =>
                            setExpandedRequests((current) => ({
                              ...current,
                              [request.id]: !current[request.id],
                            }))
                          }
                        >
                          {expandedRequests[request.id]
                            ? "▾ Additional Access (override)"
                            : "▸ Additional Access (override)"}
                        </button>
                        {expandedRequests[request.id] && (
                          <div
                            className="permission-selector"
                            style={{
                              background: "var(--surface-faint)",
                              padding: "10px",
                              borderRadius: "8px",
                              marginBottom: "8px",
                            }}
                          >
                            {NAV_PERMISSION_MODULES.map((module) => {
                              const hasChildren = module.children.length > 0;
                              const moduleEnabled =
                                (requestPermissions[request.id] ?? []).includes(
                                  module.id,
                                ) ||
                                module.children.some(([childId]) =>
                                  (requestPermissions[request.id] ?? []).includes(
                                    childId,
                                  ),
                                );
                              return (
                                <div
                                  key={module.id}
                                  style={{ marginBottom: "4px" }}
                                >
                                  <label
                                    style={{
                                      display: "flex",
                                      alignItems: "center",
                                      gap: "6px",
                                      fontSize: "12px",
                                    }}
                                  >
                                    <span
                                      style={{
                                        fontWeight: hasChildren
                                          ? 600
                                          : 400,
                                      }}
                                    >
                                      {module.label}
                                    </span>
                                    {!hasChildren && (
                                      <input
                                        type="checkbox"
                                        checked={(
                                          requestPermissions[request.id] ?? []
                                        ).includes(module.id)}
                                        onChange={(event) =>
                                          setRequestPermissions(
                                            (current) => ({
                                              ...current,
                                              [request.id]: event.target.checked
                                                ? [
                                                    ...new Set([
                                                      ...(current[
                                                        request.id
                                                      ] ?? []),
                                                      module.id,
                                                    ]),
                                                  ]
                                                : (current[request.id] ??
                                                    []
                                                  ).filter(
                                                    (item) =>
                                                      item !== module.id,
                                                  ),
                                            }),
                                          )
                                        }
                                      />
                                    )}
                                  </label>
                                  {hasChildren && (
                                    <div
                                      style={{
                                        paddingLeft: "16px",
                                        display: "grid",
                                        gridTemplateColumns: "1fr 1fr",
                                        gap: "2px 12px",
                                      }}
                                    >
                                      {module.children.map(
                                        ([childId, childLabel]) => (
                                          <label
                                            key={childId}
                                            style={{
                                              display: "flex",
                                              alignItems: "center",
                                              gap: "4px",
                                              fontSize: "11px",
                                              color: "#4b5563",
                                            }}
                                          >
                                            <input
                                              type="checkbox"
                                              checked={(
                                                requestPermissions[
                                                  request.id
                                                ] ?? []
                                              ).includes(childId)}
                                              onChange={(event) =>
                                                setRequestPermissions(
                                                  (current) => ({
                                                    ...current,
                                                    [request.id]: event.target
                                                      .checked
                                                      ? [
                                                          ...new Set([
                                                            ...(current[
                                                              request.id
                                                            ] ?? []),
                                                            childId,
                                                          ]),
                                                        ]
                                                      : (current[
                                                          request.id
                                                        ] ?? []
                                                      ).filter(
                                                        (item) =>
                                                          item !== childId,
                                                      ),
                                                  }),
                                                )
                                              }
                                            />
                                            {childLabel}
                                          </label>
                                        ),
                                      )}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                        <div className="access-request-actions">
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            onClick={() =>
                              onReviewAccessRequest(
                                request.id,
                                "APPROVED",
                                requestPermissions[request.id] ?? [],
                                requestRoleCodes[request.id] || undefined,
                              )
                            }
                          >
                            Approve Access
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() =>
                              onReviewAccessRequest(
                                request.id,
                                "REJECTED",
                                requestPermissions[request.id] ?? [],
                                requestRoleCodes[request.id] || undefined,
                              )
                            }
                          >
                            Reject Access
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ))}
                {user.role === "ADMIN" && permissionRequests.length > 0 && (
                  <div className="notification-panel-title notification-panel-subtitle">
                    Permission Requests
                  </div>
                )}
                {permissionRequests.map((pr) => (
                  <div className="access-request" key={pr.id}>
                    <div className="access-request-head">
                      <div>
                        <strong>{pr.username}</strong>
                        <div
                          style={{
                            fontSize: "12px",
                            color: "#4b5563",
                            marginTop: "2px",
                          }}
                        >
                          needs <strong>{describePermission(pr.permissionCode)}</strong>
                        </div>
                        {pr.reason && (
                          <div
                            style={{
                              fontSize: "11px",
                              color: "var(--text-3)",
                              marginTop: "4px",
                              fontStyle: "italic",
                            }}
                          >
                            “{pr.reason}”
                          </div>
                        )}
                      </div>
                      <span
                        className={`access-request-status ${pr.status.toLowerCase()}`}
                      >
                        {pr.status}
                      </span>
                    </div>
                    {pr.status === "PENDING" && onReviewPermissionRequest && (
                      <div className="access-request-actions">
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          onClick={() =>
                            onReviewPermissionRequest(pr.id, "APPROVED")
                          }
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() =>
                            onReviewPermissionRequest(pr.id, "REJECTED")
                          }
                        >
                          Reject
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={onBackup}
          title="Create Backup (Ctrl+B)"
        >
          Backup
        </button>
        {user && (
          <div className="profile-menu-wrap" ref={profileRef}>
            <button
              type="button"
              className="profile-menu-trigger"
              onClick={() => setOpenProfile((prev) => !prev)}
              aria-label="Open user menu"
              aria-expanded={openProfile}
              aria-haspopup="menu"
            >
              <span className="profile-menu-icon">
                <UserIcon />
              </span>
              <span className="profile-menu-name">{user.username}</span>
              <ChevronDown />
            </button>
            {openProfile && (
              <div className="profile-menu" role="menu" style={{ width: 235, padding: "8px" }}>
                <div style={{ padding: "4px 8px 8px", borderBottom: "1px solid var(--chrome-line)", marginBottom: 6 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className="profile-menu-icon" style={{ width: 28, height: 28 }}>
                      <UserIcon />
                    </span>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontWeight: 700, fontSize: "0.84rem", color: "var(--chrome-ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {user.username}
                      </div>
                      <div style={{ fontSize: "0.68rem", color: "var(--chrome-muted)", fontWeight: 600 }}>
                        {user.role === "ADMIN" ? "Administrator" : "Standard User"}
                      </div>
                    </div>
                  </div>
                </div>

                <div style={{ padding: "4px 8px 3px", fontSize: "0.68rem", fontWeight: 700, color: "var(--chrome-link-strong)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  Switch Profile
                </div>
                
                <div style={{ display: "flex", flexDirection: "column", gap: 2, marginBottom: 6 }}>
                  {savedProfiles && savedProfiles.length > 0 ? (
                    savedProfiles.map((p) => {
                      const isCurrent = p.id === user.id || p.username.toLowerCase() === user.username.toLowerCase();
                      return (
                        <button
                          key={p.id || p.token}
                          type="button"
                          className={`nav-dd-item ${isCurrent ? "active" : ""}`}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            padding: "6px 8px",
                            fontSize: "0.78rem",
                            borderRadius: 8,
                            opacity: isCurrent ? 1 : 0.85,
                          }}
                          onClick={() => {
                            if (!isCurrent && onSwitchProfile) {
                              void onSwitchProfile(p.token);
                            }
                            setOpenProfile(false);
                          }}
                        >
                          <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                            <span
                              style={{
                                width: 20,
                                height: 20,
                                borderRadius: "50%",
                                background: isCurrent ? "var(--chrome-link)" : "var(--neutral-300)",
                                color: "var(--white)",
                                display: "inline-flex",
                                alignItems: "center",
                                justifyContent: "center",
                                fontSize: "0.65rem",
                                fontWeight: 700,
                                flexShrink: 0,
                              }}
                            >
                              {p.username.slice(0, 1).toUpperCase()}
                            </span>
                            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: isCurrent ? 700 : 500 }}>
                              {p.username}
                            </span>
                          </div>
                          {isCurrent ? (
                            <span style={{ fontSize: "0.64rem", color: "var(--chrome-link-strong)", fontWeight: 700, background: "rgba(49,130,206,0.12)", padding: "1px 6px", borderRadius: 999 }}>Active</span>
                          ) : (
                            <span style={{ fontSize: "0.64rem", color: "var(--chrome-muted)" }}>Switch</span>
                          )}
                        </button>
                      );
                    })
                  ) : null}

                  {onAddAccount && (
                    <button
                      type="button"
                      className="nav-dd-item"
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "6px 8px",
                        fontSize: "0.76rem",
                        color: "var(--chrome-link-strong)",
                        fontWeight: 600,
                      }}
                      onClick={() => {
                        onAddAccount();
                        setOpenProfile(false);
                      }}
                    >
                      <span style={{ fontSize: "0.9rem", fontWeight: 700 }}>+</span> Add Account
                    </button>
                  )}
                </div>

                <div style={{ borderTop: "1px solid var(--chrome-line)", margin: "4px 0" }} />

                <button
                  type="button"
                  className="profile-menu-item"
                  onClick={() => {
                    onProfile();
                    setOpenProfile(false);
                  }}
                >
                  Profile & Roles
                </button>
                <button
                  type="button"
                  className="profile-menu-item"
                  onClick={() => {
                    onChangePassword();
                    setOpenProfile(false);
                  }}
                >
                  Change Password
                </button>
                <button
                  type="button"
                  className="profile-menu-item danger"
                  onClick={() => {
                    onLogout();
                    setOpenProfile(false);
                  }}
                >
                  Logout
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </nav>
  );
};
