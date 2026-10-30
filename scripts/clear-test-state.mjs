// ONE-TIME: CLEAR WHAT PC2'S DATABASE REMEMBERS ABOUT THE TEST PROJECT (docs/36 section 10.5)
//
// RUN THIS ONLY ON A COPY. 777 ERP closed on PC2, its database copied out of the data folder first.
//
//   npm run --workspace @erp/data build
//   node scripts/clear-test-state.mjs --db "<copy of PC2's erp.local.sqlite>" --out "<new file>" --device <PC2 device id>
//
// It never writes the copy it is given. It copies it to --out (SQLite's own backup, page for page)
// and makes the changes there, in one transaction: queue rows already sent to test are deleted, the
// legacy pre-082 queue is retired (kept, marked SYNCED with a note), the settings about test's log
// and leases are removed, and the lease cache is emptied. Then it checks the result against the
// input and writes a report beside it. The input is hashed before and after.
//
// The output is safe to swap into PC2's data folder ONLY when every check passes. If anything is
// refused or fails, the output is removed or renamed *.FAILED, so it cannot be swapped in by mistake.
//
// The rehearsal and the real run are the same command. The real run uses a fresh copy, taken with the
// app closed, because PC2 keeps working until then.

import { backup, DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  TestStateClearRefused,
  applyTestStateClear,
  planTestStateClear,
  verifyTestStateClear,
} from "../packages/data/dist/database/testStateClear.js";

const line = (text = "") => console.log(text);
const fail = (message) => {
  console.error(`\n${message}\n`);
  process.exit(2);
};
const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function readArguments() {
  const { values } = parseArgs({ options: { db: { type: "string" }, out: { type: "string" }, device: { type: "string" } } });
  if (!values.db || !values.out || !values.device) fail("Usage: node scripts/clear-test-state.mjs --db <copy> --out <new file> --device <device id>");
  return { db: path.resolve(values.db), out: path.resolve(values.out), device: values.device.trim() };
}

/** Never a live data folder, never the incident originals, never over an existing file. */
function refuseUnsafePaths({ db, out }) {
  const protectedRoots = [
    path.join(process.env.LOCALAPPDATA ?? "", "777-erp"),
    path.join(process.env.APPDATA ?? "", "777-erp"),
    path.resolve(import.meta.dirname, "..", "MESSEDUPDB"),
  ].filter((root) => root.length > "777-erp".length);
  for (const file of [db, out]) {
    const inside = protectedRoots.find((root) => file.toLowerCase().startsWith(path.resolve(root).toLowerCase() + path.sep));
    if (inside) fail(`REFUSING: ${file} is inside ${inside}. Copy the file somewhere else and point this script at the copy.`);
  }
  if (!fs.existsSync(db)) fail(`Not found: ${db}`);
  if (fs.existsSync(`${db}-wal`) && fs.statSync(`${db}-wal`).size > 0) fail(`${db} has a non-empty -wal file: the app was not closed when it was copied.`);
  if (fs.existsSync(out)) fail(`REFUSING: ${out} already exists. Give a new file name.`);
}

async function main() {
  const args = readArguments();
  refuseUnsafePaths(args);
  const hashBefore = sha256(args.db);
  line(`\nInput   ${args.db}\n        sha256 ${hashBefore}`);
  line(`Output  ${args.out}\nDevice  ${args.device}\n`);

  const input = new DatabaseSync(args.db, { readOnly: true });
  await backup(input, args.out);
  const output = new DatabaseSync(args.out);

  let plan;
  try {
    plan = planTestStateClear(output, args.device);
  } catch (error) {
    input.close();
    output.close();
    fs.rmSync(args.out, { force: true });
    if (error instanceof TestStateClearRefused) fail(error.message);
    throw error;
  }
  line("PLAN");
  line(`   queue rows sent to test, deleted:          ${plan.sentToTest}`);
  line(`   legacy queue rows to retire:                ${plan.legacyToRetire} (already retired: ${plan.legacyAlreadyRetired})`);
  line(`   this computer's unsent work, kept:          ${plan.keptUnstamped}`);
  line(`   settings about test, removed:               ${plan.settings.join(", ") || "none"}`);
  line(`   lease cache rows, emptied:                  ${plan.leaseCacheRows}\n`);

  const nowIso = new Date().toISOString();
  applyTestStateClear(output, plan, nowIso);
  const checks = verifyTestStateClear(input, output, plan);
  input.close();
  output.close();

  line("CHECKS");
  for (const c of checks) line(`   ${c.ok ? "PASS" : "FAIL"}  ${c.name}: ${c.detail}`);
  const hashAfter = sha256(args.db);
  const inputUntouched = hashAfter === hashBefore;
  line(`   ${inputUntouched ? "PASS" : "FAIL"}  Input untouched: sha256 before and after ${inputUntouched ? "identical" : "DIFFER"}`);

  const passed = inputUntouched && checks.every((c) => c.ok);
  const report = { ranAt: nowIso, args, hashBefore, hashAfter, outputSha256: sha256(args.out), passed, plan, checks };
  fs.writeFileSync(`${args.out}.report.json`, JSON.stringify(report, null, 2));
  if (!passed) {
    fs.renameSync(args.out, `${args.out}.FAILED`);
    fail(`A check failed. The output was renamed ${args.out}.FAILED and must not be used. Report: ${args.out}.report.json`);
  }
  line(`\nALL CHECKS PASSED. Output sha256 ${report.outputSha256}`);
  line(`Report: ${args.out}.report.json\n`);
}

await main();
