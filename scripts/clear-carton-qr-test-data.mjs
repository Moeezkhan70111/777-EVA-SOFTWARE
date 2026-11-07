// CLEAR LOCAL CARTON QR TEST DATA FROM A COPY OF A REHEARSAL DATABASE (docs/42 section 15).
//
//   npm run build
//   node scripts/clear-carton-qr-test-data.mjs --db "<copy>"
//       Says exactly what would go, what stays, and what stops it. Writes nothing. Works on any copy.
//   node scripts/clear-carton-qr-test-data.mjs --db "<copy>" --out "<new file>" --apply
//       Copies it to --out (SQLite's own backup), clears there, and checks the result.
//
// It never writes the file it is given; the input is hashed before and after. --apply is refused for any
// database but the two rehearsal devices named in cartonQrCleanup.ts, so PC2 and PC3 cannot be cleared by
// mistake. It opens no network connection. Run it twice: the second run clears nothing.
//
// If anything is refused or fails, the output is removed or renamed *.FAILED.

import { backup, DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { applyCartonQrCleanup, planCartonQrCleanup, verifyCartonQrCleanup } from "../packages/data/dist/database/cartonQrCleanup.js";

const line = (text = "") => console.log(text);
const fail = (message) => {
  console.error(`\n${message}\n`);
  process.exit(2);
};
const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function readArguments() {
  const { values } = parseArgs({ options: { db: { type: "string" }, out: { type: "string" }, apply: { type: "boolean", default: false } } });
  const usage = "Usage: node scripts/clear-carton-qr-test-data.mjs --db <copy> [--out <new file> --apply]";
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
    "C:\\erp-rehearsal-store",
    "C:\\erp-rehearsal-w2",
    "C:\\erp-devtest",
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
  line(`Device  ${plan.deviceId}\n`);
  line("WOULD GO");
  for (const [table, rows] of Object.entries(plan.removes)) line(`   ${String(rows).padStart(7)}  ${table}`);
  line("");
  line(`QR EARNINGS THAT WOULD LEAVE THE CONTRACTOR LEDGER: ${plan.earnings.cartons} cartons, ${plan.earnings.programs} programs, ${plan.earnings.contractors.join(", ") || "no contractors"}`);
  line(`PAYMENTS AND CLAIMS ON THOSE CONTRACTORS: ${plan.payments.length}`);
  for (const payment of plan.payments) line(`   ${payment.kind} ${payment.number} (${payment.id}), ${payment.contractor}, ${payment.amountPaisa} paisa`);
  line("");
  line("STAYS AS IT IS");
  for (const [table, rows] of Object.entries(plan.kept)) line(`   ${String(rows).padStart(7)}  ${table}`);
  line("");
}

async function main() {
  const args = readArguments();
  refuseUnsafePaths(args);
  const hashBefore = sha256(args.db);
  line(`\nInput   ${args.db}\n        sha256 ${hashBefore}`);

  const input = new DatabaseSync(args.db, { readOnly: true });
  const plan = planCartonQrCleanup(input);
  printPlan(plan);
  if (plan.refusals.length > 0) {
    input.close();
    fail(`REFUSED, nothing changed:\n  - ${plan.refusals.join("\n  - ")}`);
  }
  if (!args.apply) {
    input.close();
    line("Nothing was written. Run again with --out and --apply.\n");
    return;
  }

  await backup(input, args.out);
  const output = new DatabaseSync(args.out);
  let checks;
  try {
    applyCartonQrCleanup(output);
    checks = verifyCartonQrCleanup(input, output, plan);
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
  const report = { ranAt: new Date().toISOString(), args, hashBefore, hashAfter, outputSha256: sha256(args.out), passed, plan, checks };
  fs.writeFileSync(`${args.out}.report.json`, JSON.stringify(report, null, 2));
  if (!passed) {
    fs.renameSync(args.out, `${args.out}.FAILED`);
    fail(`A check failed. The output was renamed ${args.out}.FAILED and must not be used. Report: ${args.out}.report.json`);
  }
  line(`\nALL CHECKS PASSED. Output sha256 ${report.outputSha256}`);
  line(`Report: ${args.out}.report.json\n`);
}

await main();
