// CLEARING WHAT A DATABASE REMEMBERS ABOUT THE TEST PROJECT (docs/36 section 10.5).
//
// PC2's database descends from PC1, which synced with the TEST project. Before it talks to
// production, every per-computer sync fact that belongs to test has to go -- and nothing else:
//
//   * queue rows already SENT (status SYNCED). They went to test. Left in place, their dedupe keys
//     stop the same facts ever being queued for production.             -> deleted
//   * the legacy queue: PRODUCTION_EVENT and DISPATCH_EVENT rows from before migration 082. No
//     contract carries those types, so they can never be sent (docs/37 2.1).
//                                                   -> retired: marked SYNCED with a note, kept
//   * positions and facts about test's log: the pull cursor, a recorded wait, the project the
//     cursor belongs to, "this project has no leases", the last backfill.  -> settings removed
//   * the lease cache, which describes test's leases.                    -> emptied, refetched
//
// KEPT, because it is this computer's own work and production needs it: queue rows written since
// with no lease epoch (a label run printed before sync was set up). The backfill re-queues those in
// order (backfill.ts markLabels). sync_runs is kept too: it is a history of passes, not state.
//
// REFUSED, rather than guessed at: anything stamped with a lease epoch (test's epochs, which
// production would refuse NOT_LEASE_HOLDER), queue rows in flight, failed or dead-lettered, events
// parked from test's log, and names displaced by a test revision. None exists on a computer that
// never synced; if one does, a person looks before anything changes.
//
// No business table is touched. verifyTestStateClear proves it by counting every one.

/** The one database handle this needs. node:sqlite's DatabaseSync satisfies it. */
export interface ClearHandle {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): { changes: number | bigint };
  };
}

type Row = Record<string, unknown>;

/** The schema 0.4.0 ships. Anything else has to be reviewed before this runs on it. */
export const TEST_STATE_CLEAR_SCHEMA = "099_sync_runs_backlog_trigger";

/** Queue types that predate migration 082 and that no contract carries. */
export const LEGACY_OUTBOX_TYPES: readonly string[] = ["PRODUCTION_EVENT", "DISPATCH_EVENT"];

/** Settings that describe another project's log or leases. */
export const TEST_PROJECT_SETTINGS: readonly string[] = [
  "sync.pull.cursor",
  "sync.pull.deferred",
  "sync.pull.project",
  "sync.leases.unsupported",
  "sync.backfill.last",
];

export const RETIRED_NOTE = "RETIRED: legacy pre-082 queue type, never sendable (docs/37 2.1, docs/36 10.5)";

/** Tables this changes. Every other table must hold exactly the rows it held before. */
const CHANGED_TABLES = new Set(["sync_outbox", "sync_domain_leases", "app_settings"]);

export class TestStateClearRefused extends Error {
  constructor(readonly reasons: readonly string[]) {
    super(`REFUSED, nothing changed:\n  - ${reasons.join("\n  - ")}`);
    this.name = "TestStateClearRefused";
  }
}

export interface TestStateClearPlan {
  readonly deviceId: string;
  readonly sentToTest: number;
  readonly legacyToRetire: number;
  readonly legacyAlreadyRetired: number;
  readonly keptUnstamped: number;
  readonly settings: readonly string[];
  readonly leaseCacheRows: number;
}

const placeholders = (values: readonly string[]): string => values.map(() => "?").join(", ");
const count = (db: ClearHandle, sql: string, ...params: unknown[]): number => Number((db.prepare(sql).get(...params) as Row).n);

/** Every user table and its row count, for the before/after comparison. */
export function tableCounts(db: ClearHandle): Map<string, number> {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Row[])
    .map((row) => String(row.name));
  return new Map(tables.map((table) => [table, count(db, `SELECT COUNT(*) AS n FROM "${table}"`)]));
}

