import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SYNC_AGGREGATE, qrMasterDedupeKey, productionProducedDedupeKey } from "@erp/data";

// IS THE CLOUD SCHEMA ABLE TO HOLD WHAT THE LOCAL ONE CONTAINS?
//
// These checks read the SQL files and compare them. They do NOT run Postgres — there is no
// Postgres in this project and no connection to the Supabase project — so they prove the design,
// not the deployment. Nothing here claims the cloud works.
//
// They exist because this is the exact class of defect that was already in the repository: a
// cloud schema that enables Row Level Security on nineteen tables and defines no policy, and
// check constraints that predate the gatepass work and would refuse a carton at the gate. Both
// would have looked fine until a real computer tried to sync.
//
// What is checked:
//
//   * every value the local check constraints allow is allowed by the cloud's, after alignment
//   * every column the two event contracts carry exists on both sides
//   * no id column the contracts touch is still uuid, which the local model cannot fill
//   * every table the contracts use has at least one policy, and anon has none
//   * history cannot be edited: no update or delete is granted on events or the log
//   * the log's dedupe keys are built the same way on both sides

const ROOT = path.resolve(import.meta.dirname, "../../..");
const read = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), "utf8");

const LOCAL_SCHEMA = read("packages/data/src/local-schema.sql");
const CLOUD_BASELINE = read("supabase/schema.sql");
const ALIGNMENT = read("migrations/supabase/002_align_with_local_model.up.sql");
const EVENT_LOG = read("migrations/supabase/003_sync_event_log.up.sql");
const POLICIES = read("migrations/supabase/004_rls_policies.up.sql");

/**
 * The same file with its line comments removed.
 *
 * These migrations explain themselves at length, and a check that scans the raw text will
 * eventually match a sentence instead of a statement — which is exactly what happened to the
 * "anon is granted nothing" check the first time a comment mentioned granting something to anon.
 * A test that cries wolf over prose is worse than no test.
 *
 * Crude on purpose: it would also strip a `--` inside a string literal, and none of these files
 * has one.
 */
const sqlOnly = (text: string): string => text.replace(/--[^\n]*/g, "");

/** The values a `CHECK (col IN (...))` allows, from whichever file declares it. */
function checkValues(sql: string, column: string): string[] {
  const pattern = new RegExp(`${column}\\s+in\\s*\\(([^)]*)\\)`, "i");
  const match = pattern.exec(sql);
  if (match === null) return [];
  return [...match[1].matchAll(/'([^']*)'/g)].map((hit) => hit[1] as string).sort();
}

/** The column names declared inside one `create table` / `CREATE TABLE` block. */
function tableColumns(sql: string, table: string): string[] {
  const pattern = new RegExp(`create table if not exists ${table}\\s*\\(([\\s\\S]*?)\\n\\);`, "i");
  const match = pattern.exec(sql);
  assert.ok(match, `${table} not found`);
  return (match[1] as string)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !/^(primary key|foreign key|check|unique|constraint)\b/i.test(line))
    .map((line) => (line.split(/\s+/)[0] ?? "").toLowerCase())
    .filter((name) => name !== "");
}

// ─── check constraints ──────────────────────────────────────────────────────

test("the cloud allows every carton status and location the local model allows", () => {
  const localStatus = checkValues(LOCAL_SCHEMA, "current_status");
  const localLocation = checkValues(LOCAL_SCHEMA, "current_location_type");
  assert.ok(localStatus.includes("TO_GATE") && localStatus.includes("ON_GATE"), "the local gate statuses");
  assert.ok(localLocation.includes("GATE"), "the local gate location");

  // The baseline is deliberately checked too: it is where the drift was, and a future edit that
  // reintroduces it should fail here rather than in the factory.
  const baselineStatus = checkValues(CLOUD_BASELINE, "current_status");
  assert.ok(
    !baselineStatus.includes("TO_GATE"),
    "the baseline is known to be missing the gate statuses -- if this now passes, migration 002 may be redundant"
  );

  const alignedStatus = checkValues(ALIGNMENT, "current_status");
  const alignedLocation = checkValues(ALIGNMENT, "current_location_type");
  for (const value of localStatus) {
    assert.ok(alignedStatus.includes(value), `the cloud must allow the status ${value}`);
  }
  for (const value of localLocation) {
    assert.ok(alignedLocation.includes(value), `the cloud must allow the location ${value}`);
  }
});

test("the cloud log accepts exactly the two aggregate types that have contracts", () => {
  const logged: readonly string[] = checkValues(EVENT_LOG, "aggregate_type");
  assert.deepEqual([...logged], [SYNC_AGGREGATE.PRODUCTION_PRODUCED, SYNC_AGGREGATE.QR_MASTER].sort());
  // The types with no contract must not be loggable: their payloads cannot rebuild their rows.
  for (const absent of ["PRODUCTION_EVENT", "DISPATCH_EVENT", "RETURN_EVENT", "PROJECTION"]) {
    assert.equal(logged.includes(absent), false, `${absent} must not be loggable yet`);
  }
});

// ─── columns the contracts need ─────────────────────────────────────────────

test("every column the two contracts write exists in both schemas", () => {
  const needed = {
    qr_master: [
      "qr_id",
      "product_variant_id",
      "current_status",
      "current_location_type",
      "current_location_id",
      "first_event_id",
      "created_at",
      "updated_at",
    ],
    production_events: [
      "id",
      "qr_id",
      "product_variant_id",
      "event_type",
      "event_ts_local",
      "event_date",
      "event_hour",
      "factory_id",
      "workstation_id",
      "operator_id",
      "device_id",
      "article_snapshot",
      "color_snapshot",
      "size_snapshot",
      "serial_snapshot",
      "metadata_json",
      "created_at",
      "sync_status",
      "retry_count",
      "source_app",
    ],
  };

  for (const [table, columns] of Object.entries(needed)) {
    const local = tableColumns(LOCAL_SCHEMA, table);
    const cloud = tableColumns(CLOUD_BASELINE, table);
    for (const column of columns) {
      assert.ok(local.includes(column), `${table}.${column} must exist locally`);
      assert.ok(cloud.includes(column), `${table}.${column} must exist in the cloud`);
    }
  }
});

test("the alignment converts every id and timestamp the contracts carry away from uuid", () => {
  // The local model stores all of these as TEXT. factories.id is the literal 'factory-777', so a
  // uuid column cannot hold it and every production event would be refused on its factory key.
  const mustBecomeText = [
    "alter table factories alter column id type text",
    "alter table workstations alter column id type text",
    "alter table workstations alter column factory_id type text",
    "alter table operators alter column id type text",
    "alter table product_variants alter column id type text",
    "alter table qr_master alter column product_variant_id type text",
    "alter table qr_master alter column first_event_id type text",
    "alter table production_events alter column id type text",
    "alter table production_events alter column product_variant_id type text",
    "alter table production_events alter column factory_id type text",
    "alter table production_events alter column workstation_id type text",
    "alter table production_events alter column operator_id type text",
  ];
  for (const statement of mustBecomeText) {
    assert.ok(ALIGNMENT.includes(statement), `migration 002 must contain: ${statement}`);
  }

  // metadata_json as jsonb would reorder keys, so the text that comes back is not the text that
  // went in -- and the contract promises the recorded value, character for character.
  assert.ok(
    ALIGNMENT.includes("alter table production_events alter column metadata_json type text"),
    "metadata_json must not stay jsonb"
  );
  assert.ok(CLOUD_BASELINE.includes("metadata_json jsonb"), "the baseline is where that came from");
});

// ─── Row Level Security ─────────────────────────────────────────────────────

test("the baseline really does enable RLS without a single policy", () => {
  // The finding this whole migration exists for. If this ever fails, the baseline has gained
  // policies of its own and migration 004 needs re-reading before it is applied.
  assert.ok(CLOUD_BASELINE.includes("enable row level security"), "the baseline enables RLS");
  assert.equal(
    /^\s*create policy/im.test(CLOUD_BASELINE),
    false,
    "the baseline defines no policy, so everything is denied until 004 is applied"
  );
});

