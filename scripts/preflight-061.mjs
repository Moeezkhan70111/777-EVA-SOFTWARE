// Phase 1a — preflight for migration 061_rm_session_number_unique
//
// RUN THIS ONLY AGAINST A RESTORED COPY of the production database, never the live file.
// It opens the database READ-ONLY, writes nothing, and hashes the file before and after so
// you can prove it was not altered.
//
//   node scripts/preflight-061.mjs "D:\erp-restore\erp.local.sqlite"
//
// Migration 061 adds:
//   CREATE UNIQUE INDEX idx_rm_receiving_sessions_number ON raw_material_receiving_sessions(session_number)
//   CREATE UNIQUE INDEX idx_rm_issue_sessions_number     ON raw_material_issue_sessions(session_number)
//
// Those statements FAIL if the table already holds two rows with the same session_number.
// Because migrations run automatically at startup inside one transaction, a failure means the
// ERP will not open — nothing is written, but nobody can work. This script tells you, before
// you deploy, whether that will happen.
//
// It never modifies, renumbers, merges or deletes anything. See docs/26-phase-1a-migration-plan.md.

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const target = process.argv[2];

if (!target) {
  console.error("\nUsage: node scripts/preflight-061.mjs \"<path to a RESTORED COPY of erp.local.sqlite>\"\n");
  process.exit(2);
}

const resolved = path.resolve(target);

// ─── Guard: refuse to touch the live production database ─────────────────────
const liveRoots = [
  path.join(process.env.LOCALAPPDATA ?? "", "777-erp"),
  path.join(process.env.APPDATA ?? "", "777-erp"),
];
for (const root of liveRoots) {
  if (root && resolved.toLowerCase().startsWith(path.resolve(root).toLowerCase())) {
    console.error(`\nREFUSING TO RUN.\n\n  ${resolved}\n\nis inside the live ERP data folder. Restore a copy somewhere else and point this script at that.\n`);
    process.exit(2);
  }
}
if (!fs.existsSync(resolved)) {
  console.error(`\nNot found: ${resolved}\n`);
  process.exit(2);
}

const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const line = (s = "") => console.log(s);

line("\n================ PHASE 1a PREFLIGHT — MIGRATION 061 ================\n");

// ─── 1. Provenance of the copy ───────────────────────────────────────────────
const statBefore = fs.statSync(resolved);
const hashBefore = sha256(resolved);

line("1. THE FILE UNDER TEST");
line(`   path          : ${resolved}`);
line(`   size          : ${statBefore.size.toLocaleString()} bytes`);
line(`   last modified : ${statBefore.mtime.toISOString()}`);
line(`   sha256        : ${hashBefore}`);
for (const side of ["-wal", "-shm"]) {
  if (fs.existsSync(resolved + side)) {
    const s = fs.statSync(resolved + side);
    line(`   ${side.padEnd(14)}: present, ${s.size.toLocaleString()} bytes${side === "-wal" && s.size > 0 ? "   <-- NON-EMPTY: the copy may not be a clean snapshot" : ""}`);
  }
}
line("   Record the sha256 above. Confirm it matches the backup you restored from.");
line("");

const db = new DatabaseSync(resolved, { readOnly: true });
let verdictBlocking = false;
let alreadyApplied = false;

