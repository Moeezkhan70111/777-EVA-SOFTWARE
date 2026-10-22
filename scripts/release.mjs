// ONE COMMAND TO SHIP A NEW VERSION, from the developer PC.
//
//   npm run release              patch: 0.3.1 -> 0.3.2
//   npm run release -- minor     0.3.1 -> 0.4.0
//   npm run release -- major     0.3.1 -> 1.0.0
//   npm run release -- --dry-run rehearse: changes nothing, publishes nothing
//
// WHAT IT DOES, in order. Every step must succeed before the next is attempted.
//
//   1. refuses unless the tree is clean, GH_TOKEN is set, and the version argument is sane
//   2. bumps apps/desktop/package.json
//   3. commits that bump and tags it
//   4. pushes the commit and the tag
//   5. builds every workspace, then the signed-or-unsigned Windows installer
//   6. creates the GitHub release, ONCE -- see the note at step 6 on why that matters
//   7. publishes the installer to GitHub Releases, where the office PCs look for it
//   8. reads the release back and warns if it is not what it should be
//
// WHY THE TREE MUST BE CLEAN FIRST. electron-builder copies `migrations/sqlite` out of the
// WORKING TREE, so a build from a dirty tree can ship a migration that exists in no commit --
// and `write-build-info.mjs --strict` refuses such a build anyway. Checking before the bump
// also means this script can never sweep somebody's unrelated work into a release commit.
//
// WHY IT PUSHES BEFORE PUBLISHING. electron-builder creates the GitHub release through the API.
// If the tag is not on the remote yet, GitHub attaches the release to whatever the default
// branch currently points at -- so the release would claim a commit that is not the one built.
// Pushing first makes the tag the truth.
//
// THE TOKEN IS NEVER WRITTEN ANYWHERE. GH_TOKEN is read from this operator's environment and
// handed to electron-builder as an environment variable. It is not logged, not committed, and
// not baked into the installer -- see the publish block in apps/desktop/electron-builder.yml.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const desktopPackageJson = path.join(repoRoot, "apps", "desktop", "package.json");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const bumpKind = args.find((arg) => !arg.startsWith("--")) ?? "patch";

const BUMPS = new Set(["patch", "minor", "major"]);

/** Stops the release with a reason the operator can act on. Nothing is left half-done. */
function refuse(reason, detail) {
  console.error(`\nRELEASE STOPPED: ${reason}`);
  if (detail) console.error(`\n${detail}`);
  process.exit(1);
}

const run = (command, commandArgs, options = {}) =>
  execFileSync(command, commandArgs, { cwd: repoRoot, encoding: "utf-8", stdio: "pipe", ...options }).trim();

/** Runs a build/publish step with its output on screen, since these take minutes. */
const runVisible = (command, commandArgs, options = {}) =>
  execFileSync(command, commandArgs, { cwd: repoRoot, stdio: "inherit", ...options });

const step = (number, text) => console.log(`\n[${String(number)}/6] ${text}`);

// ─── 1. Preflight ────────────────────────────────────────────────────────────

if (!BUMPS.has(bumpKind)) {
  refuse(
    `"${bumpKind}" is not a version bump.`,
    "Use one of:\n  npm run release\n  npm run release -- minor\n  npm run release -- major"
  );
}

let branch;
let status;
try {
  branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  status = run("git", ["status", "--porcelain"]);
} catch {
  refuse("this is not a git repository, so there is nothing to tag or publish from.");
}

if (status.length > 0) {
  refuse(
    "the working tree has uncommitted changes.",
    `Commit or stash them first — a release must be reproducible from a commit, and\n` +
      `electron-builder copies migrations out of the working tree.\n\n${status}`
  );
}

if (!dryRun && !process.env.GH_TOKEN) {
  refuse(
    "GH_TOKEN is not set, so the installer could not be published.",
    "Set it to a GitHub token with write access to the releases of\n" +
      "Moeezkhan70111/777-EVA-SOFTWARE, in this terminal only:\n\n" +
      "  $env:GH_TOKEN = \"<token>\"      (PowerShell)\n\n" +
      "Nothing has been changed. Rehearse without a token using:\n\n" +
      "  npm run release -- --dry-run"
  );
}

const manifest = JSON.parse(fs.readFileSync(desktopPackageJson, "utf-8"));
const currentVersion = String(manifest.version ?? "");
const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(currentVersion);
if (!parts) {
  refuse(`apps/desktop/package.json has version "${currentVersion}", which is not X.Y.Z.`);
}