test("every table the contracts use has a policy, and anon has none", () => {
  const tables = [
    "factories",
    "workstations",
    "operators",
    "product_variants",
    "qr_master",
    "production_events",
    "sync_event_log",
    "device_accounts",
  ];
  for (const table of tables) {
    assert.ok(
      new RegExp(`create policy \\w+ on ${table}\\b`).test(POLICIES),
      `${table} must have at least one policy, or RLS denies it entirely`
    );
  }

  // The anon key ships inside the desktop application, so it must be worth nothing by itself.
  // Scanned without comments: the prose explains what Supabase grants anon by default, and a
  // raw-text scan matches that sentence instead of a statement.
  const statements = sqlOnly(POLICIES);
  assert.equal(/create policy[\s\S]*?\bto anon\b/.test(statements), false, "no policy may grant anon anything");
  assert.equal(/\bgrant\b[^;]*\bto anon\b/.test(statements), false, "anon must not be granted a table privilege");
  for (const table of tables) {
    assert.ok(POLICIES.includes(`revoke all on ${table} from anon`), `anon must be revoked on ${table}`);
  }
});

test("RLS is never turned off to make something work", () => {
  for (const [name, sql] of [
    ["002", ALIGNMENT],
    ["003", EVENT_LOG],
    ["004", POLICIES],
  ] as const) {
    const statements = sqlOnly(sql);
    assert.equal(/disable row level security/i.test(statements), false, `migration ${name} must not disable RLS`);
    assert.equal(/force row level security/i.test(statements), false, `migration ${name} must not force-override RLS`);
  }
});

test("history cannot be rewritten by a client", () => {
  // No update or delete policy on the tables that hold what the factory did.
  for (const table of ["production_events", "qr_master", "sync_event_log"]) {
    assert.equal(
      new RegExp(`create policy \\w+ on ${table}\\s*\\nfor (update|delete)`).test(POLICIES),
      false,
      `${table} must have no update or delete policy`
    );
  }
  assert.ok(
    POLICIES.includes("revoke update, delete on qr_master, production_events from authenticated"),
    "update and delete must be revoked outright, not merely unpoliced"
  );
  assert.ok(
    POLICIES.includes("revoke insert, update, delete on sync_event_log from authenticated"),
    "the log must be unwritable by a client -- the triggers fill it"
  );
  // And the database refuses a change even if a privileged path tried one.
  assert.ok(EVENT_LOG.includes("sync_event_log is append-only"), "the log has an append-only trigger");
});

test("a device cannot write master data, invent a product, or skip enrolment", () => {
  for (const table of ["factories", "workstations", "operators", "product_variants"]) {
    assert.equal(
      new RegExp(`create policy \\w+ on ${table}\\s*\\nfor insert`).test(POLICIES),
      false,
      `${table} must be read-only to a device`
    );
  }
  // Both references to the NEW row are qualified with the table name. Unqualified, a name that
  // also exists inside the subquery resolves to the SUBQUERY's column, and the check collapses
  // into "does any row exist at all" -- which passes for every insert and enforces nothing.
  assert.ok(
    POLICIES.includes("exists (select 1 from product_variants pv where pv.id = qr_master.product_variant_id)"),
    "a carton may only be registered against a product that already exists, checked against the new row"
  );
  assert.ok(
    POLICIES.includes("exists (select 1 from qr_master qm where qm.qr_id = production_events.qr_id)"),
    "a production event may only be written for a carton that is already registered"
  );
  assert.equal(
    /where qm\.qr_id = qr_id\b/.test(POLICIES),
    false,
    "an unqualified new-row reference would make the check meaningless"
  );
  assert.ok(POLICIES.includes("is_enrolled_device()"), "every write asks whether the caller is an enrolled device");
  assert.ok(
    POLICIES.includes("and event_type = 'PRODUCED'"),
    "only the one event type with a contract may be written"
  );
});

// ─── the defects a manual review found, pinned so they cannot come back ─────

test("a policy is never written for a table whose Row Level Security is off", () => {
  // A policy on a table with RLS off does nothing. Supabase grants every privilege on a new
  // public table to anon and authenticated, so that combination leaves the table wide open — it
  // is how sync_event_log was briefly readable by any account in the project.
  const enabled = new Set(
    [...`${CLOUD_BASELINE}\n${ALIGNMENT}\n${EVENT_LOG}\n${POLICIES}`.matchAll(
      /alter table (\w+) enable row level security/gi
    )].map((hit) => (hit[1] as string).toLowerCase())
  );
  const policed = new Set(
    [...POLICIES.matchAll(/create policy \w+ on (\w+)/gi)].map((hit) => (hit[1] as string).toLowerCase())
  );
  for (const table of policed) {
    assert.ok(enabled.has(table), `${table} has a policy but its RLS is never enabled`);
  }
  assert.ok(policed.has("sync_event_log") && enabled.has("sync_event_log"), "the log is both policed and enabled");
});

test("a column default is dropped before its type changes, never after", () => {
  // `alter column ... type text` re-evaluates the column's DEFAULT against the new type, and
  // now() has no cast to text. Dropping the default afterwards is too late: the type change has
  // already failed and taken the whole transaction with it.
  const statements = ALIGNMENT.split("\n");
  const position = (needle: string): number => statements.findIndex((line) => line.includes(needle));

  for (const column of [
    "qr_master alter column created_at",
    "qr_master alter column updated_at",
    "production_events alter column created_at",
  ]) {
    const dropAt = position(`${column} drop default`);
    const typeAt = position(`${column} type text`);
    assert.ok(dropAt >= 0, `${column} must drop its default`);
    assert.ok(typeAt >= 0, `${column} must change type`);
    assert.ok(dropAt < typeAt, `${column}: the default must be dropped BEFORE the type changes`);
  }
});

test("every column the alignment touches actually exists in the baseline", () => {
  // report_daily_summary is keyed on (report_date, factory_id) and has no product_variant_id. The
  // alignment named one anyway, which fails at apply time with "column does not exist".
  const touched = [...ALIGNMENT.matchAll(/alter table (\w+) alter column (\w+)/gi)].map((hit) => ({
    table: (hit[1] as string).toLowerCase(),
    column: (hit[2] as string).toLowerCase(),
  }));
  assert.ok(touched.length > 0, "the alignment changes some columns");

  const cache = new Map<string, string[]>();
  for (const { table, column } of touched) {
    if (!cache.has(table)) cache.set(table, tableColumns(CLOUD_BASELINE, table));
    assert.ok(
      (cache.get(table) ?? []).includes(column),
      `${table}.${column} is altered but does not exist in supabase/schema.sql`
    );
  }

  // Same for the foreign keys it recreates.
  const recreated = [...ALIGNMENT.matchAll(/foreign key \((\w+)\) references (\w+)\((\w+)\)/gi)];
  for (const hit of recreated) {
    const referenced = (hit[2] as string).toLowerCase();
    const referencedColumn = (hit[3] as string).toLowerCase();
    if (!cache.has(referenced)) cache.set(referenced, tableColumns(CLOUD_BASELINE, referenced));
    assert.ok(
      (cache.get(referenced) ?? []).includes(referencedColumn),
      `${referenced}.${referencedColumn} is referenced but does not exist`
    );
  }
});

test("every security definer function pins an EMPTY search path and qualifies what it reads", () => {
  // A path pinned to `public` is only safe while no client role can create objects there, which
  // is a default of someone else's. An empty path removes the assumption: pg_catalog stays
  // reachable whatever happens, and everything else has to be written out in full.
  const declarations: Array<[string, string, string]> = [
    ["is_enrolled_device", POLICIES, "public.device_accounts"],
    ["current_factory_id", POLICIES, "public.device_accounts"],
    ["log_qr_master_insert", EVENT_LOG, "public.sync_event_log"],
    ["log_production_produced_insert", EVENT_LOG, "public.sync_event_log"],
  ];

  for (const [fn, sql, reads] of declarations) {
    const declaration = new RegExp(`function public\\.${fn}\\(\\)[\\s\\S]*?\\n\\$\\$;`).exec(sql);
    assert.ok(declaration, `${fn} must be declared, schema-qualified`);
    const body = declaration?.[0] ?? "";
    assert.match(body, /security definer/, `${fn} must be security definer`);
    assert.match(body, /set search_path = ''/, `${fn} must pin an empty search path`);
    assert.ok(body.includes(reads), `${fn} must read ${reads} by its full name`);
    // With an empty path, an unqualified table reference would fail at run time, not at apply
    // time -- so the bare name must not appear at all.
    const bare = reads.replace("public.", "");
    assert.equal(
      new RegExp(`(from|into|join)\\s+${bare}\\b`).test(body),
      false,
      `${fn} must never reference ${bare} unqualified`
    );
  }

  // auth.uid() lives in the auth schema and is already qualified, so an empty path cannot break
  // it. COALESCE and || are SQL constructs and are not qualifiable at all, which is fine:
  // pg_catalog is always searched first and cannot be shadowed.
  assert.ok(POLICIES.includes("auth.uid()"), "the helpers read the caller from auth.uid()");
  assert.equal(/[^.]\buid\(\)/.test(POLICIES.replace(/auth\.uid\(\)/g, "")), false, "uid() must always be qualified");
});

