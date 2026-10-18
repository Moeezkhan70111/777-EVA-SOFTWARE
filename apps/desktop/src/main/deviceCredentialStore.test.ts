// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A stand-in for Electron's safeStorage with the one property that matters: ciphertext is bound
// to a machine, so a blob written on one does not decrypt on another. The payload is base64ed
// inside the blob so a test can honestly search the bytes on disk for a token and not find it.
//
// `machine` is what the tests move to simulate a copied data folder, a re-imaged PC, or a
// different Windows profile — all of which present to the application as exactly this failure.
let machine: string;
let available: boolean;
let availabilityThrows: boolean;
/** How many times safeStorage has been asked whether it can encrypt. */
let availabilityChecks: number;

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: (): boolean => {
      availabilityChecks += 1;
      if (availabilityThrows) throw new Error("no key store on this system");
      return available;
    },
    encryptString: (text: string): Buffer =>
      Buffer.from(`${machine}|${Buffer.from(text, "utf8").toString("base64")}`, "utf8"),
    decryptString: (blob: Buffer): string => {
      const raw = blob.toString("utf8");
      const split = raw.indexOf("|");
      if (split < 0) throw new Error("not a safeStorage blob");
      if (raw.slice(0, split) !== machine) throw new Error("decryption failed");
      return Buffer.from(raw.slice(split + 1), "base64").toString("utf8");
    },
  },
}));

import {
  DEVICE_CREDENTIAL_FILE_NAME,
  DeviceCredentialStore,
  type DeviceCredential,
} from "./deviceCredentialStore";
import { ensureRuntimeDirectories, resetLocalData, resolveRuntimePaths } from "./runtimePaths";

// WHAT THIS MODULE IS FOR.
//
// Every other signal of which computer this is can be copied — device-identity.json is plain
// JSON, the workstations row travels in every backup, the environment variables are typed in by
// hand. This is the one artefact a second machine cannot read, so it is what a device's cloud
// identity will be rooted in. These prove it behaves that way, and that clearing the local data
// never costs a computer its enrolment.

const TOKEN = "zz-refresh-token-value-for-the-test-only";

const credential = (overrides: Partial<DeviceCredential> = {}): DeviceCredential => ({
  authUserId: "e23c8325-0000-0000-0000-000000000000",
  deviceId: "desktop-main",
  refreshToken: TOKEN,
  provisionedAt: "2026-10-17T09:00:00.000Z",
  ...overrides,
});

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "erp-credential-"));
  machine = "machine-A";
  available = true;
  availabilityThrows = false;
  availabilityChecks = 0;
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const storeIn = (directory: string = root): DeviceCredentialStore => new DeviceCredentialStore(directory);
const credentialFile = (directory: string = root): string =>
  path.join(directory, DEVICE_CREDENTIAL_FILE_NAME);

