// Release gate: prove the built artifacts are actually signed.
//
// WHY THIS EXISTS — the build cannot be trusted to tell you:
//   * electron-builder logs "signing with signtool.exe path=…" BEFORE it attempts to sign,
//     so that line appears for every artifact even when no certificate exists at all.
//   * When a file cannot be signed it logs "signing failed for file, queue will continue to
//     next file" as a WARNING and carries on, so a release can finish with exit code 0 and
//     still contain unsigned binaries.
// Neither the exit code nor the log is evidence. This script inspects the finished artifacts,
// which is the only thing that cannot lie.
//
// USAGE
//   npm run --workspace @erp/desktop verify:signatures
//   node ./scripts/verify-signatures.mjs [releaseDir] [--publisher "CN as issued"]
//
//   --publisher, or the ERP_EXPECTED_PUBLISHER environment variable, makes the check strict:
//   every signature must come from exactly that subject. Use it once a certificate exists.
//
// EXIT CODES
//   0  every required artifact carries a valid, timestamped signature from one identity
//   1  at least one does not, or the check itself could not be completed
//
// It FAILS CLOSED: anything it cannot positively verify counts as a failure, including its
// own errors. It reads only; it never writes, signs or modifies anything.
//
// NOT COVERED — THE UNINSTALLER
//   `Uninstall 777 ERP.exe` does not exist as a build artifact. NSIS carries it inside the
//   installer and writes it to disk at install time, so this script cannot inspect it. After
//   installing a signed build, check it by hand:
//       Get-AuthenticodeSignature "$env:LOCALAPPDATA\Programs\777 ERP\Uninstall 777 ERP.exe"
//   That is a required release step, not an optional one — see docs/25-code-signing.md §6.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const publisherFlag = argv.indexOf("--publisher");
const expectedPublisher =
  (publisherFlag !== -1 ? argv[publisherFlag + 1] : undefined) ?? process.env.ERP_EXPECTED_PUBLISHER ?? null;
// Guard the -1 case: without --publisher, publisherFlag + 1 is 0 and would silently discard
// the first positional argument, making the script run against the default directory instead
// of the one asked for.
const publisherValueIndex = publisherFlag === -1 ? -1 : publisherFlag + 1;
const positional = argv.filter((a, i) => !a.startsWith("--") && i !== publisherValueIndex);
const releaseDir = positional[0] ? path.resolve(positional[0]) : path.join(desktopRoot, "release");
const unpackedDir = path.join(releaseDir, "win-unpacked");

/**
 * Files that ship already signed by their own vendor. Reported, but never counted as our
 * failures — re-signing someone else's validly signed binary is not required. A vendor file
 * that is NOT validly signed is still reported so the anomaly is visible.
 */
const VENDOR_SIGNED = new Set(["d3dcompiler_47.dll", "dxil.dll"]);

/** Fails the whole run with a clear message rather than a stack trace. */
function abort(message) {
  console.error(`\nverify-signatures: ${message}\n`);
  process.exit(1);
}

// PowerShell is the only way to read Authenticode state here. Prove it works once, up front,
// rather than discovering it mid-run and crashing.
try {
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], {
    stdio: "ignore",
    windowsHide: true,
  });
} catch {
  abort("powershell.exe could not be run, so signatures cannot be verified. Treating as FAILED.");
}

/**
 * Authenticode state for one file. Never throws: any failure to inspect becomes a status the
 * caller treats as a failure, so one unreadable file cannot abort the whole report.
 */
function authenticode(file) {
  const ps = [
    "$ErrorActionPreference='Stop';",
    `$s = Get-AuthenticodeSignature -LiteralPath ${JSON.stringify(file)};`,
    "$c = $s.SignerCertificate;",
    "$o = [ordered]@{",
    "  status    = [string]$s.Status;",
    "  subject   = if ($c) { [string]$c.Subject } else { '' };",
    "  issuer    = if ($c) { [string]$c.Issuer } else { '' };",
    "  notAfter  = if ($c) { $c.NotAfter.ToString('yyyy-MM-dd') } else { '' };",
    "  timestamp = if ($s.TimeStamperCertificate) { 'yes' } else { 'no' };",
    "};",
    "$o | ConvertTo-Json -Compress",
  ].join(" ");

  try {
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
      encoding: "utf8",
      windowsHide: true,
    });
    const parsed = JSON.parse(out.trim());
    if (typeof parsed?.status !== "string") throw new Error("unexpected output shape");
    return parsed;
  } catch (error) {
    // Missing file, locked file, malformed output, PowerShell failure — all fail closed.
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return { status: "VERIFY-ERROR", subject: "", issuer: "", notAfter: "", timestamp: "no", error: reason };
  }
}