test("no client role may call the trigger functions, or burn positions in the log", () => {
  // Postgres grants EXECUTE on a new function to PUBLIC, and Supabase grants it to anon and
  // authenticated as well -- and a direct grant is NOT removed by revoking from PUBLIC, so each
  // named role has to be revoked too.
  for (const fn of ["log_qr_master_insert", "log_production_produced_insert", "refuse_sync_log_change"]) {
    assert.ok(
      EVENT_LOG.includes(`revoke all on function public.${fn}() from public, anon, authenticated;`),
      `${fn} must be revoked from PUBLIC, anon and authenticated`
    );
  }

  // The revokes must come AFTER the triggers exist: EXECUTE is checked when a trigger is
  // created, so revoking first would refuse the CREATE TRIGGER itself.
  const lastTrigger = EVENT_LOG.lastIndexOf("create trigger");
  const firstRevoke = EVENT_LOG.indexOf("revoke all on function");
  assert.ok(firstRevoke > lastTrigger, "the function revokes must follow every create trigger");

  // A bigserial has a sequence of its own, and Supabase grants ALL ON SEQUENCES in public by
  // default -- so a client that cannot write a row could still advance the sequence.
  assert.ok(
    EVENT_LOG.includes("revoke all on sequence public.sync_event_log_seq_seq from public, anon, authenticated;"),
    "the log's sequence must not be reachable by a client"
  );
  // The owner must keep it: the triggers run as their definer and call nextval().
  assert.equal(
    /revoke[^;]*on sequence[^;]*from[^;]*\b(postgres|owner|current_user)\b/.test(EVENT_LOG),
    false,
    "the sequence must never be revoked from its owner"
  );
});

test("the helpers keep the one EXECUTE grant a policy needs", () => {
  // A policy expression is evaluated with the QUERYING role's privileges, so a device that could
  // not call is_enrolled_device() would have every policy below fail rather than simply deny.
  // The trigger functions are the opposite case and are granted to nobody.
  for (const fn of ["is_enrolled_device", "current_factory_id"]) {
    assert.ok(
      POLICIES.includes(`revoke all on function public.${fn}() from public, anon, authenticated;`),
      `${fn} must be taken from everyone first`
    );
    assert.ok(
      POLICIES.includes(`grant execute on function public.${fn}() to authenticated;`),
      `${fn} must be given back to a signed-in caller`
    );
  }
  // Privilege for the trigger functions lives in 003, beside the triggers, and nowhere else.
  assert.equal(
    /on function public\.log_/.test(POLICIES),
    false,
    "004 must not also revoke the trigger functions -- one place only"
  );
  assert.equal(
    /grant execute on function public\.(log_|refuse_)/.test(EVENT_LOG),
    false,
    "no client role may be granted execute on a trigger function"
  );
});

// ─── the log and the local outbox agree ─────────────────────────────────────

test("the cloud builds the same dedupe key the local outbox builds", () => {
  // The same business event must be the same event on both sides, or a push would be logged twice
  // and every computer would apply it twice.
  assert.equal(qrMasterDedupeKey("SK9_BLACK_7/10_000001"), "QR_MASTER:SK9_BLACK_7/10_000001");
  assert.equal(productionProducedDedupeKey("event-1"), "PRODUCTION_PRODUCED:event-1");
  assert.ok(EVENT_LOG.includes("'QR_MASTER:' || new.qr_id"), "the trigger builds the carton key the same way");
  assert.ok(
    EVENT_LOG.includes("'PRODUCTION_PRODUCED:' || new.id"),
    "the trigger builds the scan key the same way"
  );
  assert.ok(EVENT_LOG.includes("on conflict (dedupe_key) do nothing"), "and a repeat takes no second position");
});

test("the cloud payload names exactly the fields the receiving side reads", () => {
  // The reader refuses a payload missing any of these, so a mismatch here would mean every event
  // the cloud logged was rejected on arrival.
  const qrFields = ["qrId", "productVariantId", "createdAt"];
  const scanFields = [
    "eventId",
    "qrId",
    "productVariantId",
    "occurredAt",
    "eventDate",
    "eventHour",
    "factoryId",
    "workstationId",
    "operatorId",
    "deviceId",
    "article",
    "color",
    "size",
    "serial",
    "metadataJson",
    "createdAt",
    "sourceApp",
  ];
  for (const field of [...qrFields, ...scanFields]) {
    assert.ok(EVENT_LOG.includes(`'${field}',`), `the trigger must carry ${field}`);
  }
  // eventHour has to arrive as a number: the reader refuses a string.
  assert.ok(EVENT_LOG.includes("new.event_hour::int"), "eventHour must be a number, not text");
});

// ─── the event log is scoped to one factory ─────────────────────────────────
//
// Migration 004 scoped a direct read of production_events to the caller's factory and scoped the
// log carrying those same events to enrolment alone, so the log was a way round the policy: a
// device could read another factory's PRODUCED events — factoryId, workstationId, operatorId and
// every article, colour, size and serial snapshot — out of its own change feed.
//
// Migration 005 gives a log row a real factory_id, written by the trigger from
// production_events.factory_id, and filters the read by it. These checks read the file; the
// isolation itself is then DEMONSTRATED below by evaluating the policy's own expression.

const FACTORY_SCOPE = read("migrations/supabase/005_sync_event_log_factory_scope.up.sql");
const FACTORY_SCOPE_DOWN = read("migrations/supabase/005_sync_event_log_factory_scope.down.sql");

/** The body of the one `using ( ... )` in a policy definition, balanced-paren aware. */
function usingExpression(sql: string, policy: string): string {
  const start = sqlOnly(sql).indexOf(`create policy ${policy}`);
  assert.ok(start >= 0, `${policy} is not defined`);
  const from = sqlOnly(sql).indexOf("using (", start);
  assert.ok(from >= 0, `${policy} has no using clause`);
  const text = sqlOnly(sql);
  let depth = 0;
  for (let at = from + "using ".length; at < text.length; at += 1) {
    if (text[at] === "(") depth += 1;
    if (text[at] === ")") {
      depth -= 1;
      if (depth === 0) return text.slice(from + "using (".length, at).trim();
    }
  }
  assert.fail(`${policy}'s using clause is unbalanced`);
}

test("the log carries a factory of its own, and a production event cannot be logged without one", () => {
  assert.match(
    FACTORY_SCOPE,
    /alter table sync_event_log add column if not exists factory_id text references factories\(id\)/,
    "the association is a real column with a real foreign key, not a payload field"
  );

  // The trigger takes the event's own column. The payload is client-supplied and must never be
  // what a policy trusts.
  assert.match(
    FACTORY_SCOPE,
    /origin_device_id, factory_id\s*\)/,
    "the trigger inserts into the new column"
  );
  assert.match(FACTORY_SCOPE, /new\.device_id,\s*new\.factory_id\s*\)/, "and takes it from the event row");
  assert.ok(
    !/factory_id = current_factory_id\(\)[^)]*\)\s*,/.test(FACTORY_SCOPE),
    "the trigger must not stamp the signed-in device's factory onto someone else's event"
  );
  // Against the STATEMENTS, not the prose: this file's own header discusses payload->>'factoryId'
  // as the thing it refuses to use, and a raw-text check would match the sentence explaining the
  // defect instead of the SQL. That is the trap sqlOnly exists for.
  assert.ok(
    !sqlOnly(FACTORY_SCOPE).includes('payload->>'),
    "nothing may be scoped by a factory read out of the client's own document"
  );

  // The constraint is what makes a null meaningful: a stated decision about carton identities,
  // never a production event that slipped through unlabelled.
  const constraint = /check \(\s*\(aggregate_type = 'PRODUCTION_PRODUCED' and factory_id is not null\)\s*or \(aggregate_type = 'QR_MASTER' and factory_id is null\)\s*\)/;
  assert.match(FACTORY_SCOPE, constraint, "the scope constraint must pin both event types");

  // The labels on rows that already exist come from the table, by id — never from the payload.
  assert.match(FACTORY_SCOPE, /from production_events as events\s*\n\s*where events\.id = log\.aggregate_id/);
});