try {
  // ─── 2. Integrity ──────────────────────────────────────────────────────────
  line("2. INTEGRITY OF THE COPY");
  const integrity = db.prepare("PRAGMA integrity_check").get().integrity_check;
  const fkViolations = db.prepare("PRAGMA foreign_key_check").all().length;
  const pageCount = db.prepare("PRAGMA page_count").get().page_count;
  line(`   integrity_check   : ${integrity}`);
  line(`   foreign_key_check : ${fkViolations} violation(s)`);
  line(`   page_count        : ${pageCount}`);
  if (integrity !== "ok" || fkViolations > 0) {
    line("   STOP. The restored copy is not sound. Restore again from a different backup");
    line("   before drawing any conclusion from the checks below.");
    verdictBlocking = true;
  }
  line("");

  // ─── 3. Has 061 already run? ───────────────────────────────────────────────
  line("3. HAS MIGRATION 061 ALREADY BEEN APPLIED?");
  const applied = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((r) => r.version);
  const highest = applied[applied.length - 1] ?? "(none)";
  alreadyApplied = applied.includes("061_rm_session_number_unique");
  const idx = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_rm_receiving_sessions_number','idx_rm_issue_sessions_number') ORDER BY name")
    .all()
    .map((r) => r.name);

  line(`   migrations applied : ${applied.length}`);
  line(`   highest version    : ${highest}`);
  line(`   061 recorded       : ${alreadyApplied ? "YES" : "no"}`);
  line(`   061 indexes present: ${idx.length ? idx.join(", ") : "none"}`);
  if (alreadyApplied && idx.length === 2) {
    line("");
    line("   => 061 HAS ALREADY RUN SUCCESSFULLY on this database.");
    line("      It could only have succeeded if there were no duplicates, so the duplicate");
    line("      question is already answered and the deployment blocker is resolved.");
    line("      The checks below should confirm zero duplicates.");
  } else if (alreadyApplied !== (idx.length === 2)) {
    line("");
    line("   => INCONSISTENT: the migration record and the indexes disagree. Do not deploy.");
    line("      Report this exactly as printed.");
    verdictBlocking = true;
  }
  line("");

  // ─── 4. The duplicate checks ───────────────────────────────────────────────
  const tables = [
    { table: "raw_material_receiving_sessions", code: "RMI" },
    { table: "raw_material_issue_sessions", code: "RMO" },
  ];

  line("4. DUPLICATE SESSION NUMBERS");
  let totalDuplicateValues = 0;

  for (const { table, code } of tables) {
    const total = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
    const distinct = db.prepare(`SELECT COUNT(DISTINCT session_number) AS c FROM ${table}`).get().c;
    const dupes = db
      .prepare(`SELECT session_number, COUNT(*) AS n FROM ${table} GROUP BY session_number HAVING n > 1 ORDER BY session_number`)
      .all();

    line("");
    line(`   ${table}`);
    line(`     rows                : ${total}`);
    line(`     distinct numbers    : ${distinct}`);
    line(`     duplicated numbers  : ${dupes.length}`);

    if (dupes.length === 0) {
      line(`     => CLEAN. The unique index on ${table}.session_number would be created without error.`);
      continue;
    }

    totalDuplicateValues += dupes.length;
    verdictBlocking = true;
    line(`     => BLOCKING. Affected rows below. Do NOT deploy. Do NOT edit anything.`);
    for (const d of dupes) {
      const rows = db
        .prepare(`SELECT id, session_number, device_id, status, started_at, closed_at FROM ${table} WHERE session_number = ? ORDER BY started_at, id`)
        .all(d.session_number);
      line(`        session_number ${d.session_number}  (shown to operators as ${code}-${String(d.session_number).padStart(6, "0")})  x${d.n}`);
      for (const r of rows) {
        line(`          id=${r.id}  device=${r.device_id}  status=${r.status}  started=${r.started_at}  closed=${r.closed_at ?? "-"}`);
      }
    }
  }

  // ─── 5. Verdict ────────────────────────────────────────────────────────────
  line("");
  line("5. VERDICT");
  if (totalDuplicateValues > 0) {
    line("   BLOCKED — duplicates found.");
    line("   Migration 061 would fail at startup and the ERP would not open.");
    line("   Nothing has been changed by this script. Send the affected rows above for a decision.");
    line("   Do not renumber, merge or delete any session: these numbers are shown to operators");
    line("   and raw_material_issue_sessions.id is referenced by machine_program_issue_batches.");
  } else if (verdictBlocking) {
    line("   BLOCKED — see the integrity or consistency problem reported above.");
  } else if (alreadyApplied) {
    line("   ALREADY APPLIED and clean. No action needed for 061.");
  } else {
    line("   CLEAR — no duplicates. Migration 061 is expected to apply cleanly.");
    line("   This authorises the migration only. Deployment still needs a verified");
    line("   pre-migration backup and explicit approval (docs/26 section 4).");
  }
} finally {
  db.close();
}

// ─── 6. Prove the copy was not modified ──────────────────────────────────────
const hashAfter = sha256(resolved);
const statAfter = fs.statSync(resolved);
line("");
line("6. THE COPY WAS NOT MODIFIED");
line(`   sha256 before : ${hashBefore}`);
line(`   sha256 after  : ${hashAfter}`);
line(`   unchanged     : ${hashBefore === hashAfter ? "YES" : "NO  <-- investigate immediately"}`);
line(`   size unchanged: ${statBefore.size === statAfter.size ? "YES" : "NO"}`);
line("");
line("   Opening a WAL database read-only can create empty -wal / -shm side files next to it.");
line("   They contain no data. The main file's hash above is what matters.");
line("");
line("====================================================================\n");

process.exit(verdictBlocking ? 1 : 0);