/** Every PE file we ship, plus the installer. */
function collectTargets() {
  const targets = [];
  if (fs.existsSync(unpackedDir)) {
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(exe|dll|node)$/i.test(entry.name)) targets.push(full);
      }
    };
    walk(unpackedDir);
  }
  if (fs.existsSync(releaseDir)) {
    for (const entry of fs.readdirSync(releaseDir)) {
      if (entry.toLowerCase().endsWith(".exe")) targets.push(path.join(releaseDir, entry));
    }
  }
  return targets;
}

const cn = (subject) => (subject.match(/CN=([^,]+)/)?.[1] ?? subject).trim();

const targets = collectTargets();
if (targets.length === 0) {
  abort(`no build artifacts found under ${releaseDir}. Run the packaging step first.`);
}

const rows = [];
const problems = [];
const ourSigners = new Set();

for (const file of targets) {
  const name = path.basename(file);
  const rel = path.relative(releaseDir, file);
  const vendor = VENDOR_SIGNED.has(name);
  const info = authenticode(file);
  const valid = info.status === "Valid";

  const fail = (reason) => problems.push({ file: rel, reason });

  if (valid && !vendor) {
    ourSigners.add(info.subject);

    // A signature that is not timestamped stops validating the day the certificate expires.
    if (info.timestamp !== "yes") fail("Valid but NOT TIMESTAMPED");

    // Subject === issuer means self-signed. Windows will report "Valid" for one that has been
    // installed into the local trusted root, which is exactly how a test certificate could
    // make this gate pass while the public cannot run the app. Refuse it explicitly.
    if (info.subject && info.subject === info.issuer) fail("SELF-SIGNED (issuer equals subject)");

    if (expectedPublisher && cn(info.subject) !== cn(expectedPublisher)) {
      fail(`signed by "${cn(info.subject)}", expected "${cn(expectedPublisher)}"`);
    }
  } else if (!valid && !vendor) {
    fail(info.status === "VERIFY-ERROR" ? `could not be verified (${info.error})` : info.status);
  } else if (!valid && vendor) {
    fail(`${info.status} — expected this vendor-signed file to already be valid`);
  }

  rows.push({
    file: rel,
    status: info.status,
    ts: valid ? info.timestamp : "-",
    note: vendor ? (valid ? "vendor-signed" : "VENDOR FILE NOT VALID") : "",
  });
}

const width = Math.max(...rows.map((r) => r.file.length), 4);
console.log(`\nSignature report — ${releaseDir}\n`);
console.log("  " + "FILE".padEnd(width) + "  STATUS        TIMESTAMPED  NOTE");
for (const r of rows) {
  console.log("  " + r.file.padEnd(width) + "  " + r.status.padEnd(13) + " " + r.ts.padEnd(12) + " " + r.note);
}

console.log("");
if (ourSigners.size === 1) {
  console.log(`  publisher: ${[...ourSigners][0]}`);
} else if (ourSigners.size > 1) {
  // One release signed by two identities means something is wrong with the pipeline, and it
  // splits SmartScreen reputation across both. Treat it as a failure, not a note.
  console.log("  signing identities found:");
  for (const s of ourSigners) console.log("    " + s);
  problems.push({ file: "(release)", reason: `${ourSigners.size} different signing identities in one release` });
}
if (expectedPublisher) console.log(`  expected : ${expectedPublisher}`);

console.log("\n  Not covered: Uninstall 777 ERP.exe is written at install time and must be");
console.log("  checked separately after installing — see docs/25-code-signing.md §6.");

if (problems.length > 0) {
  console.error(`\nFAILED — ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  ${p.file}\n      ${p.reason}`);
  console.error("\nDo not distribute this build.");
  console.error("If no certificate is configured yet, this failure is expected — see docs/25-code-signing.md.\n");
  process.exit(1);
}

console.log(`\nPASSED — ${rows.length} artifact(s) carry a valid, timestamped signature.\n`);
