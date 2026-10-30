import React, { useEffect, useRef, useState } from "react";
import type { AuthUser } from "../../types/desktopApi";
import type { SavedProfile } from "./session";

export const FloatingProfileMenu = ({
  user,
  savedProfiles,
  onSwitchProfile,
  onAddAccount,
  onLogout,
  onChangePassword,
  onProfile,
  avatarSrc,
}: {
  user: AuthUser;
  savedProfiles: SavedProfile[];
  onSwitchProfile: (token: string) => Promise<void> | void;
  onAddAccount: () => void;
  onLogout: () => void;
  onChangePassword: () => void;
  onProfile: () => void;
  /**
   * A picture to show instead of the pill: the menu then sits where it is placed, not floating
   * (the Store page header, 0.4.1). The menu it opens is the same.
   */
  avatarSrc?: string;
}) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleOutside = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    if (open) {
      document.addEventListener("mousedown", handleOutside);
      return () => document.removeEventListener("mousedown", handleOutside);
    }
  }, [open]);

  return (
    <div className={avatarSrc ? "profile-avatar-wrap" : "floating-profile-wrap"} ref={ref}>
      {avatarSrc ? (
        <button type="button" className="profile-avatar" onClick={() => setOpen((prev) => !prev)} aria-label="User Profile" aria-expanded={open}>
          <img src={avatarSrc} alt="" />
        </button>
      ) : (
      <button
        type="button"
        className="floating-profile-pill"
        onClick={() => setOpen((prev) => !prev)}
        aria-label="User Profile"
        aria-expanded={open}
      >
        <span
          style={{
            width: 22,
            height: 22,
            borderRadius: "50%",
            background: "var(--chrome-link)",
            color: "var(--surface)",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "0.7rem",
            fontWeight: 700,
          }}
        >
          {user.username.slice(0, 1).toUpperCase()}
        </span>
        <span
          style={{
            maxWidth: 110,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {user.username}
        </span>
        <span style={{ fontSize: "0.6rem", opacity: 0.6 }}>▼</span>
      </button>
      )}

      {open && (
        <div
          className="profile-menu"
          role="menu"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            width: 235,
            padding: "8px",
            background: "var(--chrome-bg)",
            border: "1px solid var(--glass-85)",
            borderRadius: 14,
            boxShadow: "8px 8px 20px var(--chrome-shadow), -8px -8px 20px var(--surface)",
          }}
        >
          <div
            style={{
              padding: "4px 8px 8px",
              borderBottom: "1px solid var(--chrome-line)",
              marginBottom: 6,
            }}
          >
            <div
              style={{
                fontWeight: 700,
                fontSize: "0.84rem",
                color: "var(--chrome-ink)",
              }}
            >
              {user.username}
            </div>
            <div
              style={{
                fontSize: "0.68rem",
                color: "var(--chrome-muted)",
                fontWeight: 600,
              }}
            >
              {user.role === "ADMIN" ? "Administrator" : "Standard User"}
            </div>
          </div>

          <div
            style={{
              padding: "4px 8px 3px",
              fontSize: "0.68rem",
              fontWeight: 700,
              color: "var(--chrome-link-strong)",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
            }}
          >
            Switch Profile
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 2,
              marginBottom: 6,
            }}
          >
            {savedProfiles.map((p) => {
              const isCurrent =
                p.id === user.id ||
                p.username.toLowerCase() === user.username.toLowerCase();
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
                  }}
                  onClick={() => {
                    if (!isCurrent) {
                      void onSwitchProfile(p.token);
                    }
                    setOpen(false);
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      minWidth: 0,
                    }}
                  >
                    <span
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: "50%",
                        background: isCurrent ? "var(--chrome-link)" : "var(--chrome-avatar-idle)",
                        color: "var(--surface)",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: "0.6rem",
                        fontWeight: 700,
                      }}
                    >
                      {p.username.slice(0, 1).toUpperCase()}
                    </span>
                    <span
                      style={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        fontWeight: isCurrent ? 700 : 500,
                      }}
                    >
                      {p.username}
                    </span>
                  </div>
                  {isCurrent ? (
                    <span
                      style={{
                        fontSize: "0.64rem",
                        color: "var(--chrome-link-strong)",
                        fontWeight: 700,
                        background: "var(--info-bg)",
                        padding: "1px 6px",
                        borderRadius: 999,
                      }}
                    >
                      Active
                    </span>
                  ) : (
                    <span style={{ fontSize: "0.64rem", color: "var(--chrome-muted)" }}>
                      Switch
                    </span>
                  )}
                </button>
              );
            })}

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
                setOpen(false);
              }}
            >
              <span style={{ fontSize: "0.9rem", fontWeight: 700 }}>+</span> Add
              Account
            </button>
          </div>

          <div
            style={{
              borderTop: "1px solid var(--chrome-line)",
              margin: "4px 0",
            }}
          />

          <button
            type="button"
            className="profile-menu-item"
            onClick={() => {
              onProfile();
              setOpen(false);
            }}
          >
            Profile & Roles
          </button>
          <button
            type="button"
            className="profile-menu-item"
            onClick={() => {
              onChangePassword();
              setOpen(false);
            }}
          >
            Change Password
          </button>
          <button
            type="button"
            className="profile-menu-item danger"
            onClick={() => {
              onLogout();
              setOpen(false);
            }}
          >
            Logout
          </button>
        </div>
      )}
    </div>
  );
};
