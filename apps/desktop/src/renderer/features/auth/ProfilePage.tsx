import React from "react";
import { MemberSection } from "../users/MemberSection";
import { RolesSection } from "../users/RolesSection";
import type { Member } from "../users/types";
import type { AuthUser, MemberAccessChange } from "../../types/desktopApi";
import { CloudAccountsSwitchCard } from "./CloudAccountsSwitchCard";
import { CloudRoleCopyCard } from "./CloudRoleCopyCard";

export const ProfilePage = ({
  username,
  onLogout,
  onChangePassword,
  members,
  roleOptions,
  roles,
  onPermissions,
  onRevoke,
  onReview,
  onSaveAccess,
  onCreateRole,
  onUpdateRole,
  onDeleteRole,
  onSwitchedToCloud,
}: {
  username: string;
  /** Admins only: the session the switch to cloud accounts leaves them with (docs/41). */
  onSwitchedToCloud?: (user: AuthUser, token: string) => Promise<void>;
  onLogout: () => void;
  onChangePassword: () => void;
  members?: Member[];
  roleOptions: Array<{ code: string; name: string; permissions: string[] }>;
  roles: Array<{
    code: string;
    name: string;
    description: string | null;
    permissions: string[];
    memberCount: number;
    loginPolicy?: "ALWAYS_LOGGED_IN" | "DAILY_LOGIN";
  }>;
  onPermissions?: (id: string, permissions: string[]) => Promise<void>;
  onRevoke?: (id: string) => Promise<void>;
  onReview: (
    requestId: string,
    decision: "APPROVED" | "REJECTED",
    permissions: string[],
    roleCode?: string,
  ) => Promise<void>;
  onSaveAccess: (userId: string, access: MemberAccessChange) => Promise<boolean>;
  onCreateRole: (input: { name: string; description?: string; permissions: string[]; loginPolicy?: "ALWAYS_LOGGED_IN" | "DAILY_LOGIN" }) => Promise<void>;
  onUpdateRole: (
    code: string,
    input: { name?: string; description?: string; permissions?: string[]; loginPolicy?: "ALWAYS_LOGGED_IN" | "DAILY_LOGIN" },
  ) => Promise<void>;
  onDeleteRole: (code: string) => Promise<void>;
}) => (
  <div className="auth-page-shell profile-page-shell">
    <div className="profile-card card">
      <div className="card-eyebrow">Account</div>
      <h1 className="page-title">Profile</h1>
      <div className="profile-username">{username}</div>
      <div className="profile-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={onChangePassword}
        >
          Change Password
        </button>
        <button type="button" className="btn btn-secondary" onClick={onLogout}>
          Logout
        </button>
      </div>
      {members && onPermissions && onRevoke && (
        <>
          {onSwitchedToCloud && <CloudAccountsSwitchCard onSwitched={onSwitchedToCloud} />}
          <CloudRoleCopyCard />
          <RolesSection
            roles={roles}
            onCreate={onCreateRole}
            onUpdate={onUpdateRole}
            onDelete={onDeleteRole}
          />
          <MemberSection
            members={members}
            roleOptions={roleOptions}
            onPermissions={onPermissions}
            onRevoke={onRevoke}
            onReview={onReview}
            onSaveAccess={onSaveAccess}
          />
        </>
      )}
    </div>
  </div>
);