function refusals(db: ClearHandle, expectedDeviceId: string): string[] {
  const reasons: string[] = [];
  const version = String((db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as Row).v ?? "");
  if (version !== TEST_STATE_CLEAR_SCHEMA) {
    reasons.push(`The database is at ${version || "no migration"}, not ${TEST_STATE_CLEAR_SCHEMA} (0.4.0). Start 0.4.0 on it once first.`);
  }
  const device = (db.prepare("SELECT setting_value AS v FROM app_settings WHERE setting_key = 'device.id'").get() as Row | undefined)?.v;
  if (device !== expectedDeviceId) {
    reasons.push(`This database's device.id is ${String(device ?? "missing")}, not ${expectedDeviceId}: it is not the computer named.`);
  }
  const legacy = placeholders(LEGACY_OUTBOX_TYPES);
  const stamped = count(db, `SELECT COUNT(*) AS n FROM sync_outbox WHERE lease_epoch IS NOT NULL AND status <> 'SYNCED'`);
  if (stamped > 0) reasons.push(`${stamped} queue row(s) carry a lease epoch: written under another project's lease.`);
  const odd = db
    .prepare(`SELECT status, aggregate_type, COUNT(*) AS n FROM sync_outbox
               WHERE status IN ('IN_FLIGHT', 'FAILED', 'DEAD_LETTER') AND aggregate_type NOT IN (${legacy})
               GROUP BY status, aggregate_type`)
    .all(...LEGACY_OUTBOX_TYPES) as Row[];
  for (const row of odd) reasons.push(`${String(row.n)} ${String(row.aggregate_type)} queue row(s) are ${String(row.status)}.`);
  const marks = count(db, "SELECT COUNT(*) AS n FROM sync_dirty_records WHERE lease_epoch IS NOT NULL");
  if (marks > 0) reasons.push(`${marks} change mark(s) carry a lease epoch from another project.`);
  const parked = count(db, "SELECT COUNT(*) AS n FROM sync_inbox_parked");
  if (parked > 0) reasons.push(`${parked} event(s) are parked from another project's log.`);
  const displaced = count(db, "SELECT COUNT(*) AS n FROM sync_displaced_records");
  if (displaced > 0) reasons.push(`${displaced} record name(s) were displaced by another project's revisions.`);
  return reasons;
}

/** What would change, or a refusal naming everything that stops it. Reads only. */
export function planTestStateClear(db: ClearHandle, expectedDeviceId: string): TestStateClearPlan {
  const reasons = refusals(db, expectedDeviceId);
  if (reasons.length > 0) throw new TestStateClearRefused(reasons);
  const legacy = placeholders(LEGACY_OUTBOX_TYPES);
  return {
    deviceId: expectedDeviceId,
    sentToTest: count(db, `SELECT COUNT(*) AS n FROM sync_outbox WHERE status = 'SYNCED' AND aggregate_type NOT IN (${legacy})`, ...LEGACY_OUTBOX_TYPES),
    legacyToRetire: count(db, `SELECT COUNT(*) AS n FROM sync_outbox WHERE status <> 'SYNCED' AND aggregate_type IN (${legacy})`, ...LEGACY_OUTBOX_TYPES),
    legacyAlreadyRetired: count(db, `SELECT COUNT(*) AS n FROM sync_outbox WHERE status = 'SYNCED' AND aggregate_type IN (${legacy})`, ...LEGACY_OUTBOX_TYPES),
    keptUnstamped: count(db, `SELECT COUNT(*) AS n FROM sync_outbox WHERE status = 'PENDING' AND lease_epoch IS NULL AND aggregate_type NOT IN (${legacy})`, ...LEGACY_OUTBOX_TYPES),
    settings: (db.prepare(`SELECT setting_key AS k FROM app_settings WHERE setting_key IN (${placeholders(TEST_PROJECT_SETTINGS)}) ORDER BY setting_key`)
      .all(...TEST_PROJECT_SETTINGS) as Row[]).map((row) => String(row.k)),
    leaseCacheRows: count(db, "SELECT COUNT(*) AS n FROM sync_domain_leases"),
  };
}

