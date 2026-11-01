// CLOUD ACCOUNTS ARRIVING ON THIS PC (docs/41 sections 2, 5 and 8).
//
// The cloud is the only place an account changes (cloud migrations 020 and 021). What reaches a PC
// is a numbered REVISION of one person, one role, or one permission request, and these functions
// write it. Two callers use them, so they live here rather than in a sync contract:
//   * the log's contracts (@erp/sync accountContracts.ts), one revision at a time, in log order
//   * the one-off load of the whole account state when a PC switches to cloud accounts
//
// THE RULES EVERY WRITE KEEPS
//   * Only a revision newer than the one this PC holds is written (sync_record_revisions, the
//     table leased records already use). An older one is a duplicate: it has been superseded.
//   * Nothing secret arrives, so nothing secret is written. This PC's password checks
//     (user_credentials) are only ever DELETED here: a raised credential version, a revocation or
//     a rejection makes them useless, and a stale check must not let anyone in offline.
//   * Losing access ends the person's open sessions on this PC.
//   * The local refusals (accountsMode.ts) do not apply: these ARE the cloud's decisions.
//
// Every payload is read by a reader below before anything is written. Nothing is defaulted (R25).

import type { AccountSqlHandle } from "./accountsMode.js";
import { effectivePermissionsFor, normalizePermissionCode } from "./users.js";

export const ACCOUNT_STATUSES = ["PENDING", "APPROVED", "REJECTED", "REVOKED"] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const ROLE_LOGIN_POLICIES = ["ALWAYS_LOGGED_IN", "DAILY_LOGIN"] as const;
export type RoleLoginPolicy = (typeof ROLE_LOGIN_POLICIES)[number];

export const PERMISSION_REQUEST_STATUSES = ["PENDING", "APPROVED", "REJECTED"] as const;
export type PermissionRequestStatus = (typeof PERMISSION_REQUEST_STATUSES)[number];

/** The record types, as the log names them (cloud 020, 021) and sync_record_revisions keys them. */
export const ACCOUNT_RECORD = {
  PERSON: "PERSON",
  ACCOUNT_ROLE: "ACCOUNT_ROLE",
  PERMISSION_REQUEST: "PERMISSION_REQUEST",
} as const;

/** One person's non-secret account facts at a revision (cloud 020, person_snapshot). */
export interface PersonPayload {
  readonly personId: string;
  readonly revision: number;
  readonly email: string;
  readonly displayName: string;
  readonly status: AccountStatus;
  readonly isAdmin: boolean;
  readonly roleCode: string | null;
  readonly extraPermissions: readonly string[];
  readonly jobRole: string;
  readonly authorityLevel: number;
  readonly credentialVersion: number;
}

/** One role of the catalogue at a revision (cloud 020, account_role_snapshot). */
export interface AccountRolePayload {
  readonly roleCode: string;
  readonly revision: number;
  readonly deleted: boolean;
  readonly name: string;
  readonly description: string | null;
  readonly loginPolicy: RoleLoginPolicy;
  readonly permissions: readonly string[];
}

/** One request for one more screen, and its decision, at a revision (cloud 021). */
export interface PermissionRequestPayload {
  readonly requestId: string;
  readonly revision: number;
  readonly personId: string;
  readonly permissionCode: string;
  readonly reason: string | null;
  readonly status: PermissionRequestStatus;
  readonly requestedAt: string;
  readonly reviewedAt: string | null;
  readonly reviewedBy: string | null;
  readonly reviewNotes: string | null;
}

// ─── Readers ────────────────────────────────────────────────────────────────

const PERMISSION_CODE = /^[a-z0-9-]{1,64}$/;

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);
const optionalText = (value: unknown): { ok: true; value: string | null } | { ok: false } =>
  value === null || value === undefined ? { ok: true, value: null } : typeof value === "string" ? { ok: true, value } : { ok: false };