test("the log's read policy filters by factory, and the append-only guarantee survives the backfill", () => {
  const expression = usingExpression(FACTORY_SCOPE, "device_reads_sync_event_log");
  assert.ok(expression.includes("is_enrolled_device()"), "enrolment is still required");
  assert.ok(expression.includes("current_factory_id()"), "and so is the caller's own factory");

  // 004's version, which this replaces, was enrolment and nothing else.
  assert.notEqual(expression.replace(/\s+/g, " "), "is_enrolled_device()");

  // The one write to history is fenced, and the fence is put back in the same transaction.
  const disabled = FACTORY_SCOPE.indexOf("disable trigger trg_sync_event_log_immutable");
  const update = FACTORY_SCOPE.indexOf("update sync_event_log");
  const enabled = FACTORY_SCOPE.indexOf("enable trigger trg_sync_event_log_immutable");
  assert.ok(disabled >= 0 && update > disabled && enabled > update, "the backfill is fenced by the trigger");
  assert.ok(FACTORY_SCOPE.trimEnd().endsWith("commit;"), "and it is all one transaction");
  assert.ok(
    !/drop trigger if exists trg_sync_event_log_immutable/.test(FACTORY_SCOPE),
    "the append-only trigger is disabled and re-enabled, never dropped"
  );

  // Order and position are untouched. The only statement naming seq is the index that makes the
  // new filter cheap: nothing alters the column, renumbers it or touches its sequence.
  const statements = sqlOnly(FACTORY_SCOPE);
  assert.ok(statements.includes('idx_sync_event_log_factory_seq on sync_event_log(factory_id, seq)'));
  assert.ok(!/alter column seq|drop column.*seq|setval|restart with/i.test(statements), 'seq is untouched');
});

test("the rollback restores exactly what 004 and 003 had, and says what it costs", () => {
  assert.equal(
    usingExpression(FACTORY_SCOPE_DOWN, "device_reads_sync_event_log").replace(/\s+/g, " "),
    "is_enrolled_device()",
    "the down file puts 004's policy back verbatim"
  );
  assert.match(FACTORY_SCOPE_DOWN, /drop constraint if exists sync_event_log_factory_scope/);
  assert.match(FACTORY_SCOPE_DOWN, /drop column if exists factory_id/);
  // The trigger has to stop writing the column before the column is dropped.
  assert.ok(
    FACTORY_SCOPE_DOWN.indexOf("create or replace function public.log_production_produced_insert") <
      FACTORY_SCOPE_DOWN.indexOf("drop column if exists factory_id"),
    "the trigger is restored before the column goes"
  );
  assert.match(FACTORY_SCOPE_DOWN, /RE-OPENS THE CROSS-FACTORY READ/, "and it warns what reversing means");
});

// ─── the isolation itself, evaluated ────────────────────────────────────────
//
// There is no PostgreSQL here, so the policy cannot be exercised against the real server. What
// CAN be done is better than a reimplementation: the `using (...)` expression is lifted out of
// the migration file as written and evaluated by SQLite against rows standing in for two
// factories' events. Only the two helper functions are substituted — is_enrolled_device() is the
// caller being enrolled, current_factory_id() is which factory they are enrolled for — and those
// are exactly what migration 004 defines them to return.
//
// It proves the EXPRESSION isolates. It does not prove Supabase applies it; applying the
// migration and reading as two different device accounts is the only thing that proves that.

/** Rows as the log would hold them after 005. */
const LOG_ROWS = [
  { seq: 1, aggregate_type: "QR_MASTER", aggregate_id: "SK9_BLACK_7/10_000001", factory_id: null },
  { seq: 2, aggregate_type: "PRODUCTION_PRODUCED", aggregate_id: "event-a1", factory_id: "factory-a" },
  { seq: 3, aggregate_type: "PRODUCTION_PRODUCED", aggregate_id: "event-b1", factory_id: "factory-b" },
  { seq: 4, aggregate_type: "PRODUCTION_PRODUCED", aggregate_id: "event-a2", factory_id: "factory-a" },
  { seq: 5, aggregate_type: "QR_MASTER", aggregate_id: "SK9_BLACK_7/10_000002", factory_id: null },
];

