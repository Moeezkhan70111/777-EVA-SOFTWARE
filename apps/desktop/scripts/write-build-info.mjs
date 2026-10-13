// Records WHICH code this build is, into dist/build-info.json.
//
// The problem it solves: apps/desktop/package.json sat at 0.2.0 while the database schema moved
// from 069 to 076, and nothing in the executable said which commit it came from. So a factory
// machine could not be tied back to a revision, and two 0.2.0 installers built weeks apart were
// indistinguishable. Worse, electron-builder copies `migrations/sqlite` from the WORKING TREE, so
// a build made from a dirty tree can ship a migration that exists in no commit.
//
//   node ./scripts/write-build-info.mjs            development: records what it finds
//   node ./scripts/write-build-info.mjs --strict   release: REFUSES a dirty or unidentifiable tree
//
// Nothing secret is recorded: a version, a commit hash, a flag, a timestamp and a number.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, "..");
const repoRoot = path.resolve(desktopRoot, "../..");
const strict = process.argv.includes("--strict");

const git = (args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf-8" }).trim();

/** The commit, and whether the tree had uncommitted changes when this ran. */
function revision() {
  try {
    const commit = git(["rev-parse", "HEAD"]);
    // --porcelain lists tracked modifications AND untracked files, which is what matters here:
    // an untracked migration would still be copied into the installer.
    const dirty = git(["status", "--porcelain"]).length > 0;
    return { commit, shortCommit: commit.slice(0, 12), dirty };
  } catch {
    return { commit: null, shortCommit: null, dirty: null };
  }
}

/** The highest migration number this build will ship, read from the files themselves. */
function migrationCeiling() {
  const dir = path.join(repoRoot, "migrations", "sqlite");
  if (!fs.existsSync(dir)) return 0;
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".up.sql"))
    .reduce((highest, file) => Math.max(highest, Number(/^(\d+)/.exec(file)?.[1] ?? 0)), 0);
}

const { version } = JSON.parse(fs.readFileSync(path.join(desktopRoot, "package.json"), "utf-8"));
const { commit, shortCommit, dirty } = revision();
const buildInfo = {
  version,
  commit,
  shortCommit,
  dirty,
  builtAt: new Date().toISOString(),
  migrationCeiling: migrationCeiling(),
};

if (strict) {
  const refusals = [];
  if (!commit) refusals.push("the source revision could not be determined (is this a git checkout?)");
  if (dirty) refusals.push("the source tree has uncommitted or untracked changes");
  if (refusals.length > 0) {
    console.error("\nRefusing to build a release that cannot be identified:\n");
    for (const reason of refusals) console.error(`  - ${reason}`);
    console.error(
      [
        "",
        "A release must be reproducible from a commit. Commit or set aside the changes, then build",
        "again. Note that electron-builder copies migrations/sqlite from the working tree, so a",
        "dirty build can ship a migration that exists in no commit.",
        "",
      ].join("\n")
    );
    process.exit(1);
  }
}

// Beside the compiled module that reads it: src/main/buildInfo.ts becomes dist/main/buildInfo.js,
// and electron-builder includes dist/**/* in the asar.
const outDir = path.join(desktopRoot, "dist", "main");
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, "build-info.json");
fs.writeFileSync(outFile, `${JSON.stringify(buildInfo, null, 2)}\n`, "utf-8");

const shown = `${buildInfo.version} ${buildInfo.shortCommit ?? "(unknown revision)"}${buildInfo.dirty ? " DIRTY" : ""} migrations<=${buildInfo.migrationCeiling}`;
console.log(`Build info: ${shown}`);
if (buildInfo.dirty) console.log("  WARNING: built from a dirty tree — not reproducible from a commit.");
