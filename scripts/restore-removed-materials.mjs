// ONE-TIME REPAIR A: RESTORE THE SIX MATERIALS REMOVED ON PC2 ON 4 NOV 2026.
//
// THE RELEASE GOES ON PC2 AND PC3 FIRST, BOTH CONFIRMED RUNNING IT, AND ONLY THEN THIS. This tool can
// see PC2's migration 102 and refuses without it, but it cannot see PC3, and revision 3 has never been
// tested against 0.4.5. Nothing here stops you running it early: that check is yours.
//
// RUN THIS ONLY ON A COPY. 777 ERP closed on PC2, the release with migration 102 already started on
// it once, its database copied out of the data folder first.
//
//   npm run build
//   node scripts/restore-removed-materials.mjs --db "<copy of PC2's erp.local.sqlite>" --device <PC2 device id>
//       Says what it would do, or why it refuses. Writes nothing.
//   node scripts/restore-removed-materials.mjs --db "<copy>" --out "<new file>" --device <PC2 device id> --apply
//       Copies it to --out (SQLite's own backup, page for page), restores there, and checks the result.
//
// It never writes the copy it is given; the input is hashed before and after. What it restores is in
// scripts/repair-a-records.json, read from production's log. Why, and what does not come back, is at
// the top of packages/sync/src/restoreRemovedMaterials.ts.
//
// The output is safe to swap into PC2's data folder ONLY when every check passes. If anything is
// refused or fails, the output is removed or renamed *.FAILED, so it cannot be swapped in by mistake.
// A second run on a repaired database is refused: every material is already there.
//
// The rehearsal and the real run are the same command. The real run uses a fresh copy, taken with the
// app closed, because PC2 keeps working until then.

import { backup, DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  RestoreRefused,
  applyRestore,
  readRestoreRecords,
  rehearseSending,
  restoreRefusals,
  tableCounts,
  verifyRestore,
} from "../packages/sync/dist/restoreRemovedMaterials.js";

const RECORDS_FILE = path.resolve(import.meta.dirname, "repair-a-records.json");

const line = (text = "") => console.log(text);
const fail = (message) => {
  console.error(`\n${message}\n`);
  process.exit(2);
};
const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function readArguments() {
  const { values } = parseArgs({
    options: {
      db: { type: "string" },
      out: { type: "string" },
      device: { type: "string" },
      apply: { type: "boolean", default: false },
    },
  });
  const usage = "Usage: node scripts/restore-removed-materials.mjs --db <copy> --device <id> [--out <new file> --apply]";
  if (!values.db || !values.device) fail(usage);
  if (values.apply && !values.out) fail(usage);
  return {
    db: path.resolve(values.db),
    out: values.out ? path.resolve(values.out) : null,
    device: values.device.trim(),
    apply: values.apply,
  };
}

/** Never a live data folder, never the incident originals, never over an existing file. */
function refuseUnsafePaths({ db, out }) {
  const protectedRoots = [
    path.join(process.env.LOCALAPPDATA ?? "", "777-erp"),
    path.join(process.env.APPDATA ?? "", "777-erp"),
    path.resolve(import.meta.dirname, "..", "MESSEDUPDB"),
  ].filter((root) => root.length > "777-erp".length);
  for (const file of [db, out].filter(Boolean)) {
    const inside = protectedRoots.find((root) => file.toLowerCase().startsWith(path.resolve(root).toLowerCase() + path.sep));
    if (inside) fail(`REFUSING: ${file} is inside ${inside}. Copy the file somewhere else and point this script at the copy.`);
  }
  if (!fs.existsSync(db)) fail(`Not found: ${db}`);
  if (fs.existsSync(`${db}-wal`) && fs.statSync(`${db}-wal`).size > 0) {
    fail(`${db} has a non-empty -wal file: the app was running or did not close cleanly. Close it and copy again.`);
  }
  if (out && fs.existsSync(out)) fail(`REFUSING: ${out} already exists. Give a new file name.`);
}

