import { useCallback, useEffect, useRef, useState } from "react";
import { ACCESS_STATUS, USER_ROLE } from "@erp/domain";
import type { LoginPolicy } from "@erp/domain";

export type ReviewDecision = "APPROVED" | "REJECTED";
import type { NoticeKind } from "../../state/NotificationsContext";
import type { AuthUser, DesktopApi } from "../../types/desktopApi";
import type { AccessRequestRow, Member, PermissionRequestAdminView, RoleOption, RoleRecord, UserNotification } from "./types";

// Administrative data shown in the shell: members, roles, access/permission requests and
// the signed-in user's notifications. Polled while an admin is signed in, exactly as the
// shell did before this was extracted from App.tsx.

const ADMIN_REFRESH_MS = 5000;

interface UseAdminDataArgs {
  api: DesktopApi;
  push: (kind: NoticeKind, title: string, message?: string, ttlMs?: number) => void;
  session: AuthUser | null;
  sessionToken: string | null;
  setAuthError: (message: string | null) => void;
}

export interface RoleInput {
  name: string;
  description?: string;
  permissions: string[];
  loginPolicy?: LoginPolicy;
}

export interface RoleUpdate {
  name?: string;
  description?: string;
  permissions?: string[];
  loginPolicy?: LoginPolicy;
}

export interface AdminData {
  members: Member[];
  roles: RoleRecord[];
  roleOptions: RoleOption[];
  accessRequests: AccessRequestRow[];
  permissionRequests: PermissionRequestAdminView[];
  userNotifications: UserNotification[];
  handleNotificationClick: (notification: UserNotification) => void;
  handleReviewAccessRequest: (requestId: string, decision: ReviewDecision, permissions?: string[], roleCode?: string) => Promise<void>;
  handleMemberPermissions: (userId: string, permissions: string[]) => Promise<void>;
  handleMemberRoleAssignment: (userId: string, roleCode: string) => Promise<void>;
  handleMemberJobRole: (userId: string, jobRole: string) => Promise<void>;
  handleMemberAuthority: (userId: string, authorityLevel: number) => Promise<void>;
  handleMemberRevoke: (userId: string) => Promise<void>;
  handleSetAdditionalPermissions: (userId: string, permissions: string[]) => Promise<void>;
  handleCreateRole: (input: RoleInput) => Promise<void>;
  handleUpdateRole: (code: string, input: RoleUpdate) => Promise<void>;
  handleDeleteRole: (code: string) => Promise<void>;
  handleReviewPermissionRequest: (requestId: string, decision: ReviewDecision, reviewNotes?: string) => Promise<void>;
}

const toRoleOptions = (roles: RoleRecord[]): RoleOption[] =>
  roles.map((role) => ({ code: role.code, name: role.name, permissions: role.permissions }));

