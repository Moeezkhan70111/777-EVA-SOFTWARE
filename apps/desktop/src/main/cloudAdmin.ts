// Admin work under cloud accounts, and a person's own changes (docs/41 sections 3 and 8).
//
// Under cloud accounts nothing about access is decided on this computer: the local writes refuse
// (accountsMode.ts). Each action here is a cloud function, called as this enrolled device with the
// signed-in person's token, so the cloud can tell an admin from a computer. The snapshot the cloud
// answers with is written here at once, through the log's own writes, so the screen shows the change
// without waiting for sync -- and when the log brings the same revision, it is a duplicate.
//
// An admin's change to one field is sent as the person's WHOLE access decision, built from this
// computer's copy of them: the cloud judges the whole (020's admin_set_access), never a fragment.

import type { AccessSuggestion, AccountRolePayload, MemberAccessChange, PermissionRequestPayload, SqliteDatabase } from "@erp/data";
import type { AccessDecision, AccountCallFailure, AccountDeclined, AccountFunctionCaller, RoleDefinition } from "@erp/sync";

export interface CloudAdminDeps {
  readonly db: SqliteDatabase;
  /** Null when this computer cannot reach its cloud at all. */
  readonly caller: AccountFunctionCaller | null;
  /** The signed-in person's token, or null after a restart or an offline sign-in. */
  readonly personToken: string | null;
}

export type AdminResult = { readonly accepted: true } | { readonly accepted: false; readonly reason: string };

/** What an admin is told. One place, for translation later (R21). */
export const CLOUD_ADMIN_MESSAGES = {
  SIGN_IN_AGAIN: "Sign out and sign in again while online to make account changes: this session cannot speak for you to the cloud.",
  OFFLINE: "Account changes need an internet connection.",
  DEVICE_REFUSED: "The cloud refused this computer. Ask the owner to check its enrolment.",
  UNREADABLE: "The cloud's answer could not be read. Try again.",
  NOT_HERE: "That person is not on this computer yet. Try again in a moment.",
  ADMIN_REQUIRED: "Your administrator session has expired, or you are no longer an administrator. Sign in again.",
  CANNOT_CHANGE_OWN_ACCESS: "You cannot remove your own access or administrator rights.",
  LAST_ADMIN: "The last administrator cannot be removed.",
  ROLE_NOT_FOUND: "That role is not in the cloud. Copy this computer's roles to the cloud first.",
  ROLE_IN_USE: "Someone still has this role. Give them another role first.",
  ROLE_NAME_TAKEN: "Another role already has that name.",
  REQUEST_NOT_PENDING: "This request has already been decided.",
  ACCESS_NOT_APPROVED: "This person is not approved, so they cannot be given more access.",
  ROLES_ALREADY_PRESENT: "The cloud already has roles: copying this computer's is only for the first time.",
  WRONG_PASSWORD: "Your current password is wrong.",
  PASSWORD_RULE: "Password must be at least 8 characters and include a letter and a number.",
  PASSWORD_TOO_LONG: "Password is too long: use at most 72 characters.",
  OTHER: (code: string) => `The cloud refused this (${code}).`,
} as const;