const [major, minor, patch] = parts.slice(1).map(Number);
const nextVersion =
  bumpKind === "major"
    ? `${String(major + 1)}.0.0`
    : bumpKind === "minor"
      ? `${String(major)}.${String(minor + 1)}.0`
      : `${String(major)}.${String(minor)}.${String(patch + 1)}`;
const tag = `v${nextVersion}`;

if (run("git", ["tag", "--list", tag]).length > 0) {
  refuse(`the tag ${tag} already exists.`, "That version has been released. Nothing has been changed.");
}

console.log(`777 ERP release${dryRun ? " (DRY RUN — nothing will be changed or published)" : ""}`);
console.log(`  branch        ${branch}`);
console.log(`  version       ${currentVersion} -> ${nextVersion}`);
console.log(`  tag           ${tag}`);
console.log(`  publishing to github.com/Moeezkhan70111/777-EVA-SOFTWARE (private)`);

if (dryRun) {
  step(1, "Preflight passed.");
  console.log("\nDry run complete. The tree is clean, the version is valid and the tag is free.");
  console.log("Nothing was bumped, committed, pushed, built or published.");
  process.exit(0);
}

// ─── 2. Bump ─────────────────────────────────────────────────────────────────

step(2, `Bumping apps/desktop/package.json to ${nextVersion}`);
// Rewritten rather than regenerated, so key order and formatting survive and the release commit
// is a one-line diff somebody can read.
const original = fs.readFileSync(desktopPackageJson, "utf-8");
const bumped = original.replace(`"version": "${currentVersion}"`, `"version": "${nextVersion}"`);
if (bumped === original) {
  refuse(`could not find "version": "${currentVersion}" in apps/desktop/package.json to replace.`);
}
fs.writeFileSync(desktopPackageJson, bumped, "utf-8");

/** Puts the version back when a later step fails, so a stopped release leaves nothing behind. */
const revertBump = () => {
  try {
    fs.writeFileSync(desktopPackageJson, original, "utf-8");
    console.error("The version bump has been undone.");
  } catch {
    console.error(`COULD NOT UNDO the version bump. Set version back to ${currentVersion} in ${desktopPackageJson}.`);
  }
};

// ─── 3. Commit and tag ───────────────────────────────────────────────────────

step(3, `Committing and tagging ${tag}`);
try {
  run("git", ["add", "apps/desktop/package.json"]);
  run("git", ["commit", "-m", `chore(desktop): release ${nextVersion}`]);
  run("git", ["tag", "-a", tag, "-m", `777 ERP ${nextVersion}`]);
} catch (error) {
  revertBump();
  refuse("the release commit could not be created.", String(error));
}

// ─── 4. Push ─────────────────────────────────────────────────────────────────

step(4, `Pushing ${branch} and ${tag}`);
try {
  run("git", ["push", "origin", `${branch}`]);
  run("git", ["push", "origin", tag]);
} catch (error) {
  refuse(
    "the commit and tag could not be pushed, so nothing was published.",
    `The release commit and tag exist locally. Push them yourself and re-run, or remove them:\n\n` +
      `  git tag -d ${tag}\n  git reset --hard HEAD~1\n\n${String(error)}`
  );
}

// ─── 5. Build ────────────────────────────────────────────────────────────────

step(5, "Building every workspace and the Windows installer");
try {
  runVisible("npm", ["run", "build"], { shell: true });
} catch {
  refuse(
    "the build failed, so nothing was published.",
    `The release commit ${tag} is already pushed. Fix the build and release the next patch —\n` +
      `do not rewrite a pushed tag.`
  );
}

// ─── 6. Create the GitHub release, once ──────────────────────────────────────
//
// WHY THIS EXISTS. electron-builder publishes each artifact through its own publisher, and they
// run concurrently. Every release so far produced TWO GitHub releases for one tag, because both
// publishers checked, both saw "release doesn't exist", and both created one. The log said so
// twice and nobody read it twice:
//
//   • creating GitHub release  reason=release doesn't exist tag=v0.3.3
//   • creating GitHub release  reason=release doesn't exist tag=v0.3.3
//
// The artifacts then split across the two. Verified on the published releases:
//
//   id=421101297  v0.3.3  777-ERP-Setup-0.3.3.exe.blockmap
//   id=421101299  v0.3.3  777-ERP-Setup-0.3.3.exe, latest.yml
//
// TWO CONSEQUENCES. The blockmap is orphaned on a release of its own, so electron-updater never
// finds it beside the installer and every update is a full download instead of a delta. Worse,
// which duplicate GitHub calls "latest" decides whether `latest.yml` is reachable at all -- and
// an update check that lands on the blockmap-only release finds no feed and silently does
// nothing. 0.3.2 and 0.3.3 both happened to pick the right one. That is luck, and the whole
// update mechanism was resting on it.
//
// Creating the release here, before electron-builder runs, removes the race: both publishers
// find an existing release and upload into it.