const positiveInteger = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
const oneOf = <T extends string>(values: readonly T[], value: unknown): T | null =>
  typeof value === "string" && (values as readonly string[]).includes(value) ? (value as T) : null;
const codeList = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((code) => typeof code === "string" && PERMISSION_CODE.test(code)) ? [...(value as string[])] : null;

/** A timestamp from the cloud (timestamptz), as this PC stores instants: UTC ISO. */
const instant = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};
const optionalInstant = (value: unknown): { ok: true; value: string | null } | { ok: false } => {
  if (value === null || value === undefined) return { ok: true, value: null };
  const read = instant(value);
  return read === null ? { ok: false } : { ok: true, value: read };
};

export function readPersonPayload(payload: Record<string, unknown>): PersonPayload | null {
  const personId = text(payload.personId);
  const email = text(payload.email);
  const displayName = text(payload.displayName);
  const revision = positiveInteger(payload.revision);
  const credentialVersion = positiveInteger(payload.credentialVersion);
  const authorityLevel = positiveInteger(payload.authorityLevel);
  const status = oneOf(ACCOUNT_STATUSES, payload.status);
  const roleCode = optionalText(payload.roleCode);
  const extraPermissions = codeList(payload.extraPermissions);
  if (personId === null || email === null || displayName === null || status === null) return null;
  if (revision === null || credentialVersion === null || authorityLevel === null || authorityLevel > 99) return null;
  if (typeof payload.isAdmin !== "boolean" || typeof payload.jobRole !== "string") return null;
  if (!roleCode.ok || extraPermissions === null) return null;
  return {
    personId, revision, email, displayName, status, credentialVersion, authorityLevel, extraPermissions,
    isAdmin: payload.isAdmin,
    roleCode: roleCode.value,
    jobRole: payload.jobRole.trim(),
  };
}

export function readAccountRolePayload(payload: Record<string, unknown>): AccountRolePayload | null {
  const roleCode = text(payload.roleCode);
  const name = text(payload.name);
  const revision = positiveInteger(payload.revision);
  const loginPolicy = oneOf(ROLE_LOGIN_POLICIES, payload.loginPolicy);
  const description = optionalText(payload.description);
  const permissions = codeList(payload.permissions);
  if (roleCode === null || name === null || revision === null || loginPolicy === null) return null;
  if (typeof payload.deleted !== "boolean" || !description.ok || permissions === null) return null;
  return { roleCode, name, revision, loginPolicy, permissions, deleted: payload.deleted, description: description.value };
}

export function readPermissionRequestPayload(payload: Record<string, unknown>): PermissionRequestPayload | null {
  const requestId = text(payload.requestId);
  const personId = text(payload.personId);
  const revision = positiveInteger(payload.revision);
  const status = oneOf(PERMISSION_REQUEST_STATUSES, payload.status);
  const requestedAt = instant(payload.requestedAt);
  const permissionCode = typeof payload.permissionCode === "string" && PERMISSION_CODE.test(payload.permissionCode) ? payload.permissionCode : null;
  const reason = optionalText(payload.reason);
  const reviewedAt = optionalInstant(payload.reviewedAt);
  const reviewedBy = optionalText(payload.reviewedBy);
  const reviewNotes = optionalText(payload.reviewNotes);
  if (requestId === null || personId === null || revision === null || status === null || requestedAt === null) return null;
  if (permissionCode === null || !reason.ok || !reviewedAt.ok || !reviewedBy.ok || !reviewNotes.ok) return null;
  // A decision says who made it and when; a pending request says neither.
  if ((status === "PENDING") !== (reviewedBy.value === null && reviewedAt.value === null)) return null;
  return {
    requestId, personId, revision, status, requestedAt, permissionCode,
    reason: reason.value,
    reviewedAt: reviewedAt.value,
    reviewedBy: reviewedBy.value,
    reviewNotes: reviewNotes.value,
  };
}