/** What one caller may see, by running the named migration's own predicate over those rows. */
function visibleTo(
  enrolled: boolean,
  factoryId: string | null,
  policySql: string = FACTORY_SCOPE
): Array<{ seq: number; aggregate_id: string }> {
  const predicate = usingExpression(policySql, "device_reads_sync_event_log")
    .replace(/is_enrolled_device\(\)/g, enrolled ? "1" : "0")
    .replace(/current_factory_id\(\)/g, factoryId === null ? "null" : `'${factoryId}'`);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "erp-factory-scope-"));
  const raw = new DatabaseSync(path.join(root, "policy.db"));
  try {
    raw.exec(
      `CREATE TABLE sync_event_log (
         seq INTEGER PRIMARY KEY, aggregate_type TEXT NOT NULL,
         aggregate_id TEXT NOT NULL, factory_id TEXT
       )`
    );
    const insert = raw.prepare(
      "INSERT INTO sync_event_log (seq, aggregate_type, aggregate_id, factory_id) VALUES (?, ?, ?, ?)"
    );
    for (const row of LOG_ROWS) insert.run(row.seq, row.aggregate_type, row.aggregate_id, row.factory_id);

    return raw
      .prepare(`SELECT seq, aggregate_id FROM sync_event_log WHERE ${predicate} ORDER BY seq ASC`)
      .all() as Array<{ seq: number; aggregate_id: string }>;
  } finally {
    raw.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("migration 004's policy leaked every factory's production events -- the defect, reproduced", () => {
  // The same rows, under the policy as 004 wrote it. This is what the fix is for, kept here so
  // that a future edit which quietly widens the predicate back out fails loudly instead of
  // passing because the other tests only check the new file.
  const underOldPolicy = visibleTo(true, "factory-a", POLICIES).map((row) => row.aggregate_id);
  assert.ok(
    underOldPolicy.includes("event-b1"),
    "004 showed a factory-A device factory B's production event -- the whole reason for 005"
  );
  assert.equal(underOldPolicy.length, LOG_ROWS.length, "it showed every row in the log");

  // And under 005 the same caller does not.
  assert.ok(!visibleTo(true, "factory-a").map((row) => row.aggregate_id).includes("event-b1"));
});

test("a device of factory A cannot read factory B's production events, and still reads its own", () => {
  const a = visibleTo(true, "factory-a");
  const b = visibleTo(true, "factory-b");

  assert.deepEqual(
    a.filter((row) => row.aggregate_id.startsWith("event-")).map((row) => row.aggregate_id),
    ["event-a1", "event-a2"],
    "A sees its own production and nothing of B's"
  );
  assert.deepEqual(
    b.filter((row) => row.aggregate_id.startsWith("event-")).map((row) => row.aggregate_id),
    ["event-b1"],
    "and B sees only its own"
  );
  assert.ok(!a.some((row) => row.aggregate_id === "event-b1"), "B's event is invisible to A");
  assert.ok(!b.some((row) => row.aggregate_id.startsWith("event-a")), "and A's are invisible to B");
});

test("a device that is not enrolled reads nothing at all, and cannot be enrolled without a factory", () => {
  assert.deepEqual(visibleTo(false, "factory-a"), [], "enrolment is the first gate, and it is absolute");

  // The policy's global branch does not re-check enrolment, so it would show the carton rows to
  // a caller who was enrolled but had no factory. That state cannot exist, and this is why: both
  // helpers read the same row under the same conditions, and the column they disagree about is
  // NOT NULL. If that ever stops being true, the branch needs its own guard.
  assert.ok(
    sqlOnly(POLICIES).includes("factory_id text not null references factories(id)"),
    "device_accounts.factory_id must stay NOT NULL, or an enrolled device could have no factory"
  );
});

test("carton identities stay global, deliberately, and only carton identities may be unlabelled", () => {
  const a = visibleTo(true, "factory-a");
  const b = visibleTo(true, "factory-b");
  const cartons = (rows: Array<{ aggregate_id: string }>) =>
    rows.filter((row) => row.aggregate_id.startsWith("SK9")).map((row) => row.aggregate_id);

  // A carton identity has no factory anywhere in the model, and the qr_master table it describes
  // is readable by every enrolled device. Scoping the log while the table stays open would
  // protect nothing, so these rows are global BY DECISION -- recorded here so that changing it
  // is a deliberate act with a failing test, not a silent drift.
  assert.deepEqual(cartons(a), ["SK9_BLACK_7/10_000001", "SK9_BLACK_7/10_000002"]);
  assert.deepEqual(cartons(b), cartons(a), "both factories see the same carton identities");

  // The constraint is what stops that decision leaking into production events: an unlabelled
  // PRODUCTION_PRODUCED row cannot exist, so it can never ride the global branch.
  const predicate = usingExpression(FACTORY_SCOPE, "device_reads_sync_event_log");
  assert.match(
    predicate.replace(/\s+/g, " "),
    /factory_id is null and aggregate_type = 'QR_MASTER'/,
    "the global branch is reachable only by a carton identity"
  );
});

test("the cursor still advances over the gaps scoping leaves behind", () => {
  // A sees positions 1, 2, 4, 5 and never learns that 3 exists. The puller advances its cursor
  // over the settled prefix of what it FETCHED, so an invisible position is not a hole it waits
  // at -- it is simply not there. (pull.ts already proves the waiting behaviour for a position
  // that IS fetched and cannot be applied; this is the weaker case.)
  const seen = visibleTo(true, "factory-a").map((row) => row.seq);
  assert.deepEqual(seen, [1, 2, 4, 5], "the run is sparse, and strictly increasing");
  assert.deepEqual([...seen].sort((left, right) => left - right), seen, "order by seq is unchanged");
});

// ─── migration 006: binding a cloud account to one computer ─────────────────
//
// STATIC CHECKS ONLY, like everything else in this file. They read the SQL and assert what it
// says. They do NOT run PostgreSQL, so none of them is evidence that the server enforces any
// of it — only that the file asks for it. Applying 006 and claiming the same enrolment from
// two accounts is the only thing that proves enforcement.
//
// 004 authorises a write on one question: is the caller enrolled? The answer comes from
// auth.uid(), which is two strings in an environment. Copy them and a second computer is
// indistinguishable. 006 binds the account to a device id and a workstation, makes every write
// prove a current claim, and takes the direct insert privilege away so there is no second path.

const CLAIMS = read("migrations/supabase/006_device_claims.up.sql");
const CLAIMS_DOWN = read("migrations/supabase/006_device_claims.down.sql");
const MIGRATION_README = read("migrations/supabase/README.md");

/** The body of one `create or replace function public.<name>(...)` block, comments stripped. */
function functionBody(sql: string, name: string): string {
  const statements = sqlOnly(sql);
  const start = statements.indexOf(`create or replace function public.${name}(`);
  assert.ok(start >= 0, `${name} is not defined`);
  const open = statements.indexOf("$$", start);
  const close = statements.indexOf("$$", open + 2);
  assert.ok(open >= 0 && close > open, `${name} has no dollar-quoted body`);
  return statements.slice(open + 2, close);
}

const WRITE_RPCS = ["push_qr_master", "push_production_produced"] as const;

test("an account is bound to exactly one device and one workstation", () => {
  assert.match(CLAIMS, /alter table device_accounts add column if not exists device_id text/);
  // One device id to at most one account. The other direction is auth_user_id being the
  // primary key already, which 004 declares.
  assert.match(
    CLAIMS,
    /create unique index if not exists idx_device_accounts_device_id on device_accounts\(device_id\)/,
    "a device id must not be shared by two accounts"
  );
  assert.match(read("migrations/supabase/004_rls_policies.up.sql"), /auth_user_id uuid primary key/);

  // Nullable, because existing enrolments have none and inventing one would be guessing which
  // computer they are. Every function therefore has to refuse a null binding -- next test.
  assert.ok(!/add column if not exists device_id text not null/.test(CLAIMS));
});

test("a claim is monotonic, locked, and refuses every incomplete or revoked binding", () => {
  const claim = functionBody(CLAIMS, "claim_device");
  assert.ok(claim.includes("for update"), "the row lock is what stops two claims taking one epoch");
  assert.match(claim, /claim_epoch \+ 1/, "the epoch only ever goes up");
  assert.ok(claim.includes("gen_random_uuid()"), "each claim gets a fresh holder");

  for (const refusal of ["NOT_ENROLLED", "REVOKED", "BINDING_INCOMPLETE", "DEVICE_MISMATCH", "WORKSTATION_MISMATCH"]) {
    assert.ok(claim.includes(refusal), `a claim must refuse ${refusal}`);
  }
});

test("a call with no authenticated user is refused before anything is looked up or written", () => {
  const claim = functionBody(CLAIMS, "claim_device");

  // auth.uid() is null in the Supabase SQL editor (owner connection, no PostgREST request) and
  // for any JWT without a `sub`. Before the guard, the lookup found no row, the NOT_ENROLLED
  // branch tried to log the refusal, and device_claim_events.auth_user_id is `not null` -- so
  // the insert raised and the reasoned refusal never came back. Confirmed in the disposable
  // project on 2026-10-18.
  const guard = claim.indexOf("if auth.uid() is null then");
  assert.ok(guard >= 0, "claim_device must refuse a call that has no authenticated user");

  const lookup = claim.indexOf("select * into account");
  assert.ok(lookup >= 0, "the account lookup must still be there");
  assert.ok(guard < lookup, "the guard must come BEFORE the lookup, or the old path runs first");

  // And before every audit insert, which is the statement that actually failed.
  const firstInsert = claim.indexOf("insert into public.device_claim_events");
  assert.ok(firstInsert >= 0, "refusals are still audited");
  assert.ok(guard < firstInsert, "nothing may be written before the guard decides");

  // The reason the client already classifies, so no transport change is needed for it.
  assert.match(
    claim.slice(guard, lookup),
    /return jsonb_build_object\('ok', false, 'reason', 'NOT_ENROLLED'\)/,
    "the guard returns a refusal, and returns it rather than raising"
  );

  // THE FIXES THAT WERE NOT MADE. Each would have made the audit less trustworthy than no row.
  assert.match(CLAIMS, /auth_user_id uuid not null/, "auth_user_id must stay not null");
  assert.ok(
    !/coalesce\(auth\.uid\(\)/.test(sqlOnly(CLAIMS)),
    "no sentinel uuid stands in for a caller that did not identify itself"
  );
});

test("claim_is_current still refuses by raising, and never logs an audit row", () => {
  const guard = functionBody(CLAIMS, "claim_is_current");

  // It has the same null-uid path -- the lookup finds nothing -- but it RAISES rather than
  // inserting, so it was never affected and must not acquire an insert now. A write here would
  // be rolled back by the raise that follows it anyway, so an audit insert in this function
  // records nothing and can only reintroduce the not-null failure.
  assert.ok(
    !guard.includes("insert into public.device_claim_events"),
    "claim_is_current must not log: its own raise would roll the row back"
  );
  assert.ok(!guard.includes("insert into"), "it writes nothing at all");

  for (const refusal of ["NOT_ENROLLED", "REVOKED", "BINDING_INCOMPLETE", "NOT_CLAIMED", "CLAIM_SUPERSEDED"]) {
    assert.match(
      guard,
      new RegExp(`raise exception '${refusal}' using errcode = '42501'`),
      `${refusal} must stay a raise with an insufficient-privilege code`
    );
  }
  // It returns the account on success, so a caller cannot mistake a refusal for a row.
  assert.match(guard, /return account;/);
});

test("every supported write validates the claim in the same transaction as the write", () => {
  for (const rpc of WRITE_RPCS) {
    const body = functionBody(CLAIMS, rpc);
    assert.match(
      body,
      /account := public\.claim_is_current\(p_epoch, p_holder\);/,
      `${rpc} must validate the claim`
    );
    // Validated BEFORE anything is inserted, in the same function body, which PostgREST runs
    // as one transaction.
    assert.ok(
      body.indexOf("claim_is_current") < body.indexOf("insert into public."),
      `${rpc} must check the claim before it writes`
    );
    assert.ok(body.includes("on conflict"), `${rpc} must stay idempotent for a retried push`);
  }

  // The shared check takes a share lock, so a concurrent claim_device() -- which takes `for
  // update` -- waits for this write to commit. An epoch that validates is still current when
  // the row lands, which is the difference between atomic and merely close.
  const guard = functionBody(CLAIMS, "claim_is_current");
  assert.ok(guard.includes("for share"), "the guard must block a concurrent claim");
  for (const refusal of ["NOT_ENROLLED", "REVOKED", "BINDING_INCOMPLETE", "NOT_CLAIMED", "CLAIM_SUPERSEDED"]) {
    assert.ok(guard.includes(refusal), `a stale claim must be refused with ${refusal}`);
  }
});

test("there is no direct insert left that could skip the claim", () => {
  assert.match(
    sqlOnly(CLAIMS),
    /revoke insert on qr_master, production_events from authenticated/,
    "the privilege the whole file rests on"
  );
  // And nothing hands it back in the same file.
  assert.ok(
    !/grant insert on qr_master|grant select, insert on qr_master/.test(sqlOnly(CLAIMS)),
    "006 must not re-grant what it revokes"
  );
});

test("a production event must match the account's factory AND its workstation", () => {
  const body = functionBody(CLAIMS, "push_production_produced");
  assert.ok(body.includes("WRONG_FACTORY"), "the factory is checked");
  assert.ok(body.includes("WRONG_WORKSTATION"), "and so is the workstation, which 004 never did");
  assert.match(body, /item->>'factory_id' is distinct from account\.factory_id/);
  assert.match(body, /item->>'workstation_id' is distinct from account\.workstation_id/);
  assert.ok(body.includes("QR_NOT_REGISTERED_YET"), "the carton must already be registered");

  // The policy is brought into line too, so the two cannot drift if a grant ever returns.
  assert.match(CLAIMS, /workstation_id = current_workstation_id\(\)/);
  assert.match(CLAIMS, /create or replace function public\.current_workstation_id\(\) returns text/);
});

/** The per-row loop of a push RPC: everything between `loop` and `end loop`, comments stripped. */
function pushLoop(name: string): string {
  const body = functionBody(CLAIMS, name);
  const open = body.indexOf("loop");
  const close = body.indexOf("end loop");
  assert.ok(open >= 0 && close > open, `${name} has no per-row loop`);
  return body.slice(open + "loop".length, close);
}

test("a production event must also carry the account's own device id", () => {
  const loop = pushLoop("push_production_produced");

  // production_events.device_id is free text with no foreign key, and 004 had no way to check
  // it. Without this a legitimate claim holder could attribute work to any device id it liked,
  // as long as the factory and workstation were its own.
  assert.match(
    loop,
    /item->>'device_id' is distinct from account\.device_id/,
    "the submitted device id must be compared with the account's registered one"
  );
  assert.ok(loop.includes("WRONG_DEVICE"), "and a mismatch must be refused as WRONG_DEVICE");
  assert.ok(
    loop.indexOf("WRONG_DEVICE") < loop.indexOf("insert into public.production_events"),
    "checked before the write, like every other guard here"
  );

  // MATCHING: `is distinct from` is false when the two are equal, so a correct device id falls
  // straight through to the insert. Exactly one comparison of this column exists, so there is no
  // second rule that could refuse a matching one.
  assert.equal(
    [...loop.matchAll(/item->>'device_id' is distinct from/g)].length,
    1,
    "one rule for the device id, not two"
  );

  // NULL: `is distinct from` is TRUE against a non-null value, so a null submitted device id is
  // a mismatch and not an unanswered comparison. The only case that would let a null through is
  // null-against-null, and that cannot arise -- claim_is_current has already refused an account
  // whose own device_id is null, so the right-hand side is never null here.
  const guard = functionBody(CLAIMS, "claim_is_current");
  assert.match(guard, /account\.device_id is null or account\.workstation_id is null/);
  assert.ok(guard.includes("BINDING_INCOMPLETE"), "an unbound account never reaches a push");
  // A null is caught by the payload guard first, which is where its reason comes from.
  assert.match(loop, /item->>'device_id' is null/, "a null device id is PAYLOAD_INCOMPLETE");
});

test("an unacceptable production event is refused on its own, not at the batch's expense", () => {
  const loop = pushLoop("push_production_produced");

  // The two foreign keys 002 re-adds that nothing else in this function covered. Neither is
  // master data that synchronises -- the README's provisioning step says the owner creates each
  // computer's operators and the product_variants its cartons belong to -- so an unprovisioned
  // one is an expected condition, not a corrupt payload.
  assert.match(
    loop,
    /not exists \(select 1 from public\.product_variants pv where pv\.id = item->>'product_variant_id'\)/,
    "the product variant must be checked, as push_qr_master already checks it"
  );
  assert.ok(loop.includes("UNKNOWN_PRODUCT_VARIANT"));
  assert.match(
    loop,
    /item->>'operator_id' is not null\s+and not exists \(select 1 from public\.operators o where o\.id = item->>'operator_id'\)/,
    "a named operator must exist"
  );
  assert.ok(loop.includes("UNKNOWN_OPERATOR"));

  // Only a NAMED operator has to exist. The column is nullable and an event without one is
  // valid, which is why operator_id is absent from the payload-completeness list.
  assert.ok(!loop.includes("'operator_id' is null"), "a missing operator is not a refusal");

  for (const guard of ["UNKNOWN_PRODUCT_VARIANT", "UNKNOWN_OPERATOR"]) {
    assert.ok(
      loop.indexOf(guard) < loop.indexOf("insert into public.production_events"),
      `${guard} must be decided before the row is written`
    );
  }
});

test("no row in a push batch can abort the rows beside it", () => {
  for (const rpc of WRITE_RPCS) {
    const loop = pushLoop(rpc);

    // THIS IS THE PROPERTY THAT MATTERS. A raise inside the loop rolls the whole function back,
    // and the drain settles a thrown push as a TRANSIENT failure for every row it leased.
    // Transient attempts are unbounded by design, so such a row is never parked: one
    // unacceptable event would stall the outbox instead of being refused.
    assert.ok(!/\braise\b/.test(loop), `${rpc} must not raise from inside its per-row loop`);

    // And every refusal ends that row and only that row.
    const refusals = [...loop.matchAll(/'outcome', 'REFUSED'/g)].length;
    const continues = [...loop.matchAll(/\bcontinue;/g)].length;
    assert.ok(refusals > 0, `${rpc} must be able to refuse a row`);
    assert.equal(continues, refusals, `${rpc}: every REFUSED must continue to the next row`);
  }

  // A payload that is not an array still raises, and should: it is one answer about the whole
  // call, not a verdict on any row. Outside the loop, which is why the check above scopes to it.
  for (const rpc of WRITE_RPCS) {
    assert.match(functionBody(CLAIMS, rpc), /raise exception 'ROWS_NOT_AN_ARRAY'/);
  }
});

test("carton identities stay global, and their opening state is not the caller's to choose", () => {
  const body = functionBody(CLAIMS, "push_qr_master");
  // Option A, decided 2026-10-17: qr_master has no tenant column and 006 does not invent one.
  assert.ok(!body.includes("factory_id"), "push_qr_master must not scope cartons by factory");
  // The opening state is written here, so there is no parameter through which to ask for another.
  assert.match(body, /'PRODUCED', 'FACTORY', null/);
  assert.ok(body.includes("UNKNOWN_PRODUCT_VARIANT"), "the product must exist, as 004 required");
});

test("every security definer function pins an empty search path and is granted on purpose", () => {
  const definers = [
    "current_workstation_id",
    "claim_device",
    "claim_is_current",
    "heartbeat_device",
    "push_qr_master",
    "push_production_produced",
  ];
  const statements = sqlOnly(CLAIMS);
  for (const name of definers) {
    const declaration = statements.slice(statements.indexOf(`create or replace function public.${name}(`));
    const header = declaration.slice(0, declaration.indexOf("$$"));
    assert.ok(header.includes("security definer"), `${name} must run as the owner`);
    assert.ok(header.includes("set search_path = ''"), `${name} must pin an EMPTY search path`);
    assert.match(statements, new RegExp(`revoke all on function public\\.${name}\\(`), `${name} must be revoked first`);
  }

  // Callable by a signed-in device; the internal guard and the log trigger are not.
  for (const callable of ["claim_device", "heartbeat_device", "push_qr_master", "push_production_produced", "current_workstation_id"]) {
    assert.match(statements, new RegExp(`grant execute on function public\\.${callable}\\(.*\\) to authenticated`));
  }
  for (const internal of ["claim_is_current", "refuse_claim_log_change"]) {
    assert.ok(
      !new RegExp(`grant execute on function public\\.${internal}\\(`).test(statements),
      `${internal} must stay owner-only`
    );
  }
});

test("the claim audit is append-only, unreadable by a client, and holds no secret", () => {
  assert.match(CLAIMS, /create table if not exists device_claim_events/);
  assert.match(CLAIMS, /alter table device_claim_events enable row level security/);
  assert.ok(
    !/create policy .* on device_claim_events/.test(sqlOnly(CLAIMS)),
    "no policy: RLS with none denies everything, which is what the owner's record wants"
  );
  assert.match(sqlOnly(CLAIMS), /revoke all on device_claim_events from anon, authenticated/);
  assert.match(sqlOnly(CLAIMS), /revoke all on sequence device_claim_events_seq_seq from anon, authenticated/);
  assert.match(CLAIMS, /create trigger trg_device_claim_events_immutable\s*\nbefore update or delete on device_claim_events/);
  assert.match(functionBody(CLAIMS, "refuse_claim_log_change"), /raise exception 'device_claim_events is append-only'/);

  // Columns hold ids and short machine-readable reasons. Nothing that could carry a token.
  for (const forbidden of ["token", "password", "secret", "anon_key", "refresh"]) {
    assert.ok(!sqlOnly(CLAIMS).toLowerCase().includes(forbidden), `006 must not mention ${forbidden}`);
  }
});

test("the rollback says what reversing it costs", () => {
  assert.match(CLAIMS_DOWN, /RE-OPENS UNBOUND ACCESS/);
  assert.match(CLAIMS_DOWN, /RE-ENABLES REVOKED DEVICES/);
  // The warning wraps across a comment line, so the prefix sits between the two words.
  assert.match(
    CLAIMS_DOWN,
    /Supabase[\s\S]{0,8}Auth user is ALSO disabled/,
    "revocation only survives a rollback if the auth user is disabled too"
  );
  assert.match(CLAIMS_DOWN, /DISCARDS THE AUDIT/);

  // And it really does restore what 004 had: the grant back, the policy without the
  // workstation clause, then the functions and columns in dependency order.
  assert.match(CLAIMS_DOWN, /grant insert on qr_master, production_events to authenticated/);
  const restored = sqlOnly(CLAIMS_DOWN);
  assert.ok(!/workstation_id = current_workstation_id\(\)/.test(restored), "004's policy had no workstation clause");
  assert.ok(
    restored.indexOf("grant insert on qr_master") < restored.indexOf("drop function if exists public.push_production_produced"),
    "the privilege returns before the functions that replaced it are dropped"
  );
  assert.ok(
    restored.indexOf("drop function if exists public.current_workstation_id") <
      restored.indexOf("alter table device_accounts drop column if exists device_id"),
    "nothing may still read a column that is about to go"
  );
});

test("both new files are one transaction, and the README states the order and the risk", () => {
  for (const file of [CLAIMS, CLAIMS_DOWN]) {
    assert.ok(file.trimStart().startsWith("--"), "each file explains itself first");
    assert.ok(sqlOnly(file).trimStart().startsWith("begin;"));
    assert.ok(file.trimEnd().endsWith("commit;"));
  }
  assert.match(MIGRATION_README, /002.*→.*003.*→.*004.*→.*005.*→.*006/s);
  assert.match(MIGRATION_README, /`005` and `006` are unapplied/);
  // The client depends on the privilege 006 revokes, and the README has to say so.
  assert.match(MIGRATION_README, /Breaks the current transport until it is changed to call the RPCs/);
});

// ─── the claim holder is not readable through an ordinary query ─────────────
//
// Eviction only works because a superseded device cannot learn the epoch and holder that
// replaced its own. Two copies of one enrolment share one auth.uid(), and migration 004 grants
// a table-level select on device_accounts with a policy letting a device read its own row — so
// without the restriction below the evicted copy could SELECT the current claim state and keep
// writing, never calling claim_device and never being evicted. The mechanism would be
// decorative.
//
// STATIC CHECKS. They read the SQL. Whether PostgreSQL enforces the privileges this way is not
// something a text assertion can show.

/** The column list of one `grant select (...) on <table> to <role>` statement. */
function grantedColumns(sql: string, table: string, role: string): string[] {
  const pattern = new RegExp(`grant select \\(([^)]*)\\) on ${table} to ${role}`, "i");
  const match = pattern.exec(sqlOnly(sql));
  assert.ok(match, `no column-level select grant on ${table} to ${role}`);
  return (match[1] as string)
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "")
    .sort();
}

test("a device cannot read the claim epoch or the holder from the table", () => {
  const statements = sqlOnly(CLAIMS);

  // The table-level grant has to GO. A column-level revoke on its own would do nothing:
  // in PostgreSQL a table-level privilege dominates the column-level ones.
  assert.match(
    statements,
    /revoke select on device_accounts from authenticated/,
    "the dominating table-level grant must be removed, not merely narrowed"
  );
  assert.ok(
    !/revoke select \([^)]*\) on device_accounts from authenticated/i.test(statements),
    "a column-level revoke would be the wrong instrument here, and a misleading one"
  );

  const granted = grantedColumns(CLAIMS, "device_accounts", "authenticated");
  assert.ok(!granted.includes("claim_epoch"), "claim_epoch must not be granted");
  assert.ok(!granted.includes("claim_holder"), "claim_holder must not be granted");

  // And what IS granted is the enrolment a device may legitimately see.
  assert.deepEqual(granted, [
    "auth_user_id",
    "device_id",
    "enrolled_at",
    "factory_id",
    "is_active",
    "label",
    "last_seen_at",
    "last_seen_version",
    "replaced_by",
    "revoked_at",
    "workstation_id",
  ]);
});

