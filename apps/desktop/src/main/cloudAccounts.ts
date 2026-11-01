// Cloud accounts on this computer: the switch to them, and signing in under them (docs/41).
//
// THE SWITCH (section 7). A computer starts in local accounts. On a sync pass, once it is signed in
// as its enrolled device and its project answers account_state (cloud 021), it loads the whole
// account state through the same writes the log uses, ends the sessions of accounts only this
// computer knows, and switches, in one transaction. A project without the account functions is
// remembered until the next start, so it costs one request.
//
// SIGNING IN (section 4), under cloud accounts:
//   reachable      the cloud decides, every time. A "no" is final: the cache is never tried after it.
//                  A "yes" refreshes this computer's check of the password and its copy of the person.
//   unreachable    this computer's own check, only if it was made at the person's current credential
//                  version and confirmed online within OFFLINE_DAYS, for someone not revoked.
//   first time     nothing here can check the password, by design: it needs the internet.
//
// PERSON TOKENS prove to the cloud that a person, not just this computer, is asking (020). They live
// in memory, per session, and never on disk: a restart means signing in again for admin work.

import type { SqliteDatabase, StructuredLogger, PersonPayload } from "@erp/data";
import type { AccountFunctionCaller, AccountStateAnswer, SignInAnswer } from "@erp/sync";

/** How long a check confirmed online may sign someone in without the cloud (owner, 2026-10-23). */
export const OFFLINE_DAYS = 7;

