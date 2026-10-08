import React from "react";
import { MemberSection } from "../users/MemberSection";
import { RolesSection } from "../users/RolesSection";
import type { Member } from "../users/types";

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
  onJobRole,
  onAuthority,
  onAssignRole,
  onSetAdditionalPermissions,
  onCreateRole,
  onUpdateRole,
  onDeleteRole,
}: {
  username: string;
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
  onJobRole: (id: string, jobRole: string) => Promise<void>;
  onAuthority: (id: string, authorityLevel: number) => Promise<void>;
  onAssignRole: (userId: string, roleCode: string) => Promise<void>;
  onSetAdditionalPermissions: (userId: string, permissions: string[]) => Promise<void>;
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
            onJobRole={onJobRole}
            onAuthority={onAuthority}
            onAssignRole={onAssignRole}
            onSetAdditionalPermissions={onSetAdditionalPermissions}
          />
        </>
      )}
    </div>
  </div>
);
