import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SyncPull } from "./pull.js";
import { PULL_CURSOR_SETTING_KEY, PULL_PROJECT_SETTING_KEY, pullProjectKey, readPullCursor, readPullDeferral, writePullDeferral } from "./pullCursor.js";
import type { SyncSqlHandle } from "./sqlPort.js";
import type { SyncPullTransport } from "./transport.js";

// A POSITION BELONGS TO ONE PROJECT. A computer moved from test to production must not carry test's
// position into production's log, which starts again at 1 -- it would silently skip production's
// first events (docs/36 section 7.6 D). Only the settings table is involved, so these run on an
// in-memory database with a transport that records where it was asked to read from.

const TEST = "https://wpkrhgqsizjjdaztijwv.supabase.co";
const PROD = "https://ykhvbmhmeefdtrzqeoxm.supabase.co";

const MIGRATION_091 = path.resolve(import.meta.dirname, "../../../migrations/sqlite/091_sync_inbox_parked.up.sql");

/** Settings plus the parked-event table (migration 091) -- all a pull touches without applying. */
function settingsOnly(): { sql: SyncSqlHandle; raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  raw.exec(`CREATE TABLE app_settings (
    setting_key TEXT PRIMARY KEY, setting_value TEXT, value_type TEXT, is_encrypted INTEGER,
    updated_by TEXT, updated_at TEXT)`);
  for (const statement of fs.readFileSync(MIGRATION_091, "utf8").split(";")) {
    if (statement.trim()) raw.exec(statement);
  }
  return { sql: raw as unknown as SyncSqlHandle, raw };
}

/** An empty log that remembers each position it was asked to read after. */
function recordingTransport(): SyncPullTransport & { readonly asked: number[] } {
  const asked: number[] = [];
  return {
    asked,
    fetchChanges: async (after: number) => {
      asked.push(after);
      return [];
    },
  } as SyncPullTransport & { readonly asked: number[] };
}

const setCursor = (raw: DatabaseSync, cursor: number) =>
  raw
    .prepare("INSERT OR REPLACE INTO app_settings (setting_key, setting_value) VALUES (?, ?)")
    .run(PULL_CURSOR_SETTING_KEY, String(cursor));

test("a computer that has never recorded its project starts again from the beginning, once", async () => {
  const { sql, raw } = settingsOnly();
  setCursor(raw, 2); // exactly what the host holds today: test's position, no project beside it
  const transport = recordingTransport();
  const pull = new SyncPull(sql, transport, { project: TEST });

  const first = await pull.runOnce();
  assert.equal(first.restartedForProject, true);
  assert.equal(transport.asked[0], 0, "read from the beginning, not from 2");

  const second = await pull.runOnce();
  assert.equal(second.restartedForProject, undefined, "and only once: the project is now recorded");
});

test("moving to another project forgets the old position and any recorded wait", async () => {
  const { sql, raw } = settingsOnly();
  await new SyncPull(sql, recordingTransport(), { project: TEST }).runOnce();
  setCursor(raw, 1500);
  writePullDeferral(sql, { seq: 1501, until: Date.now() + 60_000, attempts: 3 });

  const transport = recordingTransport();
  const moved = await new SyncPull(sql, transport, { project: PROD }).runOnce();

  assert.equal(moved.restartedForProject, true);
  assert.deepEqual(transport.asked, [0], "production is read from its own beginning, at once");
  assert.equal(readPullCursor(sql), 0);
  assert.equal(readPullDeferral(sql), null, "a wait recorded against test's log means nothing here");
});

test("the same project keeps its position, however the URL is spelled", async () => {
  const { sql, raw } = settingsOnly();
  await new SyncPull(sql, recordingTransport(), { project: TEST }).runOnce();
  setCursor(raw, 42);

  const transport = recordingTransport();
  const again = await new SyncPull(sql, transport, { project: `${TEST.toUpperCase()}/` }).runOnce();

  assert.equal(again.restartedForProject, undefined);
  assert.deepEqual(transport.asked, [42]);
  assert.equal(
    (raw.prepare("SELECT setting_value FROM app_settings WHERE setting_key = ?").get(PULL_PROJECT_SETTING_KEY) as { setting_value: string })
      .setting_value,
    pullProjectKey(TEST)
  );
});

test("a puller told no project leaves the cursor exactly as it was", async () => {
  const { sql, raw } = settingsOnly();
  setCursor(raw, 7);
  const transport = recordingTransport();

  const result = await new SyncPull(sql, transport).runOnce();

  assert.equal(result.restartedForProject, undefined);
  assert.deepEqual(transport.asked, [7]);
});
