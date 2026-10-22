// Release gate: prove the BUILT ARTIFACTS are complete and internally consistent.
//
// The companion to verify-signatures.mjs, and deliberately separate from it. That one answers
// "is this signed"; this one answers "is this a whole installer that matches its own update
// feed". An unsigned build can pass this one -- that is the point, because there is no
// certificate yet and the build still has to be provably complete.
//
// WHY THIS EXISTS. On 2026-10-23 a failed NSIS build left a 0.15 MB installer behind: the
// throwaway from electron-builder's uninstaller pass, not a real installer. A zero exit code did
// not catch it, and neither would "the file exists". Separately, the 0.3.3 release went out with
// its .blockmap attached to a DIFFERENT GitHub release, so every update was a full 101 MB
// download and nothing noticed for a day.
//
// HOW IT IDENTIFIES THE INSTALLER, and why not by globbing. latest.yml is the update feed -- it
// is the file every computer reads to decide what to download -- so it is the authority on which
// artifact is the release. The installer is found by matching the SIZE latest.yml declares and
// then verifying its SHA-512, rather than by picking the only .exe in the folder. That works in
// CI, where the directory is fresh, and on a developer machine, where release/ accumulates every
// installer ever built.
//
// NAMES DIFFER ON PURPOSE. On disk the installer is "777 ERP Setup 0.3.5.exe"; latest.yml calls
// it "777-ERP-Setup-0.3.5.exe", because electron-builder replaces spaces for the upload. Both
// are correct and the gate must not confuse them -- anything uploading assets has to use the
// name latest.yml declares, or electron-updater will not find it.
//
// IT FAILS CLOSED. Anything it cannot positively confirm -- including its own inability to read
// latest.yml -- is a failure. It reads only; it never writes, signs, uploads or modifies.
//
// USAGE
//   node ./scripts/verify-artifacts.mjs [releaseDir]
//
// EXIT CODES
//   0  the installer is complete, and latest.yml describes it byte for byte
//   1  it does not, or the check could not be completed

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = path.resolve(process.argv[2] ?? path.join(desktopRoot, "release"));

// A complete installer is ~100 MB. The failed build produced 0.15 MB. The floor is generous so
// an ordinary size change never trips it, while sitting far above anything the uninstaller pass
// can emit -- it is a stub detector, not a size budget.
const MINIMUM_BYTES = 50 * 1024 * 1024;

const problems = [];
const fail = (message) => problems.push(message);

/** GitHub Actions surfaces these in the run UI; locally they are just prefixed lines. */
const annotate = (message) => {
  if (process.env.GITHUB_ACTIONS === "true") console.log(`::error::${message}`);
};

const finish = () => {
  console.log("");
  if (problems.length > 0) {
    console.log(`FAILED — ${String(problems.length)} problem${problems.length === 1 ? "" : "s"}:`);
    for (const problem of problems) {
      console.log(`  * ${problem}`);
      annotate(problem);
    }
    console.log("");
    console.log("Nothing here is distributable. Do not publish these artifacts.");
    process.exit(1);
  }
  console.log("PASSED — the installer is complete and latest.yml describes it byte for byte.");
  console.log("This says NOTHING about signatures: run verify:signatures for that, and note that");
  console.log("an unsigned build cannot establish Smart App Control compatibility.");
  process.exit(0);
};

// ─── the release directory ───────────────────────────────────────────────────

if (!fs.existsSync(releaseDir)) {
  fail(`no release directory at ${releaseDir} — packaging produced nothing`);
  finish();
}
console.log(`release directory : ${releaseDir}`);

// ─── latest.yml, the authority on what the release is ────────────────────────

const latestYmlPath = path.join(releaseDir, "latest.yml");
if (!fs.existsSync(latestYmlPath)) {
  fail("latest.yml is missing — without it no computer can see this version, whatever else was built");
  finish();
}

const yaml = fs.readFileSync(latestYmlPath, "utf-8");

// latest.yml is written by electron-builder and is flat. There is no YAML parser available
// without adding a dependency for one file, so it is read with anchored regexes -- and if the
// shape is not what is expected, that is a failure rather than something to guess around.
const readOne = (field, pattern) => {
  const matches = [...yaml.matchAll(pattern)];
  if (matches.length === 0) {
    fail(`latest.yml declares no ${field} — cannot confirm it describes the built installer`);
    return null;
  }
  const values = new Set(matches.map((match) => match[1]));
  if (values.size > 1) {
    fail(`latest.yml declares conflicting ${field} values: ${[...values].join(", ")}`);
    return null;
  }
  return { value: matches[0][1], occurrences: matches.length };
};

const declaredVersion = readOne("version", /^\s*version:\s*'?"?([^\s'"]+)'?"?\s*$/gm);
const declaredSha512 = readOne("sha512", /^\s*sha512:\s*(\S+)\s*$/gm);
const declaredSize = readOne("size", /^\s*size:\s*(\d+)\s*$/gm);
const declaredPath = readOne("path", /^\s*path:\s*'?"?([^\s'"]+)'?"?\s*$/gm);