const DECLINED_MESSAGES: Readonly<Record<string, string>> = {
  ADMIN_REQUIRED: CLOUD_ADMIN_MESSAGES.ADMIN_REQUIRED,
  SESSION_EXPIRED: CLOUD_ADMIN_MESSAGES.SIGN_IN_AGAIN,
  CANNOT_CHANGE_OWN_ACCESS: CLOUD_ADMIN_MESSAGES.CANNOT_CHANGE_OWN_ACCESS,
  LAST_ADMIN: CLOUD_ADMIN_MESSAGES.LAST_ADMIN,
  ROLE_NOT_FOUND: CLOUD_ADMIN_MESSAGES.ROLE_NOT_FOUND,
  ROLE_IN_USE: CLOUD_ADMIN_MESSAGES.ROLE_IN_USE,
  ROLE_NAME_TAKEN: CLOUD_ADMIN_MESSAGES.ROLE_NAME_TAKEN,
  REQUEST_NOT_PENDING: CLOUD_ADMIN_MESSAGES.REQUEST_NOT_PENDING,
  ACCESS_NOT_APPROVED: CLOUD_ADMIN_MESSAGES.ACCESS_NOT_APPROVED,
  ROLES_ALREADY_PRESENT: CLOUD_ADMIN_MESSAGES.ROLES_ALREADY_PRESENT,
  WRONG_PASSWORD: CLOUD_ADMIN_MESSAGES.WRONG_PASSWORD,
  PASSWORD_TOO_SHORT: CLOUD_ADMIN_MESSAGES.PASSWORD_RULE,
  PASSWORD_NEEDS_LETTER_AND_NUMBER: CLOUD_ADMIN_MESSAGES.PASSWORD_RULE,
  PASSWORD_TOO_LONG: CLOUD_ADMIN_MESSAGES.PASSWORD_TOO_LONG,
};

type Ready = { readonly caller: AccountFunctionCaller; readonly token: string };

/** The caller and token, or why this cannot be asked of the cloud now. */
function ready(deps: CloudAdminDeps): Ready | AdminResult {
  if (deps.personToken === null) return { accepted: false, reason: CLOUD_ADMIN_MESSAGES.SIGN_IN_AGAIN };
  if (deps.caller === null) return { accepted: false, reason: CLOUD_ADMIN_MESSAGES.OFFLINE };
  return { caller: deps.caller, token: deps.personToken };
}

function refused(answer: AccountDeclined | AccountCallFailure): AdminResult {
  if (answer.kind === "DECLINED") return { accepted: false, reason: DECLINED_MESSAGES[answer.reason] ?? CLOUD_ADMIN_MESSAGES.OTHER(answer.reason) };
  if (answer.kind === "REFUSED") return { accepted: false, reason: CLOUD_ADMIN_MESSAGES.DEVICE_REFUSED };
  if (answer.kind === "UNREADABLE") return { accepted: false, reason: CLOUD_ADMIN_MESSAGES.UNREADABLE };
  return { accepted: false, reason: CLOUD_ADMIN_MESSAGES.OFFLINE };
}

/** Writes what the cloud just answered, in one transaction. Skipped when it must wait: the log brings it. */
function writeHere(db: SqliteDatabase, waitsFor: () => string | null, apply: () => boolean): void {
  if (waitsFor() !== null) return;
  db.db.exec("BEGIN IMMEDIATE TRANSACTION");
  try {
    apply();
    db.db.exec("COMMIT");
  } catch (error) {
    db.db.exec("ROLLBACK");
    throw error;
  }
}

// ─── People ─────────────────────────────────────────────────────────────────

/**
 * Under cloud accounts a person waiting for approval IS their own access request: signing up was
 * the request. Listed in the shape the admin screen already reads, with the person's id as the
 * request's, so its Approve and Decline work unchanged.
 */
export function signUpsAwaitingApproval(db: SqliteDatabase): Array<{ id: string; username: string; status: "PENDING"; requestedAt: string; reviewedAt: null }> {
  const rows = db.db
    .prepare("SELECT id, username, created_at FROM app_users WHERE access_status = 'PENDING' AND email IS NOT NULL ORDER BY created_at DESC")
    .all() as Array<{ id: string; username: string; created_at: string }>;
  return rows.map((row) => ({ id: row.id, username: row.username, status: "PENDING", requestedAt: row.created_at, reviewedAt: null }));
}

/** Members as the admin screen reads them, a pending person carrying their own id as their request's. */
export function withSignUpsAsRequests<M extends { id: string; accessStatus: string; accessRequestId: string | null }>(members: readonly M[]): M[] {
  return members.map((member) => (member.accessStatus === "PENDING" ? { ...member, accessRequestId: member.id } : member));
}

