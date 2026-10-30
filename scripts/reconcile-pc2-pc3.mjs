// ONE-TIME PC2 -> PC3 STORE RECONCILIATION (docs/39-pc2-pc3-reconciliation-plan.md)
//
// RUN THIS ONLY ON COPIES. Both apps closed, both files copied out of their data folders first.
//
//   npm run --workspace @erp/data build
//   node scripts/reconcile-pc2-pc3.mjs --pc2 "<copy of PC2's erp.local.sqlite>" --pc3 "<copy of PC3's>" --out "<new file>" --actor "<your name>"
//
// It never writes either input. It copies PC3's file to --out (SQLite's own backup, page for page),
// opens PC2's read-only, and writes the reconciliation into --out in one transaction. Then it checks
// the result and writes a report beside it. Both inputs are hashed before and after to prove they
// were not touched.
//
// The result is safe to swap in ONLY when every check passes. If anything is refused or fails, the
// output is removed or renamed *.FAILED, so it cannot be swapped in by mistake.
//
// The dry run and the real run are the same command. The real run uses a fresh copy of PC3's file,
// taken at swap time with PC3 closed, because PC3 keeps working until then.

import { backup, DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { planReconciliation } from "../packages/data/dist/database/storeReconciliation/plan.js";
import { applyReconciliation } from "../packages/data/dist/database/storeReconciliation/apply.js";
import { verifyReconciliation } from "../packages/data/dist/database/storeReconciliation/verify.js";
import { ReconciliationRefused } from "../packages/data/dist/database/storeReconciliation/shared.js";

// ─── The owner's decisions, as reviewed (docs/39) ────────────────────────────
const DECISIONS = {
  schemaVersion: "087_numbered_tables_origin_device",
  sourceDeviceId: "47c0dace-fe68-42cb-989c-e94f69c62c0f", // PC2, retired
  targetDeviceId: "e323f9ab-8540-4b97-9c5b-74d9dd9b83ae", // PC3, continues
  receivingSessions: [185], // RMI-000185: 50 packets from shehzad rubber topping
  issueSessions: [139], // RMO-000139: its 29 store-outs of packets only PC2 knows
  emptyIssueSessions: [138], // RMO-000138: opened and closed with no scans
  staleReceivingSessions: [184], // RMI-000184: still open on PC3, closed on PC2
  staleIssueSessions: [137], // RMO-000137: still open on PC3, closed on PC2
  recipient: {
    recorded: "da416c09-c324-4255-b77e-78eb297a22a3", // PTY-000019 ASIM SHEHZAD (BHATI), chosen by mistake
    actual: "6bde055a-2b55-4abe-9f2d-e050ba0a37ac", // PTY-000008 Daniyal, confirmed by the storekeeper
  },
  ignoredTables: ["user_sessions"], // login sessions, not business records
  expected: {
    materials: 7, materialValues: 21, materialAudits: 7, runs: 14, packets: 50, storeIns: 50, storeOuts: 29,
    duplicateStoreOuts: 38, receives: 50, transfersOut: 29, staleSessions: 2,
  },
};

const line = (text = "") => console.log(text);
const fail = (message) => {
  console.error(`\n${message}\n`);
  process.exit(2);
};
const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function readArguments() {
  const { values } = parseArgs({ options: { pc2: { type: "string" }, pc3: { type: "string" }, out: { type: "string" }, actor: { type: "string" } } });
  if (!values.pc2 || !values.pc3 || !values.out || !values.actor) fail('Usage: node scripts/reconcile-pc2-pc3.mjs --pc2 <file> --pc3 <file> --out <new file> --actor "<name>"');
  return { pc2: path.resolve(values.pc2), pc3: path.resolve(values.pc3), out: path.resolve(values.out), actor: values.actor };
}

/** Never a live data folder, never the incident originals, never over an existing file. */
function refuseUnsafePaths({ pc2, pc3, out }) {
  const protectedRoots = [
    path.join(process.env.LOCALAPPDATA ?? "", "777-erp"),
    path.join(process.env.APPDATA ?? "", "777-erp"),
    path.resolve(import.meta.dirname, "..", "MESSEDUPDB"),
  ].filter((root) => root.length > "777-erp".length);
  for (const file of [pc2, pc3, out]) {
    const inside = protectedRoots.find((root) => file.toLowerCase().startsWith(path.resolve(root).toLowerCase() + path.sep));
    if (inside) fail(`REFUSING: ${file} is inside ${inside}. Copy the file somewhere else and point this script at the copy.`);
  }
  for (const file of [pc2, pc3]) if (!fs.existsSync(file)) fail(`Not found: ${file}`);
  for (const file of [pc2, pc3]) if (fs.existsSync(`${file}-wal`) && fs.statSync(`${file}-wal`).size > 0) fail(`${file} has a non-empty -wal file: the app was not closed when it was copied.`);
  if (fs.existsSync(out)) fail(`REFUSING: ${out} already exists. Give a new file name.`);
}

function printSummary(summary) {
  line("MATERIALS (new codes on PC3)");
  for (const m of summary.materials) line(`   ${m.oldCode} -> ${m.newCode}   ${m.name}`);
  line("SESSIONS");
  for (const s of summary.sessions) line(`   ${s.kind === "STORE_IN" ? "RMI" : "RMO"}-${String(s.oldNumber).padStart(6, "0")} -> ${String(s.newNumber).padStart(6, "0")}   ${s.scans} scans`);
  line("STALE SESSIONS CLOSED ON PC3");
  for (const s of summary.staleCloses) line(`   ${s.table} ${s.number}, closed at ${s.closedAt}`);
  line("SERIAL COUNTERS");
  for (const c of summary.counters) line(`   ${c.kind.padEnd(5)} ${c.party} x ${c.material}: ${c.from ?? "none"} -> ${c.to}`);
  line("STOCK BALANCES");
  for (const b of summary.balances) line(`   ${b.material}: ${b.from ?? "none"} -> ${b.to}`);
  line(`COUNTS ${JSON.stringify(summary.counts)}`);
}

async function main() {
  const args = readArguments();
  refuseUnsafePaths(args);
  const hashesBefore = { pc2: sha256(args.pc2), pc3: sha256(args.pc3) };
  line(`\nPC2 copy  ${args.pc2}\n          sha256 ${hashesBefore.pc2}`);
  line(`PC3 copy  ${args.pc3}\n          sha256 ${hashesBefore.pc3}`);
  line(`Output    ${args.out}\n`);

  const pc3Input = new DatabaseSync(args.pc3, { readOnly: true });
  await backup(pc3Input, args.out);
  pc3Input.close();
  const source = new DatabaseSync(args.pc2, { readOnly: true });
  const target = new DatabaseSync(args.out);
  const run = { reconciliationId: randomUUID(), nowIso: new Date().toISOString(), actor: args.actor };

  let plan;
  try {
    plan = planReconciliation(source, target, DECISIONS, run);
  } catch (error) {
    target.close();
    fs.rmSync(args.out, { force: true });
    if (error instanceof ReconciliationRefused) fail(error.message);
    throw error;
  }
  printSummary(plan.summary);
  line(`LEFT BEHIND ${plan.left.length} row(s): ${[...new Set(plan.left.map((l) => l.why))].join("; ")}\n`);

  applyReconciliation(target, plan);
  const checks = verifyReconciliation(source, target, plan);
  source.close();
  target.close();

  line("CHECKS");
  for (const c of checks) line(`   ${c.ok ? "PASS" : "FAIL"}  ${c.name}: ${c.detail}`);
  const hashesAfter = { pc2: sha256(args.pc2), pc3: sha256(args.pc3) };
  const inputsUntouched = hashesAfter.pc2 === hashesBefore.pc2 && hashesAfter.pc3 === hashesBefore.pc3;
  line(`   ${inputsUntouched ? "PASS" : "FAIL"}  Inputs untouched: sha256 before and after ${inputsUntouched ? "identical" : "DIFFER"}`);

  const passed = inputsUntouched && checks.every((c) => c.ok);
  const report = {
    run, args, hashesBefore, hashesAfter, outputSha256: sha256(args.out), passed, summary: plan.summary, checks,
    leftBehind: plan.left.map((l) => ({ table: l.table, id: l.row.id, why: l.why })),
  };
  fs.writeFileSync(`${args.out}.report.json`, JSON.stringify(report, null, 2));
  if (!passed) {
    fs.renameSync(args.out, `${args.out}.FAILED`);
    fail(`A check failed. The output was renamed ${args.out}.FAILED and must not be used. Report: ${args.out}.report.json`);
  }
  line(`\nALL CHECKS PASSED. Output sha256 ${report.outputSha256}`);
  line(`Report: ${args.out}.report.json\n`);
}

await main();