/** Makes the plan's changes in one transaction. Refuses, changing nothing, if the plan no longer holds. */
export function applyTestStateClear(db: ClearHandle, plan: TestStateClearPlan, nowIso: string): void {
  const legacy = placeholders(LEGACY_OUTBOX_TYPES);
  db.exec("BEGIN IMMEDIATE");
  try {
    const reasons = refusals(db, plan.deviceId);
    if (reasons.length > 0) throw new TestStateClearRefused(reasons);
    db.prepare(`DELETE FROM sync_outbox WHERE status = 'SYNCED' AND aggregate_type NOT IN (${legacy})`).run(...LEGACY_OUTBOX_TYPES);
    db.prepare(
      `UPDATE sync_outbox SET status = 'SYNCED', lock_token = NULL, last_error = ?, updated_at = ?
        WHERE status <> 'SYNCED' AND aggregate_type IN (${legacy})`
    ).run(RETIRED_NOTE, nowIso, ...LEGACY_OUTBOX_TYPES);
    db.prepare(`DELETE FROM app_settings WHERE setting_key IN (${placeholders(TEST_PROJECT_SETTINGS)})`).run(...TEST_PROJECT_SETTINGS);
    db.prepare("DELETE FROM sync_domain_leases").run();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export interface ClearCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

/** Proves the result: test's state gone, the computer's own work kept, and no business row moved. */
export function verifyTestStateClear(before: ClearHandle, after: ClearHandle, plan: TestStateClearPlan): ClearCheck[] {
  const legacy = placeholders(LEGACY_OUTBOX_TYPES);
  const sent = count(after, `SELECT COUNT(*) AS n FROM sync_outbox WHERE status = 'SYNCED' AND aggregate_type NOT IN (${legacy})`, ...LEGACY_OUTBOX_TYPES);
  const retired = count(after, `SELECT COUNT(*) AS n FROM sync_outbox WHERE aggregate_type IN (${legacy}) AND status = 'SYNCED'`, ...LEGACY_OUTBOX_TYPES);
  const legacyTotal = count(after, `SELECT COUNT(*) AS n FROM sync_outbox WHERE aggregate_type IN (${legacy})`, ...LEGACY_OUTBOX_TYPES);
  const kept = count(after, `SELECT COUNT(*) AS n FROM sync_outbox WHERE status = 'PENDING' AND lease_epoch IS NULL AND aggregate_type NOT IN (${legacy})`, ...LEGACY_OUTBOX_TYPES);
  const settings = count(after, `SELECT COUNT(*) AS n FROM app_settings WHERE setting_key IN (${placeholders(TEST_PROJECT_SETTINGS)})`, ...TEST_PROJECT_SETTINGS);
  const leases = count(after, "SELECT COUNT(*) AS n FROM sync_domain_leases");
  const quick = String((after.prepare("PRAGMA quick_check").get() as Row).quick_check);

  const beforeCounts = tableCounts(before);
  const afterCounts = tableCounts(after);
  const moved = [...beforeCounts].filter(([table, n]) => !CHANGED_TABLES.has(table) && afterCounts.get(table) !== n).map(([table]) => table);
  const settingsBefore = count(before, "SELECT COUNT(*) AS n FROM app_settings");
  const settingsAfter = count(after, "SELECT COUNT(*) AS n FROM app_settings");

  return [
    { name: "Nothing sent to test is left in the queue", ok: sent === 0, detail: `${sent} sent row(s) remain (plan: ${plan.sentToTest} deleted)` },
    { name: "Every legacy row is retired, none deleted", ok: retired === legacyTotal && legacyTotal === plan.legacyToRetire + plan.legacyAlreadyRetired, detail: `${retired} of ${legacyTotal} retired` },
    { name: "This computer's own unsent work is kept", ok: kept === plan.keptUnstamped, detail: `${kept} unstamped row(s), plan ${plan.keptUnstamped}` },
    { name: "No setting about the test project is left", ok: settings === 0, detail: `${settings} left; removed ${plan.settings.join(", ") || "none"}` },
    { name: "Only those settings were removed", ok: settingsBefore - settingsAfter === plan.settings.length, detail: `${settingsBefore} -> ${settingsAfter}` },
    { name: "The lease cache is empty", ok: leases === 0, detail: `${leases} row(s)` },
    { name: "No other table changed", ok: moved.length === 0, detail: moved.length === 0 ? `${beforeCounts.size - CHANGED_TABLES.size} tables identical` : `changed: ${moved.join(", ")}` },
    { name: "SQLite quick_check", ok: quick === "ok", detail: quick },
  ];
}