/** A person's whole access decision as this computer has it, or null when they are not here. */
export function currentAccess(db: SqliteDatabase, personId: string): AccessDecision | null {
  const row = db.db
    .prepare(
      `SELECT u.access_status, u.role, u.job_role, u.authority_level, a.role_code
       FROM app_users u LEFT JOIN user_role_assignments a ON a.user_id = u.id WHERE u.id = ?`
    )
    .get(personId) as { access_status: AccessDecision["status"]; role: string; job_role: string; authority_level: number; role_code: string | null } | undefined;
  if (row === undefined) return null;
  const extras = db.db.prepare("SELECT permission_code FROM user_additional_permissions WHERE user_id = ? ORDER BY permission_code").all(personId) as Array<{ permission_code: string }>;
  return {
    status: row.access_status,
    isAdmin: row.role === "ADMIN",
    roleCode: row.role_code,
    extraPermissions: extras.map((extra) => extra.permission_code),
    jobRole: row.job_role,
    authorityLevel: Math.max(1, Math.min(99, row.authority_level)),
  };
}

/** Screen codes in their one spelling, without repeats: the cloud accepts only canonical codes. */
async function canonicalCodes(codes: readonly string[]): Promise<string[]> {
  const data = await import("@erp/data");
  return Array.from(new Set(codes.map((code) => data.normalizePermissionCode(code)).filter((code) => code !== "")));
}

/**
 * What a local account has here, as the suggestion its move up carries (cloud 023): the admin's
 * starting point when approving it. An account that predates roles has only its old permission list,
 * which becomes its extra screens. Null when the account is not here.
 */
export async function suggestionFrom(db: SqliteDatabase, userId: string): Promise<AccessSuggestion | null> {
  const access = currentAccess(db, userId);
  if (access === null) return null;
  let extras = access.extraPermissions;
  if (access.roleCode === null && extras.length === 0) {
    const row = db.db.prepare("SELECT permissions_json FROM app_users WHERE id = ?").get(userId) as { permissions_json: string } | undefined;
    try {
      const legacy = JSON.parse(row?.permissions_json ?? "[]") as unknown;
      extras = Array.isArray(legacy) ? legacy.filter((code): code is string => typeof code === "string") : [];
    } catch {
      extras = [];
    }
  }
  return { roleCode: access.roleCode, extraPermissions: await canonicalCodes(extras), jobRole: access.jobRole, authorityLevel: access.authorityLevel };
}

/** One change to one person, sent as their whole decision. */
export async function setAccess(deps: CloudAdminDeps, personId: string, change: Partial<AccessDecision>): Promise<AdminResult> {
  const can = ready(deps);
  if ("accepted" in can) return can;
  const current = currentAccess(deps.db, personId);
  if (current === null) return { accepted: false, reason: CLOUD_ADMIN_MESSAGES.NOT_HERE };
  const decision = { ...current, ...change };
  const extraPermissions = await canonicalCodes(decision.extraPermissions);
  const sync = await import("@erp/sync");
  const answer = await sync.adminSetAccess(can.caller, can.token, personId, { ...decision, extraPermissions });
  if (answer.kind !== "PERSON") return refused(answer);
  const data = await import("@erp/data");
  writeHere(deps.db, () => data.personWaitsFor(deps.db.db, answer.person), () => data.applyPersonRevision(deps.db.db, answer.person));
  return { accepted: true };
}

/**
 * The extra screens, without the ones the role already gives. Under cloud accounts a role is its own
 * record: a later change to the role then reaches this person, instead of their copy of its old
 * screens outliving it.
 */
export function extrasBeyondRole(db: SqliteDatabase, roleCode: string | null, permissions: readonly string[]): string[] {
  const roleScreens = new Set(roleCode === null ? [] : (db.listRoles().find((role) => role.code === roleCode)?.permissions ?? []));
  return permissions.filter((code) => !roleScreens.has(code));
}

/**
 * The member details' Save: role, job role, authority and extra screens as ONE cloud change, so one
 * revision in the log and one round trip, and a refusal (a role not in the cloud yet) refuses the
 * whole of it rather than leaving the rest saved. It was four calls (rehearsal, 2 Nov: four presses
 * made twelve revisions in two seconds, the role refused each time with nothing said).
 */