// ─── What a revision waits for ──────────────────────────────────────────────
//
// A wait, never a refusal: what it needs is earlier in the log, or on its way (applyContract.ts).

export function personWaitsFor(sql: AccountSqlHandle, person: PersonPayload): string | null {
  if (person.roleCode !== null && !exists(sql, "SELECT 1 FROM roles WHERE role_code = ?", person.roleCode)) {
    return `WAITING_FOR:${ACCOUNT_RECORD.ACCOUNT_ROLE}:${person.roleCode}`;
  }
  return null;
}

export function accountRoleWaitsFor(sql: AccountSqlHandle, role: AccountRolePayload): string | null {
  if (role.deleted && exists(sql, "SELECT 1 FROM user_role_assignments WHERE role_code = ?", role.roleCode)) {
    return `WAITING_FOR:ROLE_UNASSIGNED:${role.roleCode}`;
  }
  if (!role.deleted && exists(sql, "SELECT 1 FROM roles WHERE role_name = ? AND role_code <> ?", role.name, role.roleCode)) {
    return `WAITING_FOR:ROLE_NAME:${role.name}`;
  }
  return null;
}

export function permissionRequestWaitsFor(sql: AccountSqlHandle, request: PermissionRequestPayload): string | null {
  for (const personId of [request.personId, request.reviewedBy]) {
    if (personId !== null && !exists(sql, "SELECT 1 FROM app_users WHERE id = ?", personId)) {
      return `WAITING_FOR:${ACCOUNT_RECORD.PERSON}:${personId}`;
    }
  }
  return null;
}

// ─── Writes ─────────────────────────────────────────────────────────────────
//
// Each returns true when the revision was written, false when this PC already holds it or a newer
// one. Call inside a transaction: the applier's, or the cloud-mode switch's.

export function applyPersonRevision(sql: AccountSqlHandle, person: PersonPayload, now = new Date().toISOString()): boolean {
  if (heldRevision(sql, ACCOUNT_RECORD.PERSON, person.personId) >= person.revision) return false;
  const before = sql.prepare("SELECT job_role FROM app_users WHERE id = ?").get(person.personId) as { job_role: string } | undefined;

  upsertPerson(sql, person, now);
  writeAssignments(sql, person, now);
  // A check made at any other credential version is stale: a password changed, or was reset.
  sql.prepare("DELETE FROM user_credentials WHERE user_id = ? AND credential_version <> ?").run(person.personId, person.credentialVersion);
  if (person.status === "REVOKED" || person.status === "REJECTED") endAccess(sql, person.personId, now);
  if (before !== undefined && before.job_role !== person.jobRole) noticeJobRoleChange(sql, person, now);
  persistPermissions(sql, person.personId, now);

  recordRevision(sql, ACCOUNT_RECORD.PERSON, person.personId, person.revision);
  return true;
}

export function applyAccountRoleRevision(sql: AccountSqlHandle, role: AccountRolePayload, now = new Date().toISOString()): boolean {
  if (heldRevision(sql, ACCOUNT_RECORD.ACCOUNT_ROLE, role.roleCode) >= role.revision) return false;

  sql.prepare("DELETE FROM role_permissions WHERE role_code = ?").run(role.roleCode);
  if (role.deleted) {
    sql.prepare("DELETE FROM roles WHERE role_code = ?").run(role.roleCode);
  } else {
    upsertRole(sql, role, now);
    const insert = sql.prepare("INSERT OR IGNORE INTO role_permissions (role_code, permission_code, created_at) VALUES (?, ?, ?)");
    for (const permission of role.permissions) insert.run(role.roleCode, normalizePermissionCode(permission), now);
  }

  const holders = sql.prepare("SELECT user_id FROM user_role_assignments WHERE role_code = ?").all(role.roleCode) as Array<{ user_id: string }>;
  for (const holder of holders) persistPermissions(sql, holder.user_id, now);

  recordRevision(sql, ACCOUNT_RECORD.ACCOUNT_ROLE, role.roleCode, role.revision);
  return true;
}

