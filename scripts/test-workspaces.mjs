// Run EVERY workspace's test suite, after the build, and report each one's real result.
//
// WHY THIS EXISTS (v0.5.2 test build, run 42895833651). The root `npm test` chains the six suites
// with `&&`, and CI ran it BEFORE `npm run build`. On a fresh checkout dist/ does not exist, so:
//
//   * the five node:test suites (`node --test dist/**/*.test.js`) found no files and passed with
//     ZERO tests -- the 970 data and 465 sync tests never ran, and nothing said so;
//   * the desktop suite could not load 105 of its 137 files: its tests import @erp/domain, data
//     and sync through their built dist/index.js.
//
// So this runs after the build, runs every suite even when an earlier one fails (no `&&`), and
// counts the tests each one ran. A suite that ran none is a FAILURE, not a pass: it means the
// tests were not found, which is exactly how the missing build hid itself.
//
// It reads and runs tests only; it builds, writes and publishes nothing (except the job summary
// when GITHUB_STEP_SUMMARY is set). Exit 0 only when every suite ran tests and none failed.
//
// USAGE (after `npm run build`)
//   node ./scripts/test-workspaces.mjs

import { spawn } from "node:child_process";
import fs from "node:fs";

/** Same order as the root build and test scripts: each depends only on those before it. */
const WORKSPACES = ["@erp/domain", "@erp/application", "@erp/scanner", "@erp/data", "@erp/sync", "@erp/desktop"];

/** The end of a run's output is all the counting needs; the rest streams straight through. */
const TAIL_BYTES = 64 * 1024;

const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");

/** Runs one workspace's `test` script, echoing its output, and resolves with its exit code and output tail. */
function runSuite(workspace) {
  return new Promise((resolve) => {
    const child = spawn(`npm run --workspace ${workspace} test`, { shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let tail = "";
    const keep = (chunk, stream) => {
      stream.write(chunk);
      tail = (tail + chunk.toString("utf8")).slice(-TAIL_BYTES);
    };
    child.stdout.on("data", (chunk) => keep(chunk, process.stdout));
    child.stderr.on("data", (chunk) => keep(chunk, process.stderr));
    child.on("close", (code) => resolve({ code: code ?? 1, tail: stripAnsi(tail) }));
  });
}

/** node:test prints `ℹ tests N` (spec reporter) or `# tests N` (TAP); vitest prints `Tests  ... (N)`. */
function countTests(tail) {
  const nodeTotal = [...tail.matchAll(/^(?:ℹ|#) tests (\d+)/gm)].pop();
  const nodeFailed = [...tail.matchAll(/^(?:ℹ|#) fail (\d+)/gm)].pop();
  if (nodeTotal) return { total: Number(nodeTotal[1]), failed: Number(nodeFailed?.[1] ?? 0) };
  const vitest = [...tail.matchAll(/^\s*Tests\s+(.*)\((\d+)\)\s*$/gm)].pop();
  if (vitest) {
    // A test file that cannot even load fails without failing any test, so it is counted separately.
    const files = [...tail.matchAll(/^\s*Test Files\s+(.*)\((\d+)\)\s*$/gm)].pop();
    const filesFailed = Number(/(\d+) failed/.exec(files?.[1] ?? "")?.[1] ?? 0);
    return { total: Number(vitest[2]), failed: Number(/(\d+) failed/.exec(vitest[1])?.[1] ?? 0), filesFailed };
  }
  return null;
}

/** One suite's verdict, in words. Zero tests and an unreadable count are failures. */
function verdict({ code, tail }) {
  const counts = countTests(tail);
  if (counts === null) return { ok: false, text: `no test count found (exit ${code})`, counts };
  if (counts.total === 0) return { ok: false, text: "ran ZERO tests -- were they built?", counts };
  if (counts.filesFailed > 0) return { ok: false, text: `${counts.filesFailed} test file(s) failed, ${counts.failed} test(s) failed (exit ${code})`, counts };
  if (code !== 0 || counts.failed > 0) return { ok: false, text: `${counts.failed} failed (exit ${code})`, counts };
  return { ok: true, text: "passed", counts };
}

const rows = [];
for (const workspace of WORKSPACES) {
  console.log(`\n=== ${workspace} ===`);
  const result = verdict(await runSuite(workspace));
  rows.push({ workspace, ...result });
}

const lines = [
  "| Workspace | Tests | Failed | Result |",
  "| --- | --- | --- | --- |",
  ...rows.map((r) => `| ${r.workspace} | ${r.counts?.total ?? "?"} | ${r.counts?.failed ?? "?"} | ${r.ok ? "passed" : `**FAILED**: ${r.text}`} |`),
];
console.log(`\n${lines.join("\n")}`);
if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Test suites, per workspace\n\n${lines.join("\n")}\n\n`);
}

const failed = rows.filter((r) => !r.ok);
if (failed.length > 0) {
  console.error(`\nTESTS FAILED in ${failed.map((r) => r.workspace).join(", ")}.`);
  process.exit(1);
}
console.log("\nEvery workspace ran its tests and all passed.");