export async function saveMemberAccess(deps: CloudAdminDeps, personId: string, change: MemberAccessChange): Promise<AdminResult> {
  const current = currentAccess(deps.db, personId);
  if (current === null) return { accepted: false, reason: CLOUD_ADMIN_MESSAGES.NOT_HERE };
  const roleCode = change.roleCode ?? current.roleCode;
  return setAccess(deps, personId, {
    roleCode,
    jobRole: change.jobRole ?? current.jobRole,
    authorityLevel: change.authorityLevel,
    extraPermissions: extrasBeyondRole(deps.db, roleCode, change.extraPermissions),
  });
}

export async function resetPassword(deps: CloudAdminDeps, personId: string, newPassword: string): Promise<AdminResult> {
  const can = ready(deps);
  if ("accepted" in can) return can;
  const sync = await import("@erp/sync");
  const answer = await sync.adminResetPassword(can.caller, can.token, personId, newPassword);
  if (answer.kind !== "PERSON") return refused(answer);
  const data = await import("@erp/data");
  writeHere(deps.db, () => data.personWaitsFor(deps.db.db, answer.person), () => data.applyPersonRevision(deps.db.db, answer.person));
  return { accepted: true };
}

/** The signed-in person's own password. This computer's check is remade at once, so offline still works here. */
export async function changeOwnPassword(deps: CloudAdminDeps, current: string, next: string, now = new Date()): Promise<AdminResult> {
  const can = ready(deps);
  if ("accepted" in can) return can;
  const sync = await import("@erp/sync");
  const answer = await sync.changeOwnPassword(can.caller, can.token, current, next);
  if (answer.kind !== "PERSON") return refused(answer);
  const data = await import("@erp/data");
  writeHere(deps.db, () => data.personWaitsFor(deps.db.db, answer.person), () => data.applyPersonRevision(deps.db.db, answer.person));
  deps.db.writeLocalCredential(answer.person.personId, deps.db.hashPassword(next), answer.person.credentialVersion, now.toISOString());
  return { accepted: true };
}

// ─── Roles ──────────────────────────────────────────────────────────────────

export async function saveRole(deps: CloudAdminDeps, role: RoleDefinition): Promise<AdminResult> {
  const can = ready(deps);
  if ("accepted" in can) return can;
  const sync = await import("@erp/sync");
  const answer = await sync.adminSaveRole(can.caller, can.token, { ...role, permissions: await canonicalCodes(role.permissions) });
  return answer.kind === "ROLE" ? writeRole(deps.db, answer.role) : refused(answer);
}

export async function deleteRole(deps: CloudAdminDeps, roleCode: string): Promise<AdminResult> {
  const can = ready(deps);
  if ("accepted" in can) return can;
  const sync = await import("@erp/sync");
  const answer = await sync.adminDeleteRole(can.caller, can.token, roleCode);
  return answer.kind === "ROLE" ? writeRole(deps.db, answer.role) : refused(answer);
}

async function writeRole(db: SqliteDatabase, role: AccountRolePayload): Promise<AdminResult> {
  const data = await import("@erp/data");
  writeHere(db, () => data.accountRoleWaitsFor(db.db, role), () => data.applyAccountRoleRevision(db.db, role));
  return { accepted: true };
}

/**
 * This computer's roles the cloud has never seen, offered only while the cloud has no roles at all
 * (no role here carries a cloud revision): the one-time copy up after the switch (docs/41 section 6).
 */
export function rolesToCopyUp(db: SqliteDatabase): RoleDefinition[] {
  const cloudHasRoles = db.db.prepare("SELECT 1 FROM sync_record_revisions WHERE aggregate_type = 'ACCOUNT_ROLE' LIMIT 1").get() !== undefined;
  return cloudHasRoles ? [] : localRoleDefinitions(db);
}

/**
 * The switch's own copy of this computer's roles, in the same press (owner, 2 Nov: as a separate
 * step after the switch it was easy to miss, approving before it lost the role, and PC2 gets one
 * go). Only while the cloud has no roles: the first computer to switch brings its roles, every
 * later one finds them there and copies nothing.
 */