export function applyPermissionRequestRevision(sql: AccountSqlHandle, request: PermissionRequestPayload, now = new Date().toISOString()): boolean {
  if (heldRevision(sql, ACCOUNT_RECORD.PERMISSION_REQUEST, request.requestId) >= request.revision) return false;
  const before = sql.prepare("SELECT status FROM permission_requests WHERE id = ?").get(request.requestId) as { status: string } | undefined;

  sql
    .prepare(
      `INSERT INTO permission_requests (id, user_id, permission_code, reason, status, requested_at, reviewed_at, reviewed_by, review_notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, reviewed_at = excluded.reviewed_at,
         reviewed_by = excluded.reviewed_by, review_notes = excluded.review_notes`
    )
    .run(request.requestId, request.personId, request.permissionCode, request.reason, request.status, request.requestedAt,
      request.reviewedAt, request.reviewedBy, request.reviewNotes);

  // The same notices the local flow gives (users.ts), made by each PC for its own people.
  if (before === undefined && request.status === "PENDING") noticeNewRequest(sql, request, now);
  if (before?.status === "PENDING" && request.status !== "PENDING") noticeDecision(sql, request, now);

  recordRevision(sql, ACCOUNT_RECORD.PERMISSION_REQUEST, request.requestId, request.revision);
  return true;
}

/**
 * At the switch to cloud accounts: ends every open session of an account the cloud does not know
 * -- one with no email, still only this PC's. The cloud cannot revoke what it has never seen, so a
 * session that outlived the switch would be access nobody can take away. Each such person signs in
 * once more with their old name and password, adds an email, and moves up (docs/41 section 6).
 * Returns how many sessions ended.
 */
export function endLocalOnlySessions(sql: AccountSqlHandle, now = new Date().toISOString()): number {
  const ended = sql
    .prepare(
      `UPDATE user_sessions SET revoked_at = ?
       WHERE revoked_at IS NULL AND user_id IN (SELECT id FROM app_users WHERE email IS NULL)`
    )
    .run(now) as { changes?: number | bigint };
  return Number(ended.changes ?? 0);
}

// ─── The parts ──────────────────────────────────────────────────────────────

function exists(sql: AccountSqlHandle, select: string, ...params: string[]): boolean {
  return sql.prepare(select).get(...params) !== undefined;
}

function heldRevision(sql: AccountSqlHandle, type: string, recordId: string): number {
  const row = sql.prepare("SELECT revision FROM sync_record_revisions WHERE aggregate_type = ? AND record_id = ?").get(type, recordId) as
    | { revision: number }
    | undefined;
  return row?.revision ?? 0;
}

function recordRevision(sql: AccountSqlHandle, type: string, recordId: string, revision: number): void {
  sql
    .prepare(
      `INSERT INTO sync_record_revisions (aggregate_type, record_id, revision) VALUES (?, ?, ?)
       ON CONFLICT(aggregate_type, record_id) DO UPDATE SET revision = excluded.revision`
    )
    .run(type, recordId, revision);
}

/** The person's row. A person from the cloud is named by display name and signs in by email. */
function upsertPerson(sql: AccountSqlHandle, person: PersonPayload, now: string): void {
  sql
    .prepare(
      `INSERT INTO app_users (id, username, email, role, authority_level, job_role, access_status, credential_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET username = excluded.username, email = excluded.email, role = excluded.role,
         authority_level = excluded.authority_level, job_role = excluded.job_role, access_status = excluded.access_status,
         credential_version = excluded.credential_version, updated_at = excluded.updated_at`
    )
    .run(person.personId, person.displayName, person.email, person.isAdmin ? "ADMIN" : "USER", person.authorityLevel,
      person.jobRole, person.status, person.credentialVersion, now, now);
}

