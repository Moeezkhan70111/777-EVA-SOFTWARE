// LOCAL OR CLOUD ACCOUNTS: which one this PC runs, and the refusal that makes it mean something.
//
// A PC starts in LOCAL mode: its accounts are its own, as they have always been. It switches to
// CLOUD mode once, when it is enrolled and its project answers the account functions (docs/41
// section 7), and nothing switches it back.
//
// In CLOUD mode every local account change is refused HERE, in the data layer, not only on the
// screens (owner, 2026-11-01). A local admin on any PC must not be able to grant what the cloud did
// not: no first admin of its own, no local approval, role, permission or password change. Those are
// cloud functions, and their results arrive as revisions (accounts.ts), which write the tables
// directly and are never refused.

import type { CaptureHandle } from "./masterCapture.js";

/** The SQL surface the account code needs. node:sqlite's DatabaseSync and sync's handle both fit. */
export type AccountSqlHandle = Pick<CaptureHandle, "exec" | "prepare">;

export const ACCOUNTS_MODE_SETTING_KEY = "accounts.mode";

export const ACCOUNTS_MODE = {
  LOCAL: "LOCAL",
  CLOUD: "CLOUD",
} as const;

export type AccountsMode = (typeof ACCOUNTS_MODE)[keyof typeof ACCOUNTS_MODE];

/**
 * Settings the generic "save settings" path drops, whatever the caller sends (numberRange.ts
 * setOperatorSettings). Nobody can put a PC back into local mode from a settings screen.
 */
export const PROTECTED_ACCOUNT_SETTING_KEYS: readonly string[] = [ACCOUNTS_MODE_SETTING_KEY];

export class LocalAccountsClosedError extends Error {
  constructor() {
    super("Accounts on this computer are managed in the cloud. Make this change from the admin screen while online.");
    this.name = "LocalAccountsClosedError";
  }
}

/** This PC's account mode. Anything but CLOUD -- no setting, or an unknown value -- is LOCAL. */
export function readAccountsMode(sql: AccountSqlHandle): AccountsMode {
  const row = sql.prepare("SELECT setting_value FROM app_settings WHERE setting_key = ?").get(ACCOUNTS_MODE_SETTING_KEY) as
    | { setting_value?: string }
    | undefined;
  return row?.setting_value === ACCOUNTS_MODE.CLOUD ? ACCOUNTS_MODE.CLOUD : ACCOUNTS_MODE.LOCAL;
}

/**
 * Why an account revision is parked on a PC still on local accounts. Local mode is today's
 * behaviour, unchanged (docs/41 section 7): the PC's own roles, people and assignments are not the
 * cloud's to rewrite until an admin here presses the switch. The event is held rather than dropped,
 * so one logged after the switch read the cloud's state, but pulled before it committed, still lands.
 */
export const HELD_FOR_SWITCH = "WAITING_FOR:CLOUD_ACCOUNTS:switch";

/** What an account revision waits for before anything else: this PC's switch. Null once it switched. */
export function waitForSwitch(sql: AccountSqlHandle): string | null {
  return readAccountsMode(sql) === ACCOUNTS_MODE.CLOUD ? null : HELD_FOR_SWITCH;
}

/** Called by the switch: the next pull tries every held event, and each settles as applied or superseded. */
export function releaseEventsHeldForSwitch(sql: AccountSqlHandle): void {
  sql.prepare("UPDATE sync_inbox_parked SET next_try_at = 0 WHERE reason = ?").run(HELD_FOR_SWITCH);
}

/** Refuses a local account change on a PC whose accounts come from the cloud. */
export function requireLocalAccounts(sql: AccountSqlHandle): void {
  if (readAccountsMode(sql) === ACCOUNTS_MODE.CLOUD) throw new LocalAccountsClosedError();
}

/** Switches this PC to cloud accounts. One way: there is no function that switches back. */
export function enterCloudAccountsMode(sql: AccountSqlHandle, updatedBy: string): void {
  sql
    .prepare(
      `INSERT INTO app_settings (setting_key, setting_value, value_type, is_encrypted, updated_by, updated_at)
       VALUES (?, ?, 'string', 0, ?, ?)
       ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`
    )
    .run(ACCOUNTS_MODE_SETTING_KEY, ACCOUNTS_MODE.CLOUD, updatedBy, new Date().toISOString());
}