export async function copyRolesBeforeSwitch(
  db: SqliteDatabase,
  caller: AccountFunctionCaller,
  adminToken: string,
  cloudRoleCount: number
): Promise<{ kind: "COPIED"; count: number } | { kind: "REFUSED"; reason: string }> {
  const roles = cloudRoleCount > 0 ? [] : localRoleDefinitions(db);
  if (roles.length === 0) return { kind: "COPIED", count: 0 };
  const sync = await import("@erp/sync");
  const answer = await sync.adminImportRoles(caller, adminToken, roles);
  if (answer.kind === "IMPORTED") return { kind: "COPIED", count: answer.count };
  const why = refused(answer);
  return { kind: "REFUSED", reason: why.accepted ? "" : why.reason };
}

/** Every role this computer has, as the cloud takes it. */
function localRoleDefinitions(db: SqliteDatabase): RoleDefinition[] {
  const rows = db.db.prepare("SELECT role_code, role_name, description, login_policy FROM roles ORDER BY role_name").all() as Array<{
    role_code: string;
    role_name: string;
    description: string | null;
    login_policy: string;
  }>;
  return rows
    .filter((row) => /^[a-z0-9-]{1,64}$/.test(row.role_code))
    .map((row) => ({
      code: row.role_code,
      name: row.role_name,
      description: row.description,
      loginPolicy: row.login_policy === "DAILY_LOGIN" ? "DAILY_LOGIN" : "ALWAYS_LOGGED_IN",
      permissions: (db.db.prepare("SELECT permission_code FROM role_permissions WHERE role_code = ? ORDER BY permission_code").all(row.role_code) as Array<{
        permission_code: string;
      }>).map((permission) => permission.permission_code),
    }));
}

/** Copies them up, then writes the cloud's catalogue here, so the roles carry their cloud revisions at once. */
export async function copyRolesUp(deps: CloudAdminDeps): Promise<AdminResult> {
  const can = ready(deps);
  if ("accepted" in can) return can;
  const roles = rolesToCopyUp(deps.db);
  if (roles.length === 0) return { accepted: false, reason: CLOUD_ADMIN_MESSAGES.ROLES_ALREADY_PRESENT };
  const sync = await import("@erp/sync");
  const answer = await sync.adminImportRoles(can.caller, can.token, roles);
  if (answer.kind !== "IMPORTED") return refused(answer);
  const state = await sync.fetchAccountState(can.caller);
  if (state.kind === "STATE") {
    for (const role of state.roles) await writeRole(deps.db, role);
  }
  return { accepted: true };
}

// ─── Permission requests ────────────────────────────────────────────────────

export async function askForPermission(deps: CloudAdminDeps, permissionCode: string, reason: string | null): Promise<AdminResult> {
  const can = ready(deps);
  if ("accepted" in can) return can;
  const [code] = await canonicalCodes([permissionCode]);
  if (code === undefined) return { accepted: false, reason: CLOUD_ADMIN_MESSAGES.OTHER("PERMISSION_INVALID") };
  const sync = await import("@erp/sync");
  const answer = await sync.requestPermission(can.caller, can.token, code, reason);
  return answer.kind === "REQUEST" ? writeRequest(deps.db, answer.request) : refused(answer);
}

export async function reviewPermission(
  deps: CloudAdminDeps,
  requestId: string,
  decision: "APPROVED" | "REJECTED",
  notes: string | null
): Promise<AdminResult> {
  const can = ready(deps);
  if ("accepted" in can) return can;
  const sync = await import("@erp/sync");
  const answer = await sync.adminReviewPermissionRequest(can.caller, can.token, requestId, decision, notes);
  return answer.kind === "REQUEST" ? writeRequest(deps.db, answer.request) : refused(answer);
}

async function writeRequest(db: SqliteDatabase, request: PermissionRequestPayload): Promise<AdminResult> {
  const data = await import("@erp/data");
  writeHere(db, () => data.permissionRequestWaitsFor(db.db, request), () => data.applyPermissionRequestRevision(db.db, request));
  return { accepted: true };
}
