// The cloud account functions, as this PC calls them (cloud migrations 020 and 021, docs/41).
//
// The names live here and nowhere else (R4). The transport makes the call as this enrolled device
// (SupabaseSyncTransport.callAccountFunction); this file says what each answer means, and reads it
// before anything relies on it (R25): an answer that is not shaped as promised is UNREADABLE, never
// half-used.
//
// WHY THE KIND OF FAILURE IS KEPT. The sign-in rules turn on it (docs/41 section 4). A refusal from
// the cloud is final. Only a cloud that could not be asked lets a PC try its own cached check.

import {
  readAccountRolePayload,
  readPermissionRequestPayload,
  readPersonPayload,
  type AccessSuggestion,
  type AccountRolePayload,
  type PermissionRequestPayload,
  type PersonPayload,
} from "@erp/data";
import { asRow } from "./sqlPort.js";

export const ACCOUNT_FUNCTION = {
  SIGN_UP: "sign_up",
  CLAIM_EXISTING_ACCOUNT: "claim_existing_account",
  VERIFY_LOGIN: "verify_login",
  CHANGE_PASSWORD: "change_password",
  ACCOUNT_STATE: "account_state",
  REQUEST_PERMISSION: "request_permission",
  ADMIN_SET_ACCESS: "admin_set_access",
  ADMIN_RESET_PASSWORD: "admin_reset_password",
  ADMIN_SAVE_ROLE: "admin_save_role",
  ADMIN_DELETE_ROLE: "admin_delete_role",
  ADMIN_IMPORT_ROLES: "admin_import_roles",
  ADMIN_REVIEW_PERMISSION_REQUEST: "admin_review_permission_request",
} as const;

export type AccountFunctionName = (typeof ACCOUNT_FUNCTION)[keyof typeof ACCOUNT_FUNCTION];

/** What one call came to (see SupabaseSyncTransport.callAccountFunction for each kind). */
export type AccountCall =
  | { readonly kind: "ANSWERED"; readonly answer: Record<string, unknown> }
  | { readonly kind: "NOT_SUPPORTED" }
  | { readonly kind: "REFUSED"; readonly message: string }
  | { readonly kind: "UNREACHABLE"; readonly message: string }
  | { readonly kind: "UNREADABLE" };

/** The one thing this file needs from a transport. */
export interface AccountFunctionCaller {
  callAccountFunction(name: AccountFunctionName, args: Record<string, unknown>): Promise<AccountCall>;
}

/** A call that did not produce a usable answer, as the callers above need to tell them apart. */
export type AccountCallFailure =
  | { readonly kind: "NOT_SUPPORTED" }
  | { readonly kind: "REFUSED"; readonly message: string }
  | { readonly kind: "UNREACHABLE"; readonly message: string }
  | { readonly kind: "UNREADABLE" };

/** The function ran and said no, with its code: WRONG_CREDENTIALS, LOCKED, EMAIL_TAKEN, ... */
export interface AccountDeclined {
  readonly kind: "DECLINED";
  readonly reason: string;
  /** LOCKED only: how long until the person may try again. */
  readonly retryAfterSeconds?: number;
}

/** A person signed in (or signed up, or moved up) online, with the token that proves it here. */
export interface PersonSignedIn {
  readonly kind: "SIGNED_IN";
  readonly person: PersonPayload;
  readonly token: string;
  readonly expiresAt: string;
}

export type SignInAnswer = PersonSignedIn | AccountDeclined | AccountCallFailure;

export interface AccountState {
  readonly kind: "STATE";
  readonly roles: readonly AccountRolePayload[];
  readonly people: readonly PersonPayload[];
  readonly requests: readonly PermissionRequestPayload[];
}

export type AccountStateAnswer = AccountState | AccountDeclined | AccountCallFailure;

// ─── Calls ──────────────────────────────────────────────────────────────────

export async function verifyLogin(caller: AccountFunctionCaller, email: string, password: string): Promise<SignInAnswer> {
  const call = await caller.callAccountFunction(ACCOUNT_FUNCTION.VERIFY_LOGIN, { p_email: email, p_password: password });
  return readSignIn(call);
}

export async function signUp(caller: AccountFunctionCaller, email: string, password: string, displayName: string): Promise<SignInAnswer> {
  const call = await caller.callAccountFunction(ACCOUNT_FUNCTION.SIGN_UP, { p_email: email, p_password: password, p_display_name: displayName });
  return readSignIn(call);
}

/**
 * Moves an account this PC already holds up to the cloud, keeping its id (docs/41 section 6), with
 * the access it had here as the admin's starting point (cloud 023). A suggestion, never access.
 */