function readRecords() {
  try {
    return readRestoreRecords(JSON.parse(fs.readFileSync(RECORDS_FILE, "utf8")));
  } catch (error) {
    if (error instanceof RestoreRefused) fail(error.message);
    throw error;
  }
}

function printPlan(records) {
  const total = records.materials.reduce((sum, material) => sum + material.expectedBalance, 0);
  line("PLAN");
  for (const material of records.materials) {
    const name = material.revision.body.row.display_name;
    line(`   ${material.itemCode}  ${String(material.expectedBalance).padStart(4)} units  ${material.movements.length} movement(s)  ${name}`);
  }
  line(`   Total ${total} units. Stock correction requests do not come back: they are not in the log.\n`);
}

/** The app's own builders, run on a throwaway copy of the output. */
async function rehearseOnThrowaway(output, records, nowIso, out) {
  const throwaway = `${out}.sending-check`;
  await backup(output, throwaway);
  const db = new DatabaseSync(throwaway);
  try {
    return rehearseSending(db, records, nowIso);
  } finally {
    db.close();
    fs.rmSync(throwaway, { force: true });
  }
}

async function restoreInto(args, records) {
  const input = new DatabaseSync(args.db, { readOnly: true });
  await backup(input, args.out);
  input.close();
  const output = new DatabaseSync(args.out);
  const nowIso = new Date().toISOString();
  try {
    const before = tableCounts(output);
    applyRestore(output, records, args.device, nowIso);
    const checks = verifyRestore(output, before, records);
    checks.push(await rehearseOnThrowaway(output, records, nowIso, args.out));
    return { nowIso, checks };
  } finally {
    output.close();
  }
}

function discardOutput(out, message) {
  fs.renameSync(out, `${out}.FAILED`);
  fail(`${message} The output was renamed ${out}.FAILED and must not be used.`);
}

async function main() {
  const args = readArguments();
  refuseUnsafePaths(args);
  const records = readRecords();
  const hashBefore = sha256(args.db);
  line(`\nInput    ${args.db}\n         sha256 ${hashBefore}`);
  line(`Records  ${RECORDS_FILE}\n         sha256 ${sha256(RECORDS_FILE)}`);
  line(`Device   ${args.device}\n`);
  printPlan(records);

  const reader = new DatabaseSync(args.db, { readOnly: true });
  const reasons = restoreRefusals(reader, records, args.device);
  reader.close();
  if (reasons.length > 0) fail(new RestoreRefused(reasons).message);
  if (!args.apply) {
    line("Nothing here stops this repair. Nothing was written. Run again with --out and --apply.");
    line("First confirm PC3 runs the release too: this tool cannot see PC3.\n");
    return;
  }

  let result;
  try {
    result = await restoreInto(args, records);
  } catch (error) {
    discardOutput(args.out, `The repair stopped: ${error instanceof Error ? error.message : String(error)}.`);
  }
  line("CHECKS");
  for (const check of result.checks) line(`   ${check.ok ? "PASS" : "FAIL"}  ${check.name}: ${check.detail}`);
  const hashAfter = sha256(args.db);
  const inputUntouched = hashAfter === hashBefore;
  line(`   ${inputUntouched ? "PASS" : "FAIL"}  Input untouched: sha256 before and after ${inputUntouched ? "identical" : "DIFFER"}`);

  const passed = inputUntouched && result.checks.every((check) => check.ok);
  const report = { ranAt: result.nowIso, args, hashBefore, hashAfter, outputSha256: sha256(args.out), passed, checks: result.checks };
  fs.writeFileSync(`${args.out}.report.json`, JSON.stringify(report, null, 2));
  if (!passed) discardOutput(args.out, `A check failed. Report: ${args.out}.report.json.`);
  line(`\nALL CHECKS PASSED. Output sha256 ${report.outputSha256}`);
  line(`Report: ${args.out}.report.json\n`);
}

await main();