/** The role and the extra screens, replaced whole: the revision is the whole truth about them. */
function writeAssignments(sql: AccountSqlHandle, person: PersonPayload, now: string): void {
  if (person.roleCode === null) {
    sql.prepare("DELETE FROM user_role_assignments WHERE user_id = ?").run(person.personId);
  } else {
    sql
      .prepare(
        `INSERT INTO user_role_assignments (user_id, role_code, assigned_by, assigned_at, updated_at) VALUES (?, ?, NULL, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET role_code = excluded.role_code, assigned_by = NULL, updated_at = excluded.updated_at`
      )
      .run(person.personId, person.roleCode, now, now);
  }
  sql.prepare("DELETE FROM user_additional_permissions WHERE user_id = ?").run(person.personId);
  const insert = sql.prepare("INSERT OR IGNORE INTO user_additional_permissions (user_id, permission_code, granted_by, granted_at) VALUES (?, ?, NULL, ?)");
  for (const permission of person.extraPermissions) insert.run(person.personId, normalizePermissionCode(permission), now);
}

function upsertRole(sql: AccountSqlHandle, role: AccountRolePayload, now: string): void {
  sql
    .prepare(
      `INSERT INTO roles (role_code, role_name, description, login_policy, is_system_role, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(role_code) DO UPDATE SET role_name = excluded.role_name, description = excluded.description,
         login_policy = excluded.login_policy, updated_at = excluded.updated_at`
    )
    .run(role.roleCode, role.name, role.description, role.loginPolicy, now, now);
}

/** Revoked or rejected: open sessions end, and no check of their password stays on this PC. */
function endAccess(sql: AccountSqlHandle, personId: string, now: string): void {
  sql.prepare("UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(now, personId);
  sql.prepare("DELETE FROM user_credentials WHERE user_id = ?").run(personId);
}

function persistPermissions(sql: AccountSqlHandle, userId: string, now: string): void {
  const permissions = effectivePermissionsFor(sql, userId);
  sql.prepare("UPDATE app_users SET permissions_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(permissions), now, userId);
}

function notify(sql: AccountSqlHandle, userId: string, title: string, message: string, now: string): void {
  sql
    .prepare("INSERT INTO user_notifications (id, user_id, title, message, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(crypto.randomUUID(), userId, title, message, now);
}

/** As users.ts updateMemberJobRole tells the person, on their next sign-in and in their notices. */
function noticeJobRoleChange(sql: AccountSqlHandle, person: PersonPayload, now: string): void {
  const message = person.jobRole ? `You are now ${person.jobRole}` : "Your member role has been cleared";
  sql.prepare("UPDATE app_users SET role_notification = ? WHERE id = ?").run(message, person.personId);
  if (person.jobRole) sql.prepare("INSERT OR IGNORE INTO job_role_options (name, created_at) VALUES (?, ?)").run(person.jobRole, now);
  notify(sql, person.personId, "Role updated", message, now);
}

function noticeNewRequest(sql: AccountSqlHandle, request: PermissionRequestPayload, now: string): void {
  const asker = sql.prepare("SELECT username FROM app_users WHERE id = ?").get(request.personId) as { username: string } | undefined;
  const admins = sql.prepare("SELECT id FROM app_users WHERE role = 'ADMIN' AND access_status = 'APPROVED'").all() as Array<{ id: string }>;
  for (const admin of admins) {
    notify(sql, admin.id, "Permission request", `${asker?.username ?? request.personId} requested permission "${request.permissionCode}"`, now);
  }
}

function noticeDecision(sql: AccountSqlHandle, request: PermissionRequestPayload, now: string): void {
  const approved = request.status === "APPROVED";
  notify(
    sql,
    request.personId,
    approved ? "Permission granted" : "Permission request declined",
    approved ? `Your request for "${request.permissionCode}" was approved.` : `Your request for "${request.permissionCode}" was declined.`,
    now
  );
}