/** What a person is told. One place, for translation later (R21). */
export const ACCOUNT_MESSAGES = {
  WRONG_CREDENTIALS: "Wrong email or password.",
  LOCKED: (minutes: number) => `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
  ACCESS_REVOKED: "Your access has been removed. Ask an administrator.",
  ACCESS_REJECTED: "Your request for access was declined. Ask an administrator.",
  NOT_ENROLLED: "This computer is not enrolled in the company's cloud. Ask the owner to enrol it.",
  EMAIL_TAKEN: "An account with this email already exists. Sign in instead.",
  EMAIL_INVALID: "Enter a valid email address.",
  PASSWORD_RULE: "Password must be at least 8 characters and include a letter and a number.",
  PASSWORD_TOO_LONG: "Password is too long: use at most 72 characters.",
  NAME_INVALID: "Enter your name, up to 80 characters.",
  ID_TAKEN: "This account has already been moved to the cloud. Sign in with its email.",
  FIRST_TIME_OFFLINE: "This computer needs an internet connection the first time you sign in here.",
  OFFLINE_TOO_LONG: `You have not signed in online on this computer for ${OFFLINE_DAYS} days. Connect to the internet to sign in.`,
  SIGN_UP_OFFLINE: "Creating an account needs an internet connection.",
  CLAIM_OFFLINE: "Moving your account to the cloud needs an internet connection.",
  DEVICE_REFUSED: "The cloud refused this computer's sign-in. Ask the owner to check its enrolment.",
  UNREADABLE: "The cloud's answer could not be read. Try again.",
  CATCHING_UP: "This computer is still catching up with the cloud. Try again in a moment.",
  NEEDS_EMAIL: "Add your email to move this account to the cloud. You will use it to sign in from now on.",
  OTHER: (code: string) => `The cloud refused this (${code}).`,
} as const;

export type AccountOutcome =
  | { readonly kind: "SIGNED_IN"; readonly userId: string; readonly sessionToken: string }
  | { readonly kind: "NEEDS_EMAIL"; readonly message: string }
  | { readonly kind: "REFUSED"; readonly message: string };

// ─── Person tokens (memory only) ────────────────────────────────────────────

const personTokens = new Map<string, { token: string; expiresAt: string }>();

/** The person token behind a session, while it is live. Null after a restart, expiry or offline sign-in. */
export function personTokenFor(sessionToken: string, now = Date.now()): string | null {
  const held = personTokens.get(sessionToken);
  if (held === undefined || new Date(held.expiresAt).getTime() <= now) return null;
  return held.token;
}

export function forgetPersonToken(sessionToken: string): void {
  personTokens.delete(sessionToken);
}

// ─── The switch ─────────────────────────────────────────────────────────────

const unsupportedProjects = new Set<string>();

export type AccountsSwitch = "ALREADY_CLOUD" | "SWITCHED" | "NOT_SUPPORTED" | "UNAVAILABLE" | "WAITING";

/** Switches this computer to cloud accounts when its project can. Never throws: a pass carries on. */
export async function switchToCloudAccountsIfReady(
  db: SqliteDatabase,
  caller: AccountFunctionCaller,
  project: string,
  logger: StructuredLogger,
  deviceId: string
): Promise<AccountsSwitch> {
  const data = await import("@erp/data");
  if (data.readAccountsMode(db.db) === data.ACCOUNTS_MODE.CLOUD) return "ALREADY_CLOUD";
  if (unsupportedProjects.has(project)) return "NOT_SUPPORTED";

  const sync = await import("@erp/sync");
  const state = await sync.fetchAccountState(caller);
  if (state.kind === "NOT_SUPPORTED") {
    unsupportedProjects.add(project);
    return "NOT_SUPPORTED";
  }
  if (state.kind !== "STATE") {
    logger.log({ module: "sync", severity: "WARNING", operation: "cloud-accounts", deviceId, message: `Cloud accounts are not switched on yet: ${describeFailure(state)}` });
    return "UNAVAILABLE";
  }
  const waiting = loadStateAndSwitch(db, data, state);
  if (waiting !== null) {
    logger.log({ module: "sync", severity: "WARNING", operation: "cloud-accounts", deviceId, message: `Cloud accounts are not switched on yet: ${waiting}. Nothing was changed.` });
    return "WAITING";
  }
  logger.log({
    module: "sync", severity: "INFO", operation: "cloud-accounts", deviceId,
    message: `This computer now uses cloud accounts: ${state.people.length} people, ${state.roles.length} roles.`,
  });
  return "SWITCHED";
}

type DataModule = typeof import("@erp/data");

/**
 * Everything, then the switch, in one transaction. A record that would have to wait is a reason to
 * change nothing and try on the next pass: a half-loaded account state is worse than none.
 */
function loadStateAndSwitch(db: SqliteDatabase, data: DataModule, state: Extract<AccountStateAnswer, { kind: "STATE" }>): string | null {
  db.db.exec("BEGIN IMMEDIATE TRANSACTION");
  try {
    const waiting =
      applyAll(state.roles, (role) => data.accountRoleWaitsFor(db.db, role), (role) => data.applyAccountRoleRevision(db.db, role)) ??
      applyAll(state.people, (person) => data.personWaitsFor(db.db, person), (person) => data.applyPersonRevision(db.db, person)) ??
      applyAll(state.requests, (request) => data.permissionRequestWaitsFor(db.db, request), (request) => data.applyPermissionRequestRevision(db.db, request));
    if (waiting !== null) {
      db.db.exec("ROLLBACK");
      return waiting;
    }
    data.endLocalOnlySessions(db.db);
    data.enterCloudAccountsMode(db.db, "cloud-accounts-switch");
    db.db.exec("COMMIT");
    return null;
  } catch (error) {
    db.db.exec("ROLLBACK");
    throw error;
  }
}

function applyAll<T>(records: readonly T[], waitsFor: (record: T) => string | null, apply: (record: T) => boolean): string | null {
  for (const record of records) {
    const waiting = waitsFor(record);
    if (waiting !== null) return waiting;
    apply(record);
  }
  return null;
}

// ─── Signing in, up, and moving an account up ───────────────────────────────

export interface AccountDeps {
  readonly db: SqliteDatabase;
  /** Null when this computer cannot reach its project at all (not configured): treated as offline. */
  readonly caller: AccountFunctionCaller | null;
}

export async function cloudSignIn(deps: AccountDeps, email: string, password: string, now = new Date()): Promise<AccountOutcome> {
  if (deps.caller === null) return offlineSignIn(deps.db, email, password, now);
  const sync = await import("@erp/sync");
  const answer = await sync.verifyLogin(deps.caller, email, password);
  if (answer.kind === "UNREACHABLE" || answer.kind === "NOT_SUPPORTED") return offlineSignIn(deps.db, email, password, now);
  return settleOnline(deps.db, answer, password, now);
}

export async function cloudSignUp(deps: AccountDeps, email: string, password: string, displayName: string, now = new Date()): Promise<AccountOutcome> {
  if (deps.caller === null) return { kind: "REFUSED", message: ACCOUNT_MESSAGES.SIGN_UP_OFFLINE };
  const sync = await import("@erp/sync");
  const answer = await sync.signUp(deps.caller, email, password, displayName);
  if (answer.kind === "UNREACHABLE" || answer.kind === "NOT_SUPPORTED") return { kind: "REFUSED", message: ACCOUNT_MESSAGES.SIGN_UP_OFFLINE };
  return settleOnline(deps.db, answer, password, now);
}

/**
 * An account this computer already holds, signed in by its old username (docs/41 section 6). Its
 * password is checked here first; with an email it moves up, keeping its id, and arrives PENDING.
 */
export async function cloudClaim(deps: AccountDeps, username: string, password: string, email: string | null, now = new Date()): Promise<AccountOutcome> {
  const local = deps.db.authenticateUser(username, password);
  if (local === null) return { kind: "REFUSED", message: ACCOUNT_MESSAGES.WRONG_CREDENTIALS };
  if (email === null || email.trim() === "") return { kind: "NEEDS_EMAIL", message: ACCOUNT_MESSAGES.NEEDS_EMAIL };
  if (deps.caller === null) return { kind: "REFUSED", message: ACCOUNT_MESSAGES.CLAIM_OFFLINE };
  const sync = await import("@erp/sync");
  const answer = await sync.claimExistingAccount(deps.caller, local.id, email.trim(), password, local.username);
  if (answer.kind === "UNREACHABLE" || answer.kind === "NOT_SUPPORTED") return { kind: "REFUSED", message: ACCOUNT_MESSAGES.CLAIM_OFFLINE };
  return settleOnline(deps.db, answer, password, now);
}

/** The cloud answered: a refusal is final; a person signed in is written here, cached, and given a session. */
async function settleOnline(db: SqliteDatabase, answer: SignInAnswer, password: string, now: Date): Promise<AccountOutcome> {
  if (answer.kind !== "SIGNED_IN") return { kind: "REFUSED", message: messageFor(answer) };
  const data = await import("@erp/data");
  const waiting = writePerson(db, data, answer.person);
  if (waiting !== null) return { kind: "REFUSED", message: ACCOUNT_MESSAGES.CATCHING_UP };
  db.writeLocalCredential(answer.person.personId, db.hashPassword(password), answer.person.credentialVersion, now.toISOString());
  const sessionToken = db.createUserSession(answer.person.personId);
  personTokens.set(sessionToken, { token: answer.token, expiresAt: answer.expiresAt });
  return { kind: "SIGNED_IN", userId: answer.person.personId, sessionToken };
}

/** The person as the cloud just described them, through the log's own write. Null, or why it must wait. */
function writePerson(db: SqliteDatabase, data: DataModule, person: PersonPayload): string | null {
  const waiting = data.personWaitsFor(db.db, person);
  if (waiting !== null) return waiting;
  db.db.exec("BEGIN IMMEDIATE TRANSACTION");
  try {
    data.applyPersonRevision(db.db, person);
    db.db.exec("COMMIT");
    return null;
  } catch (error) {
    db.db.exec("ROLLBACK");
    throw error;
  }
}

/** No cloud to ask. Only a check this computer made at the person's current version, recently. */
export function offlineSignIn(db: SqliteDatabase, email: string, password: string, now = new Date()): AccountOutcome {
  const row = db.db
    .prepare(
      `SELECT u.id, u.access_status, c.confirmed_online_at
       FROM app_users u JOIN user_credentials c ON c.user_id = u.id AND c.credential_version = u.credential_version
       WHERE u.email = ? COLLATE NOCASE`
    )
    .get(email.trim()) as { id: string; access_status: string; confirmed_online_at: string | null } | undefined;
  if (row === undefined || row.confirmed_online_at === null) return { kind: "REFUSED", message: ACCOUNT_MESSAGES.FIRST_TIME_OFFLINE };
  // The password first: a person's status is told only to someone who knows it, as in the cloud.
  if (!db.checkLocalCredential(row.id, password)) return { kind: "REFUSED", message: ACCOUNT_MESSAGES.WRONG_CREDENTIALS };
  if (row.access_status === "REVOKED") return { kind: "REFUSED", message: ACCOUNT_MESSAGES.ACCESS_REVOKED };
  if (row.access_status === "REJECTED") return { kind: "REFUSED", message: ACCOUNT_MESSAGES.ACCESS_REJECTED };
  const ageMs = now.getTime() - new Date(row.confirmed_online_at).getTime();
  if (!(ageMs >= 0 && ageMs <= OFFLINE_DAYS * 24 * 60 * 60 * 1000)) return { kind: "REFUSED", message: ACCOUNT_MESSAGES.OFFLINE_TOO_LONG };
  return { kind: "SIGNED_IN", userId: row.id, sessionToken: db.createUserSession(row.id) };
}

// ─── Messages ───────────────────────────────────────────────────────────────

function messageFor(answer: Exclude<SignInAnswer, { kind: "SIGNED_IN" }>): string {
  switch (answer.kind) {
    case "DECLINED":
      return declinedMessage(answer.reason, answer.retryAfterSeconds);
    case "REFUSED":
      return ACCOUNT_MESSAGES.DEVICE_REFUSED;
    case "UNREADABLE":
      return ACCOUNT_MESSAGES.UNREADABLE;
    default:
      return ACCOUNT_MESSAGES.FIRST_TIME_OFFLINE;
  }
}

function declinedMessage(reason: string, retryAfterSeconds?: number): string {
  if (reason === "LOCKED") return ACCOUNT_MESSAGES.LOCKED(Math.max(1, Math.ceil((retryAfterSeconds ?? 900) / 60)));
  if (reason === "PASSWORD_TOO_SHORT" || reason === "PASSWORD_NEEDS_LETTER_AND_NUMBER") return ACCOUNT_MESSAGES.PASSWORD_RULE;
  const known: Record<string, string> = {
    WRONG_CREDENTIALS: ACCOUNT_MESSAGES.WRONG_CREDENTIALS,
    ACCESS_REVOKED: ACCOUNT_MESSAGES.ACCESS_REVOKED,
    ACCESS_REJECTED: ACCOUNT_MESSAGES.ACCESS_REJECTED,
    NOT_ENROLLED: ACCOUNT_MESSAGES.NOT_ENROLLED,
    EMAIL_TAKEN: ACCOUNT_MESSAGES.EMAIL_TAKEN,
    EMAIL_INVALID: ACCOUNT_MESSAGES.EMAIL_INVALID,
    PASSWORD_TOO_LONG: ACCOUNT_MESSAGES.PASSWORD_TOO_LONG,
    NAME_INVALID: ACCOUNT_MESSAGES.NAME_INVALID,
    ID_TAKEN: ACCOUNT_MESSAGES.ID_TAKEN,
  };
  return known[reason] ?? ACCOUNT_MESSAGES.OTHER(reason);
}

function describeFailure(state: Exclude<AccountStateAnswer, { kind: "STATE" }>): string {
  if (state.kind === "DECLINED") return `the cloud said ${state.reason}`;
  if (state.kind === "REFUSED" || state.kind === "UNREACHABLE") return state.message;
  return state.kind === "UNREADABLE" ? "the cloud's account state could not be read" : "not supported";
}