export async function claimExistingAccount(
  caller: AccountFunctionCaller,
  localId: string,
  email: string,
  password: string,
  displayName: string,
  suggested: AccessSuggestion | null = null
): Promise<SignInAnswer> {
  const call = await caller.callAccountFunction(ACCOUNT_FUNCTION.CLAIM_EXISTING_ACCOUNT, {
    p_local_id: localId, p_email: email, p_password: password, p_display_name: displayName, p_suggested: suggested,
  });
  return readSignIn(call);
}

/** Everything about accounts, once, for a PC switching to cloud accounts (cloud 021). */
export async function fetchAccountState(caller: AccountFunctionCaller): Promise<AccountStateAnswer> {
  const call = await caller.callAccountFunction(ACCOUNT_FUNCTION.ACCOUNT_STATE, {});
  if (call.kind !== "ANSWERED") return call;
  const declined = readDeclined(call.answer);
  if (declined !== null) return declined;
  if (call.answer.ok !== true) return { kind: "UNREADABLE" };
  const roles = readAll(call.answer.roles, readAccountRolePayload);
  const people = readAll(call.answer.people, readPersonPayload);
  const requests = readAll(call.answer.requests, readPermissionRequestPayload);
  if (roles === null || people === null || requests === null) return { kind: "UNREADABLE" };
  return { kind: "STATE", roles, people, requests };
}

// ─── Admin work, and a person's own changes (each needs a person token) ─────
//
// Every answer carries the snapshot the cloud just wrote, so the caller can write it here at once
// rather than wait for the log to bring the same revision (which then arrives as a duplicate).

export type PersonAnswer = { readonly kind: "PERSON"; readonly person: PersonPayload } | AccountDeclined | AccountCallFailure;
export type RoleAnswer = { readonly kind: "ROLE"; readonly role: AccountRolePayload } | AccountDeclined | AccountCallFailure;
export type RequestAnswer = { readonly kind: "REQUEST"; readonly request: PermissionRequestPayload } | AccountDeclined | AccountCallFailure;
export type ImportAnswer = { readonly kind: "IMPORTED"; readonly count: number } | AccountDeclined | AccountCallFailure;

/** Everything an admin decides about one person, sent whole: the cloud judges the whole (cloud 020). */
export interface AccessDecision {
  readonly status: "PENDING" | "APPROVED" | "REJECTED" | "REVOKED";
  readonly isAdmin: boolean;
  readonly roleCode: string | null;
  readonly extraPermissions: readonly string[];
  readonly jobRole: string;
  readonly authorityLevel: number;
}

export interface RoleDefinition {
  readonly code: string | null;
  readonly name: string;
  readonly description: string | null;
  readonly loginPolicy: "ALWAYS_LOGGED_IN" | "DAILY_LOGIN";
  readonly permissions: readonly string[];
}

export async function adminSetAccess(caller: AccountFunctionCaller, token: string, personId: string, decision: AccessDecision): Promise<PersonAnswer> {
  const call = await caller.callAccountFunction(ACCOUNT_FUNCTION.ADMIN_SET_ACCESS, {
    p_token: token, p_person_id: personId, p_status: decision.status, p_is_admin: decision.isAdmin, p_role_code: decision.roleCode,
    p_extra_permissions: decision.extraPermissions, p_job_role: decision.jobRole, p_authority_level: decision.authorityLevel,
  });
  return readOne(call, "person", readPersonPayload, (person) => ({ kind: "PERSON", person }));
}

export async function adminResetPassword(caller: AccountFunctionCaller, token: string, personId: string, newPassword: string): Promise<PersonAnswer> {
  const call = await caller.callAccountFunction(ACCOUNT_FUNCTION.ADMIN_RESET_PASSWORD, { p_token: token, p_person_id: personId, p_new_password: newPassword });
  return readOne(call, "person", readPersonPayload, (person) => ({ kind: "PERSON", person }));
}

export async function changeOwnPassword(caller: AccountFunctionCaller, token: string, current: string, next: string): Promise<PersonAnswer> {
  const call = await caller.callAccountFunction(ACCOUNT_FUNCTION.CHANGE_PASSWORD, { p_token: token, p_current: current, p_new: next });
  return readOne(call, "person", readPersonPayload, (person) => ({ kind: "PERSON", person }));
}

export async function adminSaveRole(caller: AccountFunctionCaller, token: string, role: RoleDefinition): Promise<RoleAnswer> {
  const call = await caller.callAccountFunction(ACCOUNT_FUNCTION.ADMIN_SAVE_ROLE, {
    p_token: token, p_role_code: role.code, p_name: role.name, p_description: role.description,
    p_login_policy: role.loginPolicy, p_permissions: role.permissions,
  });
  return readOne(call, "role", readAccountRolePayload, (saved) => ({ kind: "ROLE", role: saved }));
}