export const useAdminData = ({ api, push, session, sessionToken, setAuthError }: UseAdminDataArgs): AdminData => {
  const [members, setMembers] = useState<Member[]>([]);
  const [roles, setRoles] = useState<RoleRecord[]>([]);
  const [accessRequests, setAccessRequests] = useState<AccessRequestRow[]>([]);
  const [permissionRequests, setPermissionRequests] = useState<PermissionRequestAdminView[]>([]);
  const [userNotifications, setUserNotifications] = useState<UserNotification[]>([]);
  /** Unread CRITICAL / WARNING notices already shouted about this session, so each shouts once. */
  const shouted = useRef<Set<string>>(new Set());

  const isAdmin = session?.role === USER_ROLE.ADMIN;
  const roleOptions = toRoleOptions(roles);

  const refreshRoles = useCallback(async () => {
    if (!sessionToken || !isAdmin || typeof api.listRoles !== "function") return;
    const result = await api.listRoles(sessionToken);
    if (result.accepted) setRoles(result.roles);
  }, [api, isAdmin, sessionToken]);

  const refreshMembers = useCallback(async () => {
    if (!sessionToken || !isAdmin || typeof api.listMembers !== "function") return;
    const result = await api.listMembers(sessionToken);
    if (result.accepted) setMembers(result.members);
  }, [api, isAdmin, sessionToken]);

  const refreshAccessRequests = useCallback(async () => {
    if (!sessionToken || !isAdmin) return;
    const result = await api.getAccessRequests(sessionToken);
    if (result.accepted) setAccessRequests(result.requests);
  }, [api, isAdmin, sessionToken]);

  const refreshPermissionRequests = useCallback(async () => {
    if (!sessionToken || !isAdmin || typeof api.getPermissionRequests !== "function") return;
    const result = await api.getPermissionRequests(sessionToken);
    if (result.accepted) setPermissionRequests(result.requests);
  }, [api, isAdmin, sessionToken]);

  const refreshNotifications = useCallback(async () => {
    if (!sessionToken || !session || typeof api.getUserNotifications !== "function") return;
    const result = await api.getUserNotifications(sessionToken);
    if (!result.accepted) return;
    setUserNotifications(result.notifications);
    // A cancelled gatepass with a bill behind it must not sit quietly in the bell: it is
    // shouted as a toast (once) the moment it is seen, on top of the badge.
    for (const notice of result.notifications) {
      if (notice.readAt || shouted.current.has(notice.id)) continue;
      if (notice.severity !== "CRITICAL" && notice.severity !== "WARNING") continue;
      shouted.current.add(notice.id);
      push(notice.severity === "CRITICAL" ? "error" : "warning", notice.title, notice.message, notice.severity === "CRITICAL" ? 20000 : 10000);
    }
  }, [api, push, session, sessionToken]);

  // One poll for everything the shell shows; nothing runs while signed out.
  useEffect(() => {
    if (!sessionToken || !session) return;
    const refresh = () => {
      void refreshRoles();
      void refreshNotifications();
      void refreshMembers();
      void refreshAccessRequests();
      void refreshPermissionRequests();
    };
    refresh();
    const timer = window.setInterval(refresh, ADMIN_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [session, sessionToken, refreshRoles, refreshNotifications, refreshMembers, refreshAccessRequests, refreshPermissionRequests]);

  const patchMember = (userId: string, patch: Partial<Member>) =>
    setMembers((current) => current.map((member) => (member.id === userId ? { ...member, ...patch } : member)));

  const handleNotificationClick = (notification: UserNotification) => {
    if (!sessionToken || typeof api.markNotificationRead !== "function") return;
    void api.markNotificationRead(sessionToken, notification.id).then(() => {
      setUserNotifications((current) =>
        current.map((item) => (item.id === notification.id ? { ...item, readAt: new Date().toISOString() } : item))
      );
    });
  };

  const handleReviewAccessRequest = async (requestId: string, decision: ReviewDecision, permissions: string[] = [], roleCode?: string) => {
    if (!sessionToken) return;
    const result = await api.reviewAccessRequest(sessionToken, requestId, decision, permissions, roleCode);
    if (!result.accepted) {
      setAuthError(result.reason ?? "Unable to review access request");
      return;
    }
    await refreshAccessRequests();
  };

  const handleMemberPermissions = async (userId: string, permissions: string[]) => {
    if (!sessionToken || typeof api.updateUserPermissions !== "function") return;
    const result = await api.updateUserPermissions(sessionToken, userId, permissions);
    if (result.accepted) patchMember(userId, { permissions });
  };

  const handleMemberRoleAssignment = async (userId: string, roleCode: string) => {
    if (!sessionToken || typeof api.assignUserRole !== "function") return;
    const result = await api.assignUserRole(sessionToken, userId, roleCode);
    if (result.accepted) {
      const roleName = roleOptions.find((role) => role.code === roleCode)?.name;
      patchMember(userId, { roleCode, ...(roleName ? { jobRole: roleName } : {}) });
    }
  };

  const handleMemberJobRole = async (userId: string, jobRole: string) => {
    if (!sessionToken || typeof api.updateMemberJobRole !== "function") return;
    const result = await api.updateMemberJobRole(sessionToken, userId, jobRole);
    if (result.accepted) patchMember(userId, { jobRole });
  };

  const handleMemberAuthority = async (userId: string, authorityLevel: number) => {
    if (!sessionToken || typeof api.updateMemberAuthority !== "function") return;
    const result = await api.updateMemberAuthority(sessionToken, userId, authorityLevel);
    if (result.accepted) patchMember(userId, { authorityLevel });
  };

  const handleMemberRevoke = async (userId: string) => {
    if (!sessionToken || typeof api.revokeUserAccess !== "function") return;
    const result = await api.revokeUserAccess(sessionToken, userId);
    if (result.accepted) patchMember(userId, { accessStatus: ACCESS_STATUS.REJECTED });
  };

  const handleSetAdditionalPermissions = async (userId: string, permissions: string[]) => {
    if (!sessionToken || typeof api.setUserAdditionalPermissions !== "function") return;
    const result = await api.setUserAdditionalPermissions(sessionToken, userId, permissions);
    if (result.accepted) patchMember(userId, { additionalPermissions: permissions });
  };

  const handleCreateRole = async (input: RoleInput) => {
    if (!sessionToken || typeof api.createRole !== "function") return;
    const result = await api.createRole(sessionToken, input);
    if (!result.accepted) {
      push("error", "Unable to create role", result.reason ?? "");
      return;
    }
    push("success", "Role created", `${input.name} is now available.`);
    await refreshRoles();
  };

  const handleUpdateRole = async (code: string, input: RoleUpdate) => {
    if (!sessionToken || typeof api.updateRole !== "function") return;
    const result = await api.updateRole(sessionToken, code, input);
    if (!result.accepted) {
      push("error", "Unable to update role", result.reason ?? "");
      return;
    }
    push("success", "Role updated", "Changes applied to assigned members.");
    await refreshRoles();
    await refreshMembers();
  };

  const handleDeleteRole = async (code: string) => {
    if (!sessionToken || typeof api.deleteRole !== "function") return;
    const result = await api.deleteRole(sessionToken, code);
    if (!result.accepted) {
      push("error", "Unable to delete role", result.reason ?? "");
      return;
    }
    push("success", "Role deleted", "Role removed from catalog.");
    await refreshRoles();
  };

  const handleReviewPermissionRequest = async (requestId: string, decision: ReviewDecision, reviewNotes?: string) => {
    if (!sessionToken || typeof api.reviewPermissionRequest !== "function") return;
    const result = await api.reviewPermissionRequest(sessionToken, requestId, decision, reviewNotes);
    if (!result.accepted) {
      push("error", "Unable to review request", result.reason ?? "");
      return;
    }
    push("success", decision === ACCESS_STATUS.APPROVED ? "Request approved" : "Request rejected", "");
    await refreshPermissionRequests();
    await refreshMembers();
  };

  return {
    members,
    roles,
    roleOptions,
    accessRequests,
    permissionRequests,
    userNotifications,
    handleNotificationClick,
    handleReviewAccessRequest,
    handleMemberPermissions,
    handleMemberRoleAssignment,
    handleMemberJobRole,
    handleMemberAuthority,
    handleMemberRevoke,
    handleSetAdditionalPermissions,
    handleCreateRole,
    handleUpdateRole,
    handleDeleteRole,
    handleReviewPermissionRequest,
  };
};