if (declaredSha512 === null || declaredSize === null) finish();

const expectedBytes = Number(declaredSize.value);

// ─── it must describe the version that was actually built ────────────────────

const manifest = JSON.parse(fs.readFileSync(path.join(desktopRoot, "package.json"), "utf-8"));
const builtVersion = String(manifest.version ?? "");
if (declaredVersion !== null && declaredVersion.value !== builtVersion) {
  fail(
    `latest.yml is for version ${declaredVersion.value} but this workspace is at ${builtVersion} — ` +
      `these are stale artifacts from an earlier build, not this one`
  );
}

// ─── find the installer latest.yml is talking about ──────────────────────────

const executables = fs
  .readdirSync(releaseDir)
  .filter((name) => name.toLowerCase().endsWith(".exe") && !name.includes("__uninstaller"))
  .map((name) => ({ name, full: path.join(releaseDir, name), size: fs.statSync(path.join(releaseDir, name)).size }));

const matchingSize = executables.filter((candidate) => candidate.size === expectedBytes);

if (matchingSize.length !== 1) {
  fail(
    `no single installer matches the ${String(expectedBytes)} bytes latest.yml declares ` +
      `(${String(matchingSize.length)} candidates). Found: ` +
      (executables.length === 0
        ? "no .exe at all"
        : executables.map((candidate) => `${candidate.name} = ${String(candidate.size)}`).join(", "))
  );
  finish();
}

const installer = matchingSize[0];
console.log(`installer         : ${installer.name}`);
console.log(`size              : ${(installer.size / (1024 * 1024)).toFixed(2)} MB`);
console.log(`version           : ${builtVersion}${declaredVersion?.value === builtVersion ? " (latest.yml agrees)" : ""}`);

// ─── not the uninstaller-pass stub ───────────────────────────────────────────

if (installer.size < MINIMUM_BYTES) {
  fail(
    `the installer is ${(installer.size / (1024 * 1024)).toFixed(2)} MB, below the ` +
      `${String(MINIMUM_BYTES / (1024 * 1024))} MB floor — this is the uninstaller-pass stub, not a complete installer`
  );
}

// ─── the hash, computed rather than trusted ──────────────────────────────────

const digest = crypto.createHash("sha512").update(fs.readFileSync(installer.full)).digest("base64");
if (digest !== declaredSha512.value) {
  fail(`latest.yml sha512 does not match the installer. declared=${declaredSha512.value} actual=${digest}`);
} else {
  console.log(`sha512            : matches latest.yml (${String(declaredSha512.occurrences)} declaration(s))`);
}

// ─── the blockmap, beside the installer ──────────────────────────────────────
//
// Not fatal to installing, but it is what makes an update differential, and it silently went
// missing from the 0.3.3 release. Treated as a failure so it cannot go unnoticed again.

const blockmap = `${installer.full}.blockmap`;
if (!fs.existsSync(blockmap)) {
  fail(`no .blockmap beside ${installer.name} — every update would be a full download`);
} else {
  console.log(`blockmap          : present`);
}

// ─── the application itself ──────────────────────────────────────────────────

const unpackedDir = path.join(releaseDir, "win-unpacked");
if (!fs.existsSync(unpackedDir)) {
  fail("win-unpacked is missing — the application was never packaged");
} else {
  // productName from electron-builder.yml, so the expected name is not duplicated here.
  const builderConfig = fs.readFileSync(path.join(desktopRoot, "electron-builder.yml"), "utf-8");
  const productName = /^productName:\s*(.+)$/m.exec(builderConfig)?.[1]?.trim();
  const appExe = productName ? path.join(unpackedDir, `${productName}.exe`) : null;

  if (appExe !== null && fs.existsSync(appExe)) {
    console.log(`application       : win-unpacked/${productName}.exe`);
  } else {
    const found = fs.readdirSync(unpackedDir).filter((name) => name.toLowerCase().endsWith(".exe"));
    fail(
      `win-unpacked does not contain ${productName ? `${productName}.exe` : "the application executable"}` +
        (found.length > 0 ? ` (found: ${found.join(", ")})` : " (no .exe at all)")
    );
  }
}

// ─── what an uploader must use ───────────────────────────────────────────────
//
// Printed because the names differ: whatever uploads these assets has to name them as
// latest.yml declares, or electron-updater will ask GitHub for a file that is not there.

if (declaredPath !== null) {
  console.log("");
  console.log("asset names the update feed expects:");
  console.log(`  ${declaredPath.value}            <- ${installer.name}`);
  console.log(`  ${declaredPath.value}.blockmap   <- ${path.basename(blockmap)}`);
  console.log("  latest.yml");
  if (declaredPath.value === installer.name) {
    console.log("  (the on-disk name already matches)");
  }
}

finish();