export async function adminDeleteRole(caller: AccountFunctionCaller, token: string, roleCode: string): Promise<RoleAnswer> {
  const call = await caller.callAccountFunction(ACCOUNT_FUNCTION.ADMIN_DELETE_ROLE, { p_token: token, p_role_code: roleCode });
  return readOne(call, "role", readAccountRolePayload, (removed) => ({ kind: "ROLE", role: removed }));
}

/** Copies a computer's roles up, once, while the cloud has none (cloud 020). */
export async function adminImportRoles(caller: AccountFunctionCaller, token: string, roles: readonly RoleDefinition[]): Promise<ImportAnswer> {
  const call = await caller.callAccountFunction(ACCOUNT_FUNCTION.ADMIN_IMPORT_ROLES, {
    p_token: token,
    p_roles: roles.map((role) => ({ code: role.code, name: role.name, description: role.description, loginPolicy: role.loginPolicy, permissions: role.permissions })),
  });
  if (call.kind !== "ANSWERED") return call;
  const declined = readDeclined(call.answer);
  if (declined !== null) return declined;
  const count = call.answer.imported;
  return call.answer.ok === true && typeof count === "number" && Number.isInteger(count) && count >= 0 ? { kind: "IMPORTED", count } : { kind: "UNREADABLE" };
}

export async function requestPermission(caller: AccountFunctionCaller, token: string, permissionCode: string, reason: string | null): Promise<RequestAnswer> {
  const call = await caller.callAccountFunction(ACCOUNT_FUNCTION.REQUEST_PERMISSION, { p_token: token, p_permission_code: permissionCode, p_reason: reason });
  return readOne(call, "request", readPermissionRequestPayload, (request) => ({ kind: "REQUEST", request }));
}

export async function adminReviewPermissionRequest(
  caller: AccountFunctionCaller,
  token: string,
  requestId: string,
  decision: "APPROVED" | "REJECTED",
  notes: string | null
): Promise<RequestAnswer> {
  const call = await caller.callAccountFunction(ACCOUNT_FUNCTION.ADMIN_REVIEW_PERMISSION_REQUEST, {
    p_token: token, p_request_id: requestId, p_decision: decision, p_notes: notes,
  });
  return readOne(call, "request", readPermissionRequestPayload, (request) => ({ kind: "REQUEST", request }));
}

// ─── Reading answers ────────────────────────────────────────────────────────

/** {ok: true, <key>: snapshot}, read whole; a refusal as DECLINED; anything else UNREADABLE. */
function readOne<P, A>(
  call: AccountCall,
  key: string,
  read: (row: Record<string, unknown>) => P | null,
  wrap: (payload: P) => A
): A | AccountDeclined | AccountCallFailure {
  if (call.kind !== "ANSWERED") return call;
  const declined = readDeclined(call.answer);
  if (declined !== null) return declined;
  const row = asRow(call.answer[key]);
  const payload = row === null ? null : read(row);
  return call.answer.ok === true && payload !== null ? wrap(payload) : { kind: "UNREADABLE" };
}

function readSignIn(call: AccountCall): SignInAnswer {
  if (call.kind !== "ANSWERED") return call;
  const declined = readDeclined(call.answer);
  if (declined !== null) return declined;
  const personRow = asRow(call.answer.person);
  const person = personRow === null ? null : readPersonPayload(personRow);
  const { token, expiresAt } = call.answer;
  if (call.answer.ok !== true || person === null || typeof token !== "string" || token.length < 32) return { kind: "UNREADABLE" };
  if (typeof expiresAt !== "string" || Number.isNaN(new Date(expiresAt).getTime())) return { kind: "UNREADABLE" };
  return { kind: "SIGNED_IN", person, token, expiresAt: new Date(expiresAt).toISOString() };
}

/** {ok: false, reason} is the function saying no. Null when the answer is not a refusal. */
function readDeclined(answer: Record<string, unknown>): AccountDeclined | null {
  if (answer.ok !== false) return null;
  if (typeof answer.reason !== "string" || !/^[A-Z_]{1,64}$/.test(answer.reason)) return null;
  const retry = answer.retryAfterSeconds;
  return typeof retry === "number" && Number.isInteger(retry) && retry > 0
    ? { kind: "DECLINED", reason: answer.reason, retryAfterSeconds: retry }
    : { kind: "DECLINED", reason: answer.reason };
}

/** Every element read, or null if any one is not what it should be: a state is used whole or not at all. */
function readAll<T>(value: unknown, read: (row: Record<string, unknown>) => T | null): T[] | null {
  if (!Array.isArray(value)) return null;
  const out: T[] = [];
  for (const element of value) {
    const row = asRow(element);
    const item = row === null ? null : read(row);
    if (item === null) return null;
    out.push(item);
  }
  return out;
}
