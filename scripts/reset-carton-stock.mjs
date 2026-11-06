// THE CARTON STOCK FRESH START, ONE COMPUTER AT A TIME (docs/42 section 13).
//
// RUN THIS ONLY ON A COPY. 777 ERP closed, its database copied out of the data folder first, on the
// release with migration 103 already started once.
//
//   npm run build
//   node scripts/reset-carton-stock.mjs --db "<copy of erp.local.sqlite>"
//       Says what it would clear, what stays, and what stops it. Writes nothing.
//   node scripts/reset-carton-stock.mjs --db "<copy>" --out "<new file>" --apply
//       Copies it to --out (SQLite's own backup), clears there, and checks the result.
//
// It never writes the copy it is given; the input is hashed before and after. It clears only the store
// figures. Manual Production entries, the contractor ledger, payments, QR identities, scan history and
// gatepasses are not touched, and the checks prove it by hashing every other table.
//
// The output is safe to swap in ONLY when every check passes. If anything is refused or fails, the
// output is removed or renamed *.FAILED, so it cannot be swapped in by mistake.

import { backup, DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { applyCartonStockReset, planCartonStockReset, verifyCartonStockReset } from "../packages/data/dist/database/cartonStockReset.js";

const line = (text = "") => console.log(text);
const fail = (message) => {
  console.error(`\n${message}\n`);
  process.exit(2);
};
const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function readArguments() {
  const { values } = parseArgs({ options: { db: { type: "string" }, out: { type: "string" }, apply: { type: "boolean", default: false } } });
  const usage = "Usage: node scripts/reset-carton-stock.mjs --db <copy> [--out <new file> --apply]";
  if (!values.db) fail(usage);
  if (values.apply && !values.out) fail(usage);
  return { db: path.resolve(values.db), out: values.out ? path.resolve(values.out) : null, apply: values.apply };
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
  if (fs.existsSync(`${db}-wal`) && fs.statSync(`${db}-wal`).size > 0) fail(`${db} has a non-empty -wal file: the app was running or did not close cleanly. Close it and copy again.`);
  if (out && fs.existsSync(out)) fail(`REFUSING: ${out} already exists. Give a new file name.`);
}

function printPlan(plan) {
  line("WOULD CLEAR");
  if (plan.variants.length === 0) line("   nothing: every store figure is already zero");
  for (const variant of plan.variants) line(`   ${variant.label}: ${variant.inStore} carton(s) in store; product total ${variant.variantBefore} -> ${variant.variantAfter}`);
  line(`   Total ${plan.cartonsCleared} carton(s)\n`);
  line("STAYS AS IT IS");
  line(`   Manual Production entries: ${plan.kept.manualEntries}`);
  line(`   QR cartons: ${plan.kept.qrCartons}`);
  line(`   Production events: ${plan.kept.productionEvents}`);
  line(`   Gatepasses: ${plan.kept.gatepasses}\n`);
}

async function main() {
  const args = readArguments();
  refuseUnsafePaths(args);
  const hashBefore = sha256(args.db);
  line(`\nInput   ${args.db}\n        sha256 ${hashBefore}\n`);

  const input = new DatabaseSync(args.db, { readOnly: true });
  const plan = planCartonStockReset(input);
  printPlan(plan);
  if (plan.refusals.length > 0) {
    input.close();
    fail(`REFUSED, nothing changed:\n  - ${plan.refusals.join("\n  - ")}`);
  }
  if (!args.apply) {
    input.close();
    line("Nothing stops this reset. Nothing was written. Run again with --out and --apply.\n");
    return;
  }

  await backup(input, args.out);
  const output = new DatabaseSync(args.out);
  const nowIso = new Date().toISOString();
  let checks;
  try {
    applyCartonStockReset(output, nowIso);
    checks = verifyCartonStockReset(input, output, plan);
  } catch (error) {
    input.close();
    output.close();
    fs.rmSync(args.out, { force: true });
    fail(error instanceof Error ? error.message : String(error));
  }
  input.close();
  output.close();

  line("CHECKS");
  for (const check of checks) line(`   ${check.ok ? "PASS" : "FAIL"}  ${check.name}: ${check.detail}`);
  const hashAfter = sha256(args.db);
  const inputUntouched = hashAfter === hashBefore;
  line(`   ${inputUntouched ? "PASS" : "FAIL"}  Input untouched: sha256 before and after ${inputUntouched ? "identical" : "DIFFER"}`);

  const passed = inputUntouched && checks.every((check) => check.ok);
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
