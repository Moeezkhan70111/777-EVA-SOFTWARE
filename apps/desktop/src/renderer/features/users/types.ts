import { ACCESS_STATUS } from "@erp/domain";
import type { AccessStatus, LoginPolicy, UserRole } from "@erp/domain";

/**
 * A member's status. A person, unlike a request, can also be REVOKED: under cloud accounts that is
 * what an admin's revoke stores (a local revoke stores REJECTED).
 */
export const MEMBER_STATUS = { ...ACCESS_STATUS, REVOKED: "REVOKED" } as const;
export type MemberStatus = (typeof MEMBER_STATUS)[keyof typeof MEMBER_STATUS];

export interface Member {
  id: string;
  username: string;
  role: UserRole;
  jobRole: string;
  authorityLevel: number;
  accessStatus: MemberStatus;
  permissions: string[];
  lastLoginAt: string | null;
  accessRequestId?: string | null;
  roleCode?: string | null;
  roleName?: string | null;
  additionalPermissions?: string[];
  /** Cloud accounts: while waiting, what this person had before their account moved up (cloud 023). */
  suggestedAccess?: { roleCode: string | null; extraPermissions: string[]; jobRole: string; authorityLevel: number } | null;
}

export interface RoleOption {
  code: string;
  name: string;
  permissions: string[];
}

export interface RoleRecord extends RoleOption {
  description: string | null;
  memberCount: number;
  loginPolicy?: LoginPolicy;
}

export interface AccessRequestRow {
  id: string;
  username: string;
  status: AccessStatus;
  requestedAt: string;
  reviewedAt: string | null;
}

export interface PermissionRequestAdminView {
  id: string;
  userId: string;
  username: string;
  permissionCode: string;
  reason: string | null;
  status: AccessStatus;
  createdAt: string;
  reviewedAt: string | null;
  reviewNotes: string | null;
}

/** A notice in the bell. Typed ones (kind + entityId) open a screen; severity says how loudly. */
export interface UserNotification {
  id: string;
  title: string;
  message: string;
  createdAt: string;
  readAt: string | null;
  kind?: string | null;
  entityId?: string | null;
  severity?: "INFO" | "WARNING" | "CRITICAL";
}