test("nothing in the migration hands the table-level read back", () => {
  const statements = sqlOnly(CLAIMS);
  // Any `grant select on device_accounts` WITHOUT a column list would restore the domination
  // and silently undo the whole restriction.
  const tableLevel = /grant select\s+on\s+[^;]*device_accounts[^;]*to\s+authenticated/i;
  assert.ok(!tableLevel.test(statements), "006 must not re-grant a table-level select");

  // The revoke must come before the column grant, or the grant is wiped by it.
  assert.ok(
    statements.indexOf("revoke select on device_accounts from authenticated") <
      statements.indexOf("grant select ("),
    "the table-level grant is removed first, then the columns are given back"
  );

  // The holder appears nowhere a client could reach: not in a view, not in a returns clause of
  // anything granted to authenticated except the claim itself.
  const disclosures = [...statements.matchAll(/claim_holder/g)];
  assert.ok(disclosures.length > 0);
  assert.ok(!/create view|create materialized view/i.test(statements), "no view may expose it either");
});

test("the claim itself still issues the epoch and the holder to its caller", () => {
  const claim = functionBody(CLAIMS, "claim_device");
  assert.match(
    claim,
    /jsonb_build_object\('ok', true, 'epoch', new_epoch, 'holder', new_holder\)/,
    "the one authorised disclosure, to the caller it was just issued to"
  );
  // Still written atomically under the row lock.
  assert.ok(claim.includes("for update"));
  assert.match(claim, /set claim_epoch = new_epoch,\s*\n\s*claim_holder = new_holder/);
  // And it is still callable by a device, or nothing could ever claim.
  assert.match(
    sqlOnly(CLAIMS),
    /grant execute on function public\.claim_device\(text, text, text\) to authenticated/
  );
  // No second way to read it: the holder must never be handed out by a read RPC.
  for (const readRpc of ["current_workstation_id", "heartbeat_device"]) {
    assert.ok(
      !functionBody(CLAIMS, readRpc).includes("'holder'"),
      `${readRpc} must not disclose the holder`
    );
  }
});

