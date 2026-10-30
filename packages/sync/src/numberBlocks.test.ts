import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// THE NUMBER-BLOCK REGISTRY (cloud migration 018): the fix for two computers on one block
// (docs/39 section 4.4).
//
// Like cloudSchema.test.ts these read the SQL and prove the design, not the deployment. The
// behaviour is proved on the test project by migrations/supabase/check_number_blocks.sql.

const ROOT = path.resolve(import.meta.dirname, "../../..");
const read = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), "utf8").replace(/\r\n/g, "\n");

const CLAIMS = read("migrations/supabase/006_device_claims.up.sql");
const REGISTRY = read("migrations/supabase/018_number_block_registry.up.sql");
const REGISTRY_DOWN = read("migrations/supabase/018_number_block_registry.down.sql");

const sqlOnly = (text: string): string => text.replace(/--[^\n]*/g, "");

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

/** The whole `create or replace function ... $$;` statement, exactly as written. */
function functionText(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  const open = sql.indexOf("$$", start);
  const close = sql.indexOf("$$;", open + 2);
  return sql.slice(start, close + 3);
}

test("a claim decides the number block before it takes an epoch, and refuses all three ways", () => {
  const claim = functionBody(REGISTRY, "claim_device");
  for (const refusal of ["NUMBER_BLOCK_MISSING", "NUMBER_BLOCK_TAKEN", "NUMBER_BLOCK_CHANGED"]) {
    const at = claim.indexOf(`'${refusal}'`);
    assert.ok(at >= 0, `the claim must refuse ${refusal}`);
    assert.ok(at < claim.indexOf("claim_epoch + 1"), `${refusal} must be decided before the bump: a refusal takes no epoch`);
  }
  // Two computers claiming one block at once: the primary key decides, and the loser is refused.
  assert.match(claim, /on conflict \(block\) do nothing;\s*if not found then/);
  assert.ok(claim.includes("for update"), "the device's own row is locked while its block is decided");
});

test("the claim keeps every refusal 006 made, in 006's order, with the no-caller guard first", () => {
  const before = functionBody(CLAIMS, "claim_device");
  const after = functionBody(REGISTRY, "claim_device");
  const order = (body: string) =>
    ["auth.uid() is null", "NOT_ENROLLED", "REVOKED", "BINDING_INCOMPLETE", "DEVICE_MISMATCH", "WORKSTATION_MISMATCH"].map((word) =>
      body.indexOf(word)
    );
  for (const body of [before, after]) {
    const at = order(body);
    assert.ok(at.every((index) => index >= 0), "every refusal is still there");
    assert.deepEqual([...at].sort((a, b) => a - b), at, "in the same order");
  }
});

test("every write refuses a device that holds no block, by raising, writing nothing", () => {
  const guard = functionBody(REGISTRY, "claim_is_current");
  for (const refusal of ["NOT_ENROLLED", "REVOKED", "BINDING_INCOMPLETE", "NOT_CLAIMED", "CLAIM_SUPERSEDED", "NUMBER_BLOCK_NOT_REGISTERED"]) {
    assert.match(guard, new RegExp(`raise exception '${refusal}' using errcode = '42501'`));
  }
  assert.ok(!guard.includes("insert into"), "its own raise would roll a write back");
  assert.match(guard, /return account;/);
});

test("a refusal never names the computer holding the block", () => {
  const claim = functionBody(REGISTRY, "claim_device");
  assert.ok(!claim.includes("label"), "device labels carry people's addresses");
  for (const answer of claim.match(/jsonb_build_object\([^;]*\)/g) ?? []) {
    assert.ok(!/device_id|auth_user_id/.test(answer), `an answer leaks a holder: ${answer}`);
  }
});

test("the registry and its history are the owner's: no client reads them, and history is append-only", () => {
  const statements = sqlOnly(REGISTRY);
  for (const table of ["number_blocks", "number_block_events"]) {
    assert.match(statements, new RegExp(`alter table public\\.${table} enable row level security`));
    assert.match(statements, new RegExp(`revoke all on public\\.${table} from anon, authenticated`));
    assert.ok(!new RegExp(`create policy [^;]* on public\\.${table}`).test(statements), `${table} needs no policy`);
  }
  assert.match(statements, /revoke all on sequence public\.number_block_events_seq_seq from anon, authenticated/);
  assert.match(statements, /before update or delete on public\.number_block_events/);
  assert.match(functionBody(REGISTRY, "refuse_number_block_log_change"), /raise exception 'number_block_events is append-only'/);
  // One block per computer, one computer per block.
  assert.match(statements, /block integer primary key/);
  assert.match(statements, /create unique index if not exists idx_number_blocks_device on public\.number_blocks\(device_id\)/);
});

test("one claim_device, callable by a device; moving a block is the owner's alone", () => {
  const statements = sqlOnly(REGISTRY);
  assert.match(statements, /drop function if exists public\.claim_device\(text, text, text\);/);
  assert.match(statements, /grant execute on function public\.claim_device\(text, text, text, integer\) to authenticated/);
  for (const internal of ["claim_is_current", "reassign_number_block", "refuse_number_block_log_change"]) {
    assert.match(statements, new RegExp(`revoke all on function public\\.${internal}\\(`), `${internal} is revoked`);
    assert.ok(!new RegExp(`grant execute on function public\\.${internal}\\(`).test(statements), `${internal} stays owner-only`);
  }
  for (const definer of ["claim_device", "claim_is_current", "reassign_number_block"]) {
    const declaration = statements.slice(statements.indexOf(`create or replace function public.${definer}(`));
    const header = declaration.slice(0, declaration.indexOf("$$"));
    assert.ok(header.includes("security definer") && header.includes("set search_path = ''"), `${definer} runs as the owner, pinned`);
  }
  const move = functionBody(REGISTRY, "reassign_number_block");
  for (const refusal of ["REASON_REQUIRED", "NOT_AN_ACTIVE_DEVICE", "DEVICE_HOLDS_ANOTHER_BLOCK"]) {
    assert.ok(move.includes(refusal), `a move refuses ${refusal}`);
  }
  assert.ok(move.includes("'REASSIGNED'"), "a move is recorded");
});

test("the rollback restores 006's claim exactly, and keeps the record of who held what", () => {
  for (const name of ["claim_device", "claim_is_current"]) {
    assert.equal(functionText(REGISTRY_DOWN, name), functionText(CLAIMS, name), `${name} is 006's, word for word`);
  }
  assert.match(sqlOnly(REGISTRY_DOWN), /drop function if exists public\.claim_device\(text, text, text, integer\);/);
  assert.match(sqlOnly(REGISTRY_DOWN), /grant execute on function public\.claim_device\(text, text, text\) to authenticated/);
  assert.ok(!/drop table/.test(sqlOnly(REGISTRY_DOWN)), "the registry stays: the numbers those computers issued are still out there");
  assert.match(REGISTRY_DOWN, /RE-OPENS THE PC2\/PC3 FAILURE/);
});
