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

/** Moves an account this PC already holds up to the cloud, keeping its id (docs/41 section 6). */
export async function claimExistingAccount(
  caller: AccountFunctionCaller,
  localId: string,
  email: string,
  password: string,
  displayName: string
): Promise<SignInAnswer> {
  const call = await caller.callAccountFunction(ACCOUNT_FUNCTION.CLAIM_EXISTING_ACCOUNT, {
    p_local_id: localId, p_email: email, p_password: password, p_display_name: displayName,
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

// ─── Reading answers ────────────────────────────────────────────────────────

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
