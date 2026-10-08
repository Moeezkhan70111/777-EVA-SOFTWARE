import type { AccessStatus, LoginPolicy, UserRole } from "@erp/domain";

export interface Member {
  id: string;
  username: string;
  role: UserRole;
  jobRole: string;
  authorityLevel: number;
  accessStatus: AccessStatus;
  permissions: string[];
  lastLoginAt: string | null;
  accessRequestId?: string | null;
  roleCode?: string | null;
  roleName?: string | null;
  additionalPermissions?: string[];
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
