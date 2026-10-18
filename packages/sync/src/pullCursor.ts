// How far this computer has read the shared log.
//
// Kept in app_settings, the table the application already uses for per-installation settings, so
// no schema change is needed and the position survives a restart. It is a local fact about this
// installation — never sent anywhere, and never merged with another computer's.
//
// Zero means "nothing read yet", which is also what an absent or unreadable value means: reading
// from the beginning again is safe, because applying an event twice is a no-op.

import type { SyncSqlHandle } from "./sqlPort.js";
import { asRow } from "./sqlPort.js";

export const PULL_CURSOR_SETTING_KEY = "sync.pull.cursor";

export function readPullCursor(sql: SyncSqlHandle): number {
  const row = asRow(
    sql.prepare("SELECT setting_value FROM app_settings WHERE setting_key = ? LIMIT 1").get(PULL_CURSOR_SETTING_KEY)
  );
  if (row === null) return 0;
  const parsed = Number(String(row.setting_value ?? "").trim());
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

// ─── Waiting for a prerequisite, without spinning ───────────────────────────
//
// A carton naming a product this computer has not been given cannot be applied, and must not be
// stepped over: the owner seeds the product later and the event then applies itself. But until
// they do, every pass would fetch the same batch and fail on the same event.
//
// So the wait is recorded: which position is blocked, and when it is worth looking again. One
// settings row, overwritten each time — nothing accumulates however long the wait lasts, and no
// list of deferred events is kept in memory.

export const PULL_DEFER_SETTING_KEY = "sync.pull.deferred";

export interface PullDeferral {
  /** The log position that could not be applied. */
  readonly seq: number;
  /** Epoch milliseconds before which there is no point looking again. */
  readonly until: number;
  /** How many times this same position has been deferred. Widens the wait. */
  readonly attempts: number;
}

export function readPullDeferral(sql: SyncSqlHandle): PullDeferral | null {
  const row = asRow(
    sql.prepare("SELECT setting_value FROM app_settings WHERE setting_key = ? LIMIT 1").get(PULL_DEFER_SETTING_KEY)
  );
  if (row === null) return null;
  try {
    const parsed: unknown = JSON.parse(String(row.setting_value ?? ""));
    const record = asRow(parsed);
    if (record === null) return null;
    const seq = Number(record.seq);
    const until = Number(record.until);
    const attempts = Number(record.attempts);
    if (!Number.isFinite(seq) || !Number.isFinite(until) || !Number.isFinite(attempts)) return null;
    return { seq, until, attempts };
  } catch {
    // An unreadable note means "no wait recorded": looking again early is harmless.
    return null;
  }
}

export function writePullDeferral(sql: SyncSqlHandle, deferral: PullDeferral): void {
  writeSetting(sql, PULL_DEFER_SETTING_KEY, JSON.stringify(deferral));
}

export function clearPullDeferral(sql: SyncSqlHandle): void {
  sql.prepare("DELETE FROM app_settings WHERE setting_key = ?").run(PULL_DEFER_SETTING_KEY);
}

export function writePullCursor(sql: SyncSqlHandle, cursor: number): void {
  if (!Number.isInteger(cursor) || cursor < 0) return;
  writeSetting(sql, PULL_CURSOR_SETTING_KEY, String(cursor));
}

function writeSetting(sql: SyncSqlHandle, key: string, value: string): void {
  sql
    .prepare(
      `INSERT INTO app_settings (setting_key, setting_value, value_type, is_encrypted, updated_by, updated_at)
       VALUES (?, ?, 'string', 0, 'sync', ?)
       ON CONFLICT(setting_key) DO UPDATE SET
         setting_value = excluded.setting_value,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`
    )
    .run(key, value, new Date().toISOString());
}