const releaseApi = (() => {
  const yml = fs.readFileSync(path.join(repoRoot, "apps", "desktop", "electron-builder.yml"), "utf8");
  const owner = /^\s*owner:\s*(\S+)\s*$/m.exec(yml)?.[1];
  const repo = /^\s*repo:\s*(\S+)\s*$/m.exec(yml)?.[1];
  if (!owner || !repo) {
    refuse("the publish target could not be read from electron-builder.yml, so nothing was published.");
  }
  return { owner, repo, base: `https://api.github.com/repos/${owner}/${repo}` };
})();

/** GitHub REST, with the token in the header and never in a URL or a log line. */
const github = async (method, pathname, body) => {
  const response = await fetch(`${releaseApi.base}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${process.env.GH_TOKEN}`,
      accept: "application/vnd.github+json",
      "user-agent": "777-erp-release",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, text: await response.text() };
};

step(6, `Creating the GitHub release for ${tag}`);
try {
  const existing = await github("GET", `/releases/tags/${tag}`);
  if (existing.status === 200) {
    console.log(`  a release for ${tag} already exists — electron-builder will upload into it.`);
  } else if (existing.status === 404) {
    const created = await github("POST", "/releases", {
      tag_name: tag,
      name: `777 ERP ${nextVersion}`,
      draft: false,
      prerelease: false,
    });
    if (created.status < 200 || created.status >= 300) {
      // The message is GitHub's and carries no credential; the token only ever goes in a header.
      refuse("the GitHub release could not be created, so nothing was published.", created.text);
    }
    console.log(`  created, and it is the only release for ${tag}.`);
  } else {
    refuse("GitHub would not say whether a release exists, so nothing was published.", existing.text);
  }
} catch (error) {
  refuse("the GitHub release could not be created, so nothing was published.", String(error));
}

// ─── 7. Publish ──────────────────────────────────────────────────────────────

step(7, "Publishing the installer to GitHub Releases");
try {
  runVisible(
    "npx",
    ["electron-builder", "--win", "--config", "electron-builder.yml", "--publish", "always"],
    { cwd: path.join(repoRoot, "apps", "desktop"), shell: true, env: { ...process.env, GH_TOKEN: process.env.GH_TOKEN } }
  );
} catch {
  refuse(
    "the installer was built but could not be published.",
    `Publish it by hand from apps/desktop/release, or re-run electron-builder with --publish always.\n` +
      `The release commit ${tag} is already pushed.`
  );
}

// ─── 8. Confirm what actually landed ─────────────────────────────────────────
//
// Not decoration. The two failures this release path has actually had were both SILENT: a tag
// pushed with nothing behind it, and artifacts split across duplicate releases. Both would have
// been caught here in a second.

step(8, "Confirming the published release");
try {
  const all = await github("GET", "/releases?per_page=100");
  const releases = JSON.parse(all.text).filter((release) => release.tag_name === tag);

  if (releases.length !== 1) {
    console.warn(`\n  WARNING: ${String(releases.length)} releases exist for ${tag}, expected 1.`);
    console.warn("  Artifacts may be split across them, which breaks the update feed. Merge them by hand.");
  }

  const names = releases.flatMap((release) => release.assets.map((asset) => asset.name));
  const missing = ["latest.yml"].filter((needed) => !names.includes(needed));
  if (missing.length > 0) {
    console.warn(`\n  WARNING: ${missing.join(", ")} is not on the release.`);
    console.warn("  Without latest.yml no computer can see this version. Upload it from apps/desktop/release.");
  }
  if (!names.some((name) => name.endsWith(".blockmap"))) {
    console.warn("\n  NOTE: no .blockmap was uploaded, so updates are full downloads rather than deltas.");
  }
  if (releases.length === 1 && missing.length === 0) {
    console.log(`  one release for ${tag}, carrying: ${names.join(", ")}`);
  }
} catch (error) {
  console.warn(`\n  WARNING: could not confirm the release: ${String(error)}`);
  console.warn("  Check it by hand before telling anyone the update has shipped.");
}

console.log(`\n777 ERP ${nextVersion} is published.`);
console.log("\nThe office PCs pick it up within four hours, or on their next start. Each one needs");
console.log("ERP_UPDATE_TOKEN set, or it will keep running the version it has — see docs.");
console.log("\nNOTE: the installer is unsigned until a code-signing certificate exists (docs/25),");
console.log("so Windows will warn before each update installs.");