describe("the device credential store", () => {
  it("keeps a credential and hands back exactly what it was given", () => {
    const store = storeIn();
    expect(store.save(credential())).toBe("SAVED");
    expect(store.load()).toEqual(credential());
    expect(store.has()).toBe(true);
    expect(fs.existsSync(credentialFile())).toBe(true);
  });

  it("writes nothing a reader could use: the token is not in the file", () => {
    storeIn().save(credential());
    const bytes = fs.readFileSync(credentialFile());
    // The real guarantee is DPAPI; what this proves is that the module hands the value to
    // safeStorage rather than writing it out itself.
    expect(bytes.toString("utf8")).not.toContain(TOKEN);
    expect(bytes.toString("utf8")).not.toContain("refreshToken");
  });

  it("says nothing secret when asked to describe itself", () => {
    const store = storeIn();
    store.save(credential());
    const summary = store.summary();
    expect(summary).toEqual({
      present: true,
      authUserId: "e23c8325-0000-0000-0000-000000000000",
      deviceId: "desktop-main",
      provisionedAt: "2026-10-17T09:00:00.000Z",
    });
    expect(JSON.stringify(summary)).not.toContain(TOKEN);
    expect(storeIn(fs.mkdtempSync(path.join(os.tmpdir(), "erp-empty-"))).summary()).toEqual({
      present: false,
    });
  });

  it("knows whether the credential belongs to this installation", () => {
    const store = storeIn();
    store.save(credential({ deviceId: "desktop-main" }));
    expect(store.matchesDevice("desktop-main")).toBe(true);
    expect(store.matchesDevice("some-other-device")).toBe(false);
  });

  // ─── the point of the whole module ────────────────────────────────────────

  it("a copied data folder cannot use the credential it copied", () => {
    storeIn().save(credential());
    const copied = fs.mkdtempSync(path.join(os.tmpdir(), "erp-copied-"));
    fs.copyFileSync(credentialFile(), credentialFile(copied));

    // The second computer: same bytes, different machine.
    machine = "machine-B";
    const onTheOtherPc = storeIn(copied);
    expect(onTheOtherPc.load()).toBeNull();
    expect(onTheOtherPc.has()).toBe(false);
    expect(onTheOtherPc.summary()).toEqual({ present: false });
    // And it is still there, unrepaired: nothing re-provisions a copy into working order.
    expect(fs.existsSync(credentialFile(copied))).toBe(true);
    fs.rmSync(copied, { recursive: true, force: true });
  });

  it("a re-imaged machine or a new Windows profile reads as not enrolled, not as someone else", () => {
    const store = storeIn();
    store.save(credential());
    machine = "machine-A-after-reinstall";
    expect(store.load()).toBeNull();
    expect(store.has()).toBe(false);
  });

  it("corrupt ciphertext is absent, never a different credential", () => {
    const store = storeIn();
    store.save(credential());
    fs.writeFileSync(credentialFile(), Buffer.from("machine-A|not-valid-base64-json!!", "utf8"));
    expect(store.load()).toBeNull();

    fs.writeFileSync(credentialFile(), Buffer.from("no-separator-at-all", "utf8"));
    expect(store.load()).toBeNull();
  });

  it("an incomplete credential is refused on the way in and on the way out", () => {
    const store = storeIn();
    for (const missing of ["authUserId", "deviceId", "refreshToken", "provisionedAt"] as const) {
      expect(store.save(credential({ [missing]: "" }))).toBe("INVALID");
      expect(store.save(credential({ [missing]: "   " }))).toBe("INVALID");
    }
    expect(fs.existsSync(credentialFile())).toBe(false);

    // And a file that somehow holds a partial credential is not half-believed.
    store.save(credential());
    const partial = JSON.stringify({ authUserId: "a", deviceId: "b", provisionedAt: "c" });
    fs.writeFileSync(
      credentialFile(),
      Buffer.from(`machine-A|${Buffer.from(partial, "utf8").toString("base64")}`, "utf8")
    );
    expect(store.load()).toBeNull();
  });

  // ─── fail closed, and stay usable ─────────────────────────────────────────

  it("persists nothing when the operating system cannot encrypt", () => {
    available = false;
    const store = storeIn();
    expect(store.canPersist()).toBe(false);
    expect(store.save(credential())).toBe("ENCRYPTION_UNAVAILABLE");
    expect(fs.existsSync(credentialFile())).toBe(false);
    expect(store.load()).toBeNull();
  });

  it("will not read a credential back once encryption has stopped being available", () => {
    const store = storeIn();
    store.save(credential());
    available = false;
    // Refusing is the point: without the OS key store there is no proof this is the same machine.
    expect(store.load()).toBeNull();
    expect(store.has()).toBe(false);
  });

  it("treats a key store that throws as one that is not there", () => {
    availabilityThrows = true;
    const store = storeIn();
    expect(store.canPersist()).toBe(false);
    expect(store.save(credential())).toBe("ENCRYPTION_UNAVAILABLE");
    expect(store.load()).toBeNull();
  });

  it("leaves no temporary file behind, and replaces a credential cleanly", () => {
    const store = storeIn();
    store.save(credential());
    expect(store.save(credential({ refreshToken: "zz-second-token", provisionedAt: "2026-10-18T09:00:00.000Z" }))).toBe(
      "SAVED"
    );
    expect(store.load()?.refreshToken).toBe("zz-second-token");
    expect(fs.existsSync(`${credentialFile()}.tmp`)).toBe(false);
    expect(fs.readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  // ─── the reset policy ─────────────────────────────────────────────────────

  it("survives resetLocalData — clearing the data must not cost this computer its enrolment", () => {
    const paths = resolveRuntimePaths({
      platform: "win32",
      appDataDir: path.join(root, "Roaming"),
      localAppDataDir: root,
      tempDir: path.join(root, "Temp"),
      appPath: path.join(root, "app", "apps", "desktop"),
      overrideDataDir: root,
    });
    ensureRuntimeDirectories(paths);

    const store = storeIn(paths.dataRoot);
    store.save(credential());

    resetLocalData(paths, "admin");

    // The database, the images and the saved sign-ins are gone; this is not.
    expect(fs.existsSync(path.join(paths.dataRoot, DEVICE_CREDENTIAL_FILE_NAME))).toBe(true);
    expect(store.load()).toEqual(credential());
  });

  it("is removed only by clear(), which is a deliberate revocation or re-enrolment", () => {
    const store = storeIn();
    store.save(credential());

    // Nothing else in this module removes it: reading a copied, corrupt or unreadable
    // credential leaves the file exactly where it was.
    machine = "machine-B";
    store.load();
    store.has();
    store.summary();
    machine = "machine-A";
    expect(fs.existsSync(credentialFile())).toBe(true);
    expect(store.load()).toEqual(credential());

    store.clear();
    expect(fs.existsSync(credentialFile())).toBe(false);
    expect(store.load()).toBeNull();
    expect(store.has()).toBe(false);
  });

  // ─── safeStorage is only usable once Electron is ready ────────────────────
  //
  // Asked before `app.whenReady()`, isEncryptionAvailable() answers false whatever the machine.
  // That once turned every installation into CREDENTIAL_UNREADABLE — and because that reading
  // refuses adoption, a machine whose identity file was missing would have minted a fresh
  // identity instead of keeping the one its own history refers to. Constructing the store must
  // therefore be free of any probe, so it can be built whenever the caller likes; only the
  // methods ask, and the caller is responsible for asking after readiness.

  it("constructing the store asks safeStorage nothing", () => {
    const store = new DeviceCredentialStore(root);
    expect(availabilityChecks).toBe(0);
    // Naming the file is safe too: a diagnostic may want the path before the app is ready.
    expect(store.path.endsWith(DEVICE_CREDENTIAL_FILE_NAME)).toBe(true);
    expect(availabilityChecks).toBe(0);
  });

  it("every method that could mislead before readiness does ask first", () => {
    const store = new DeviceCredentialStore(root);
    store.credentialState();
    expect(availabilityChecks).toBeGreaterThan(0);
  });

  it("clearing a store that has nothing is not an error", () => {
    const store = storeIn();
    expect(() => store.clear()).not.toThrow();
    expect(store.load()).toBeNull();
  });

  // ─── how the credential looks to identity resolution ──────────────────────
  //
  // This is the one signal that decides whether an installation may adopt the workstation a
  // database already names. ABSENT and UNREADABLE refuse adoption identically, but they are
  // different things to tell an owner, so they are kept apart.

  it("reports ABSENT when this machine has never been enrolled", () => {
    expect(storeIn().credentialState()).toEqual({ kind: "ABSENT" });
  });

  it("reports PRESENT with the device it was provisioned for", () => {
    const store = storeIn();
    store.save(credential({ deviceId: "desktop-sync-test-01" }));
    expect(store.credentialState()).toEqual({ kind: "PRESENT", deviceId: "desktop-sync-test-01" });
  });

  it("reports UNREADABLE for a credential written on another machine", () => {
    const store = storeIn();
    store.save(credential());
    machine = "machine-B";
    // Not ABSENT: the file is right there, and saying "never enrolled" would send an owner
    // looking for the wrong problem.
    expect(store.credentialState()).toEqual({ kind: "UNREADABLE" });
  });

  it("reports UNREADABLE when the operating system cannot decrypt at all", () => {
    const store = storeIn();
    store.save(credential());
    available = false;
    // THE DELIBERATE CHOICE: no key store means a restored backup cannot be told from the
    // original machine, so adoption is refused rather than guessed at.
    expect(store.credentialState()).toEqual({ kind: "UNREADABLE" });
  });

  it("reports UNREADABLE when there is no key store and no file either", () => {
    available = false;
    expect(storeIn().credentialState()).toEqual({ kind: "UNREADABLE" });
  });

  it("reports UNREADABLE for a decryptable but incomplete credential", () => {
    const store = storeIn();
    store.save(credential());
    const partial = JSON.stringify({ authUserId: "a", deviceId: "b", provisionedAt: "c" });
    fs.writeFileSync(
      credentialFile(),
      Buffer.from(`machine-A|${Buffer.from(partial, "utf8").toString("base64")}`, "utf8")
    );
    expect(store.credentialState()).toEqual({ kind: "UNREADABLE" });
  });

  it("reports UNREADABLE for corrupt bytes, and never invents a device id", () => {
    const store = storeIn();
    store.save(credential());
    fs.writeFileSync(credentialFile(), Buffer.from("not a safeStorage blob at all", "utf8"));
    const state = store.credentialState();
    expect(state).toEqual({ kind: "UNREADABLE" });
    expect(JSON.stringify(state)).not.toContain("desktop-main");
  });

  it("reading the state changes nothing on disk", () => {
    const store = storeIn();
    store.save(credential());
    const before = fs.readFileSync(credentialFile());
    for (let read = 0; read < 3; read += 1) store.credentialState();
    expect(fs.readFileSync(credentialFile()).equals(before)).toBe(true);
    expect(store.credentialState()).toEqual({ kind: "PRESENT", deviceId: "desktop-main" });
  });

});