test("the rollback puts 004's permissions back, deliberately and in order", () => {
  const restored = sqlOnly(CLAIMS_DOWN);
  assert.match(
    restored,
    /revoke select \([^)]*\) on device_accounts from authenticated/,
    "the column grants are cleared rather than left as residue"
  );
  assert.match(restored, /grant select on device_accounts to authenticated/, "004's table-level grant returns");
  assert.ok(
    restored.indexOf("revoke select (") < restored.indexOf("grant select on device_accounts to authenticated"),
    "the column grants go before the table-level grant that would dominate them"
  );
  // The column list names columns this file drops further down, so it must run before the drops.
  assert.ok(
    restored.indexOf("revoke select (") < restored.indexOf("alter table device_accounts drop column"),
    "columns cannot be named in a revoke after they have been dropped"
  );
});

// ─── F3: one device id, agreed between the account and the workstation ───────────────────────
//
// workstations.device_id already says which computer a station belongs to, and the desktop
// treats it as the authority — ensureOperationalContext writes it from the installation's own
// deviceId, and resolveInstallation reads the deviceId back out of it to adopt an existing
// database. device_accounts.device_id is the same fact recorded a second time, and 006 compares
// the two nowhere: claim_device checks the client's arguments against the account's own columns
// and never reads the workstations row. These tests pin the constraint that closes that.

