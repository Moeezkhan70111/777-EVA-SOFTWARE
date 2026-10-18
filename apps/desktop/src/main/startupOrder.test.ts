// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// WHEN THE MAIN PROCESS IS ALLOWED TO ASK safeStorage ANYTHING.
//
// Electron's safeStorage only works once the app is ready. Asked earlier it reports that
// encryption is unavailable on every machine, and this project read that as
// CREDENTIAL_UNREADABLE — "there is a credential here this computer cannot read" — when the
// truth was that there was no credential at all. That reading also REFUSES adoption, so an
// installation whose identity file was missing would have minted a fresh identity instead of
// keeping the one its own database history refers to. A wrong outcome from call timing alone,
// and one that no unit test caught because every test supplies its own safeStorage.
//
// main.ts cannot be imported here: it is the Electron entry point and calls app.* at module
// scope. So this reads the file and asserts the ORDER of the statements in it. Crude, and it
// proves the source says the right thing rather than that Electron behaves — but it is exactly
// the regression that would otherwise return unnoticed, because the symptom is one misleading
// word in a log line.

const SOURCE = fs.readFileSync(path.resolve(import.meta.dirname, "../main.ts"), "utf8");

// COMMENTS ARE STRIPPED FIRST. main.ts explains this ordering at length in prose, and the
// prose quotes the very statements asserted below — so a matcher that read the whole file
// would go on passing after someone commented the await out. Verified by doing exactly that:
// the assertions failed only once comments stopped counting. main.ts has no "//" inside any
// string literal, so removing line comments cannot swallow code.
const MAIN = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

/** Where a statement first appears in the code, asserting it appears at all. */
const at = (needle: string): number => {
  const index = MAIN.indexOf(needle);
  expect(index, `main.ts no longer contains ${needle}`).toBeGreaterThanOrEqual(0);
  return index;
};

describe("main-process startup order", () => {
  it("waits for Electron to be ready before reading the credential", () => {
    const ready = at("await app.whenReady()");
    expect(ready).toBeLessThan(at("new DeviceCredentialStore("));
    expect(ready).toBeLessThan(at("credentials.credentialState()"));
  });

  it("resolves the identity only after readiness, so adoption is decided on a real answer", () => {
    expect(at("await app.whenReady()")).toBeLessThan(at("resolveInstallation("));
  });

  it("logs the installation diagnostic only after readiness", () => {
    // Otherwise `secureStorage: false` is reported on every machine, every launch.
    expect(at("await app.whenReady()")).toBeLessThan(at('operation: "device-identity"'));
    expect(at("await app.whenReady()")).toBeLessThan(at("describeInstallation("));
  });

  it("still opens the database before waiting, so the slow part overlaps Electron startup", () => {
    // The fix must not become "do everything after ready": opening the database and running
    // its migrations is the expensive step and belongs in parallel with Electron's own start.
    const ready = at("await app.whenReady()");
    expect(at("new dataModule.SqliteDatabase(")).toBeLessThan(ready);
    expect(at("new dataModule.StructuredLogger(")).toBeLessThan(ready);
  });

  it("waits exactly once, and does not duplicate database or filesystem setup", () => {
    expect(MAIN.split("await app.whenReady()")).toHaveLength(2);
    expect(MAIN.split("new dataModule.SqliteDatabase(")).toHaveLength(2);
    expect(MAIN.split("ensureOperationalContext(")).toHaveLength(2);
    expect(MAIN.split("bootstrapFilesystem()")).toHaveLength(3); // the definition and one call
  });

  it("keeps the window behind every service, as it always was", () => {
    // registerIpcHandlers must still run before a window can call a channel.
    expect(at("registerIpcHandlers(")).toBeLessThan(at("app.whenReady().then("));
    expect(at("await servicesPromise")).toBeLessThan(at("createWindow();"));
  });

  it("asks safeStorage nothing directly: only the store does, and only when called", () => {
    // Keeping the single caller inside DeviceCredentialStore is what makes the ordering above
    // the whole of the fix. main.ts may name safeStorage in prose; it may not call it.
    expect(MAIN).not.toContain("safeStorage");
    expect(MAIN).not.toContain("isEncryptionAvailable");
  });
});