/** The text of one `alter table ... add constraint <name> ...;` statement, comments stripped. */
function constraintClause(sql: string, name: string): string {
  const statements = sqlOnly(sql);
  const start = statements.indexOf(`add constraint ${name}`);
  assert.ok(start >= 0, `${name} is not declared`);
  const end = statements.indexOf(";", start);
  assert.ok(end > start, `${name} has no terminating semicolon`);
  return statements.slice(start, end);
}

const PAIR_FK = "device_accounts_workstation_device_fkey";

test("an account's device id must be the one its workstation belongs to", () => {
  const clause = constraintClause(CLAIMS, PAIR_FK);
  assert.match(
    clause,
    /foreign key \(workstation_id, device_id\) references workstations \(id, device_id\)/,
    "the pair must be constrained, not either column alone"
  );
  // On device_accounts, not on workstations: the account is the side that has to agree.
  assert.match(
    sqlOnly(CLAIMS),
    new RegExp(`alter table device_accounts\\s+add constraint ${PAIR_FK}`),
    "the constraint belongs to device_accounts"
  );
  // A single-column FK to workstations(device_id) would compile and prove the weaker thing:
  // that the device id names SOME workstation, not this account's.
  assert.ok(
    !/references workstations ?\(device_id\)/.test(sqlOnly(CLAIMS)),
    "a single-column reference does not enforce the pair"
  );
});

test("the foreign key's target index is created before the key that needs it", () => {
  const statements = sqlOnly(CLAIMS);
  const index = statements.indexOf("create unique index if not exists idx_workstations_id_device on workstations(id, device_id)");
  assert.ok(index >= 0, "the target index must exist: a composite FK needs one on exactly those columns");
  assert.ok(
    index < statements.indexOf(`add constraint ${PAIR_FK}`),
    "PostgreSQL rejects the constraint if its target index is not there yet"
  );
});

test("the pair constraint keeps every existing enrolment, so it must not be MATCH FULL", () => {
  const clause = constraintClause(CLAIMS, PAIR_FK);
  // MATCH SIMPLE -- the default -- is satisfied whenever ANY referencing column is null. That is
  // what lets the null device_id this migration leaves on every existing enrolment pass, so only
  // a RECORDED binding is checked. MATCH FULL would demand both columns, reject those rows, and
  // roll the whole migration back.
  assert.ok(!/match full/i.test(clause), "match full would reject the null bindings 006 creates");
  assert.ok(!/match partial/i.test(clause), "match partial is not implemented in PostgreSQL");
  // And the column itself stays nullable, which is the premise of all of the above.
  assert.ok(
    !/add column if not exists device_id text not null/.test(sqlOnly(CLAIMS)),
    "device_id must stay nullable: inventing one for an existing enrolment would be a guess"
  );
});

test("a workstation's device id cannot be re-pointed by a cascade", () => {
  const clause = constraintClause(CLAIMS, PAIR_FK);
  // Changing which computer a station belongs to must be a deliberate re-enrolment -- that is
  // what replaced_by is for. A cascade would carry the binding to a different physical machine
  // silently, which is the one outcome device binding exists to prevent.
  assert.ok(!/on update/i.test(clause), "no on-update action: the default NO ACTION must refuse");
  assert.ok(!/on delete/i.test(clause), "no on-delete action either");
  assert.ok(!/cascade/i.test(clause), "and no cascade under any spelling");
});

test("006 enforces the pair without touching a single workstation record", () => {
  const statements = sqlOnly(CLAIMS);
  // The owner's record of which computer a station belongs to is not this file's to correct. The
  // constraint is declared and existing rows are validated; nothing is written.
  for (const write of [
    "insert into workstations",
    "insert into public.workstations",
    "update workstations",
    "update public.workstations",
    "delete from workstations",
    "alter table workstations alter column",
    "alter table workstations drop",
  ]) {
    assert.ok(!statements.includes(write), `006 must not ${write}`);
  }
  // The only statement naming that table is the index the foreign key points at.
  const mentions = [...statements.matchAll(/^[^\n]*\bworkstations\b[^\n]*$/gm)]
    .map((hit) => hit[0].trim())
    .filter((line) => !line.startsWith("foreign key") && !line.includes("device_accounts"));
  assert.deepEqual(
    mentions,
    ["create unique index if not exists idx_workstations_id_device on workstations(id, device_id);"],
    "the index is the only thing 006 does to workstations"
  );
});

test("the pair constraint rests on a target column that is complete and unchanged", () => {
  // not null, so the referenced side is never half-missing; unique, so the baseline already
  // treats one device as belonging to one station.
  assert.match(
    CLOUD_BASELINE,
    /create table if not exists workstations \([\s\S]*?device_id text not null unique[\s\S]*?\n\);/,
    "workstations.device_id must be text not null unique in the baseline"
  );
  // 002 converts workstations.id and factory_id and deliberately leaves device_id alone. If that
  // ever changes, the null-safety and type arguments above stop holding.
  assert.ok(
    !/alter table workstations alter column device_id/.test(sqlOnly(ALIGNMENT)),
    "002 must not alter workstations.device_id"
  );
  assert.match(sqlOnly(ALIGNMENT), /alter table workstations alter column id type text/, "but it does convert the id");
  // And the reason devices(id) is not the anchor: 002 leaves it uuid, which a text column cannot
  // reference. If 002 ever converts it, revisit which table owns this fact.
  assert.ok(
    !/alter table devices alter column id type text/.test(sqlOnly(ALIGNMENT)),
    "devices.id stays uuid, so it cannot be the referent for a text device_id"
  );
});

test("the rollback removes the pair constraint before either side of it", () => {
  const restored = sqlOnly(CLAIMS_DOWN);
  const fk = restored.indexOf(`drop constraint if exists ${PAIR_FK}`);
  const target = restored.indexOf("drop index if exists idx_workstations_id_device");
  const column = restored.indexOf("alter table device_accounts drop column if exists device_id");
  assert.ok(fk >= 0, "the rollback must drop the constraint");
  assert.ok(target >= 0, "and the index it created as the target");
  assert.ok(fk < target, "the constraint stops referencing the index before the index goes");
  assert.ok(fk < column, "and before the column it references is dropped");
  // The rollback restores nothing in workstations because 006 changed nothing there.
  assert.ok(!/insert into workstations|update workstations/.test(restored), "there is no workstation row to restore");
});
