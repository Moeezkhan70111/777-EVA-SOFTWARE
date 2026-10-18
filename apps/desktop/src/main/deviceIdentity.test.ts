// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEVICE_IDENTITY_FILE_NAME,
  buildWorkstationCode,
  isValidWorkstationCode,
  readStoredIdentity,
  resolveDeviceIdentity,
  describeInstallation,
  resolveInstallation,
  sanitizeHostPart,
  type DeviceCredentialCheck,
  type ExistingWorkstation,
} from "./deviceIdentity";
import { ensureRuntimeDirectories, resetLocalData, resolveRuntimePaths } from "./runtimePaths";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "erp-identity-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const noWorkstation = () => null;
const legacy: ExistingWorkstation = {
  workstationId: "ws-prod-01",
  workstationCode: "PROD-01",
  workstationName: "Production Line 01",
  deviceId: "desktop-main",
};

// The credential as this machine sees it. ABSENT is what every installation looks like until
// provisioning exists, so it is the default wherever a test does not say otherwise.
const noCredential: DeviceCredentialCheck = () => ({ kind: "ABSENT" });
const unreadableCredential: DeviceCredentialCheck = () => ({ kind: "UNREADABLE" });
const credentialFor =
  (deviceId: string): DeviceCredentialCheck =>
  () => ({ kind: "PRESENT", deviceId });
/** A credential proving this machine is the one the legacy database belongs to. */
const legacyCredential = credentialFor(legacy.deviceId);

describe("workstation code", () => {
  it("is built from the computer name and a short suffix", () => {
    expect(buildWorkstationCode("STORE-PC-1", "9F2A")).toBe("WS-STORE-PC-1-9F2A");
  });

  it("strips characters that have no business in a code", () => {
    expect(sanitizeHostPart("desk top_#1")).toBe("DESK-TOP-1");
    expect(buildWorkstationCode("desk top_#1", "ABCD")).toBe("WS-DESK-TOP-1-ABCD");
  });

  it("falls back to WS when the computer name contributes nothing usable", () => {
    expect(sanitizeHostPart("___")).toBe("WS");
    expect(buildWorkstationCode("___", "0001")).toBe("WS-WS-0001");
  });

  it("caps an overlong computer name and never ends on a dash", () => {
    const code = buildWorkstationCode("A-VERY-LONG-COMPUTER-NAME-INDEED", "BEEF");
    expect(code.length).toBeLessThanOrEqual(3 + 12 + 1 + 4);
    expect(code).not.toContain("--");
    expect(isValidWorkstationCode(code)).toBe(true);
  });

  it("validates the generated format and rejects the old hard-coded one", () => {
    expect(isValidWorkstationCode(buildWorkstationCode("FLOOR1", "12AB"))).toBe(true);
    expect(isValidWorkstationCode("PROD-01")).toBe(false);
    expect(isValidWorkstationCode("WS-FLOOR1-12ab")).toBe(false);
  });
});

describe("resolveDeviceIdentity", () => {
  it("mints a complete identity on a fresh install and writes it down", () => {
    const identity = resolveDeviceIdentity({
      dataRoot: root,
      findExistingWorkstation: noWorkstation,
      hostname: "STORE-PC",
      randomSuffix: () => "9F2A",
    });

    expect(identity.workstationCode).toBe("WS-STORE-PC-9F2A");
    expect(isValidWorkstationCode(identity.workstationCode)).toBe(true);
    expect(identity.deviceName).toBe("STORE-PC");
    // Ids are UUIDs, not the old hard-coded strings.
    expect(identity.workstationId).not.toBe("ws-prod-01");
    expect(identity.deviceId).not.toBe("desktop-main");
    expect(identity.workstationId).toMatch(/^[0-9a-f-]{36}$/);
    // The factory is shared by every installation on purpose.
    expect(identity.factoryId).toBe("factory-777");
    expect(fs.existsSync(path.join(root, DEVICE_IDENTITY_FILE_NAME))).toBe(true);
  });

  it("returns the same identity on every later launch", () => {
    const first = resolveDeviceIdentity({ dataRoot: root, findExistingWorkstation: noWorkstation, hostname: "PC", randomSuffix: () => "0001" });
    const second = resolveDeviceIdentity({
      dataRoot: root,
      findExistingWorkstation: () => {
        throw new Error("the database must not be consulted once the identity is stored");
      },
      hostname: "SOMETHING-ELSE",
      randomSuffix: () => "FFFF",
    });
    expect(second).toEqual(first);
  });

  it("adopts the workstation an existing installation already has, once the credential proves it", () => {
    const resolved = resolveInstallation({
      dataRoot: root,
      findExistingWorkstation: () => legacy,
      credential: legacyCredential,
      hostname: "PC",
      randomSuffix: () => "0001",
    });

    // production_events.workstation_id is a foreign key to workstations(id): a computer that
    // has proved it is this one keeps the identity its own history refers to.
    expect(resolved.source).toBe("ADOPTED");
    expect(resolved.identity.workstationId).toBe("ws-prod-01");
    expect(resolved.identity.workstationCode).toBe("PROD-01");
    expect(resolved.identity.deviceId).toBe("desktop-main");
    expect(resolved.enrolment).toEqual({ enrolled: true });
    expect(readStoredIdentity(root)).toEqual(resolved.identity);
  });

  it("two fresh installations never collide", () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "erp-identity-b-"));
    try {
      const a = resolveDeviceIdentity({ dataRoot: root, findExistingWorkstation: noWorkstation, hostname: "PC-A", randomSuffix: () => "AAAA" });
      const b = resolveDeviceIdentity({ dataRoot: other, findExistingWorkstation: noWorkstation, hostname: "PC-B", randomSuffix: () => "BBBB" });

      // These three columns are UNIQUE in the schema; they are what collide in the cloud.
      expect(a.workstationId).not.toBe(b.workstationId);
      expect(a.workstationCode).not.toBe(b.workstationCode);
      expect(a.deviceId).not.toBe(b.deviceId);
      // The factory is deliberately shared.
      expect(a.factoryId).toBe(b.factoryId);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it("two installs on identically named machines still differ", () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "erp-identity-c-"));
    try {
      const a = resolveDeviceIdentity({ dataRoot: root, findExistingWorkstation: noWorkstation, hostname: "FLOOR-PC" });
      const b = resolveDeviceIdentity({ dataRoot: other, findExistingWorkstation: noWorkstation, hostname: "FLOOR-PC" });
      expect(a.workstationCode).not.toBe(b.workstationCode);
      expect(a.deviceId).not.toBe(b.deviceId);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it("re-derives rather than crashing when the stored file is corrupt", () => {
    fs.writeFileSync(path.join(root, DEVICE_IDENTITY_FILE_NAME), "{ not json", "utf8");
    const identity = resolveDeviceIdentity({
      dataRoot: root,
      findExistingWorkstation: () => legacy,
      credential: legacyCredential,
      hostname: "PC",
    });
    expect(identity.workstationId).toBe("ws-prod-01");
    expect(readStoredIdentity(root)).toEqual(identity);
  });

  it("re-derives when the stored file is incomplete", () => {
    fs.writeFileSync(path.join(root, DEVICE_IDENTITY_FILE_NAME), JSON.stringify({ deviceId: "only-this" }), "utf8");
    expect(readStoredIdentity(root)).toBeNull();
    const identity = resolveDeviceIdentity({ dataRoot: root, findExistingWorkstation: noWorkstation, hostname: "PC", randomSuffix: () => "1234" });
    expect(identity.workstationCode).toBe("WS-PC-1234");
  });

  it("survives resetLocalData — wiping the data must not change which machine this is", () => {
    const paths = resolveRuntimePaths({
      platform: "win32",
      appDataDir: path.join(root, "Roaming"),
      localAppDataDir: root,
      tempDir: path.join(root, "Temp"),
      appPath: path.join(root, "app", "apps", "desktop"),
      overrideDataDir: root,
    });
    ensureRuntimeDirectories(paths);

    const before = resolveDeviceIdentity({ dataRoot: paths.dataRoot, findExistingWorkstation: noWorkstation, hostname: "FLOOR-PC", randomSuffix: () => "7C1D" });
    resetLocalData(paths, "admin");

    expect(fs.existsSync(path.join(paths.dataRoot, DEVICE_IDENTITY_FILE_NAME))).toBe(true);
    const after = resolveDeviceIdentity({
      dataRoot: paths.dataRoot,
      findExistingWorkstation: () => {
        throw new Error("the database was just wiped and must not be consulted");
      },
    });
    expect(after).toEqual(before);
  });

  it("recovers the machine's identity from the database if the file is deleted", () => {
    const original = resolveDeviceIdentity({ dataRoot: root, findExistingWorkstation: noWorkstation, hostname: "PC", randomSuffix: () => "5678" });
    fs.rmSync(path.join(root, DEVICE_IDENTITY_FILE_NAME));

    const recovered = resolveDeviceIdentity({
      dataRoot: root,
      findExistingWorkstation: () => ({
        workstationId: original.workstationId,
        workstationCode: original.workstationCode,
        workstationName: original.workstationName,
        deviceId: original.deviceId,
      }),
      credential: credentialFor(original.deviceId),
      hostname: "PC",
    });
    expect(recovered.workstationId).toBe(original.workstationId);
    expect(recovered.deviceId).toBe(original.deviceId);
  });
});

// ─── whose computer is this? ────────────────────────────────────────────────
//
// A backup is a copy of the database and nothing else, so the `workstations` row inside it
// travels to whatever machine the file is restored on. Adopting it on sight meant a restored
// backup silently became the computer it came from — same workstation, same device id, every
// later scan recorded under another machine. These prove adoption now needs the one artefact
// that does not copy, and that refusing it costs the cloud and nothing else.

describe("adopting a database identity", () => {
  const existingDatabase = () => legacy;

  it("is refused when there is no credential, however convincing the database looks", () => {
    const resolved = resolveInstallation({
      dataRoot: root,
      findExistingWorkstation: existingDatabase,
      credential: noCredential,
      hostname: "FLOOR-PC",
      randomSuffix: () => "AB12",
    });
    expect(resolved.source).toBe("MINTED");
    expect(resolved.identity.workstationId).not.toBe(legacy.workstationId);
    expect(resolved.identity.deviceId).not.toBe(legacy.deviceId);
    expect(resolved.enrolment).toEqual({ enrolled: false, reason: "NO_CREDENTIAL" });
  });

  it("is refused when a credential is there but cannot be read on this machine", () => {
    const resolved = resolveInstallation({
      dataRoot: root,
      findExistingWorkstation: existingDatabase,
      credential: unreadableCredential,
      hostname: "FLOOR-PC",
      randomSuffix: () => "AB12",
    });
    expect(resolved.source).toBe("MINTED");
    expect(resolved.identity.deviceId).not.toBe(legacy.deviceId);
    // Kept apart from "never enrolled": this one needs a recovery, and the owner has to be told.
    expect(resolved.enrolment).toEqual({ enrolled: false, reason: "CREDENTIAL_UNREADABLE" });
  });

  it("is refused when the credential names a different device", () => {
    const resolved = resolveInstallation({
      dataRoot: root,
      findExistingWorkstation: existingDatabase,
      credential: credentialFor("some-other-computer"),
      hostname: "FLOOR-PC",
      randomSuffix: () => "AB12",
    });
    expect(resolved.source).toBe("MINTED");
    expect(resolved.identity.deviceId).not.toBe(legacy.deviceId);
    expect(resolved.identity.deviceId).not.toBe("some-other-computer");
    expect(resolved.enrolment).toEqual({ enrolled: false, reason: "CREDENTIAL_FOR_ANOTHER_DEVICE" });
  });

  it("a backup restored on another computer does not become that computer", () => {
    // PC2 has the database file and nothing else: no identity file, and no credential of PC1
    // that could possibly decrypt here.
    const pc2 = resolveInstallation({
      dataRoot: root,
      findExistingWorkstation: () => legacy,
      credential: noCredential,
      hostname: "PC-2",
      randomSuffix: () => "C3D4",
    });

    expect(pc2.identity.deviceId).not.toBe(legacy.deviceId);
    expect(pc2.identity.workstationId).not.toBe(legacy.workstationId);
    expect(pc2.identity.workstationCode).toBe("WS-PC-2-C3D4");
    expect(pc2.enrolment.enrolled).toBe(false);
    // Written down, so PC2 is stable from now on. Being written down is not enrolment.
    expect(readStoredIdentity(root)).toEqual(pc2.identity);
  });

  it("leaves the history it was shown exactly as it found it", () => {
    // This module cannot write to the database: it is handed one read function and nothing
    // else. The row it is shown must come back untouched, and the fresh identity takes a place
    // beside that row rather than replacing it.
    const row: ExistingWorkstation = { ...legacy };
    const before = JSON.stringify(row);
    let reads = 0;

    const resolved = resolveInstallation({
      dataRoot: root,
      findExistingWorkstation: () => {
        reads += 1;
        return row;
      },
      credential: noCredential,
      hostname: "PC-2",
      randomSuffix: () => "E5F6",
    });

    expect(JSON.stringify(row)).toBe(before);
    expect(reads).toBe(1);
    // The old workstation id is still what history refers to; nothing rewrote it.
    expect(row.workstationId).toBe("ws-prod-01");
    expect(resolved.identity.workstationId).not.toBe(row.workstationId);
  });
});

// ─── enrolment is judged against the identity actually in use ───────────────

describe("whether this computer is enrolled", () => {
  /** Establishes a stored identity with no credential, then reads it again with one. */
  const storedThen = (credential: DeviceCredentialCheck) => {
    const first = resolveInstallation({
      dataRoot: root,
      findExistingWorkstation: noWorkstation,
      credential: noCredential,
      hostname: "FLOOR-PC",
      randomSuffix: () => "7C1D",
    });
    const again = resolveInstallation({
      dataRoot: root,
      findExistingWorkstation: noWorkstation,
      credential,
    });
    return { first, again };
  };

  it("an ordinary restart reuses the stored identity, and matches a credential that names it", () => {
    const first = resolveInstallation({
      dataRoot: root,
      findExistingWorkstation: noWorkstation,
      credential: noCredential,
      hostname: "FLOOR-PC",
      randomSuffix: () => "7C1D",
    });
    const matched = resolveInstallation({
      dataRoot: root,
      findExistingWorkstation: noWorkstation,
      credential: credentialFor(first.identity.deviceId),
    });
    expect(matched.source).toBe("STORED");
    expect(matched.identity).toEqual(first.identity);
    expect(matched.enrolment).toEqual({ enrolled: true });
  });

  it("a copied data folder keeps working locally and is not enrolled", () => {
    // The identity file copies across; the credential does not decrypt on the second machine.
    const { first, again } = storedThen(unreadableCredential);
    expect(again.source).toBe("STORED");
    expect(again.identity).toEqual(first.identity);
    expect(again.enrolment).toEqual({ enrolled: false, reason: "CREDENTIAL_UNREADABLE" });
  });

  it("says plainly when the credential belongs to another device", () => {
    const { again } = storedThen(credentialFor("a-different-computer"));
    expect(again.enrolment).toEqual({ enrolled: false, reason: "CREDENTIAL_FOR_ANOTHER_DEVICE" });
  });

  it("treats a caller that knows nothing about credentials as having none", () => {
    // main.ts does not pass one yet, and must keep resolving an identity exactly as before.
    const resolved = resolveInstallation({ dataRoot: root, findExistingWorkstation: noWorkstation, hostname: "PC" });
    expect(resolved.source).toBe("MINTED");
    expect(resolved.enrolment).toEqual({ enrolled: false, reason: "NO_CREDENTIAL" });
    expect(resolveDeviceIdentity({ dataRoot: root, findExistingWorkstation: noWorkstation })).toEqual(
      resolved.identity
    );
  });

  it("an unenrolled computer still has a complete, usable local identity", () => {
    const { identity, enrolment } = resolveInstallation({
      dataRoot: root,
      findExistingWorkstation: () => legacy,
      credential: unreadableCredential,
      hostname: "FLOOR-PC",
      randomSuffix: () => "9A8B",
    });
    expect(enrolment.enrolled).toBe(false);
    // Everything a foreign key and a scan need is present.
    for (const value of Object.values(identity)) expect(typeof value).toBe("string");
    expect(identity.factoryId).toBe("factory-777");
    expect(isValidWorkstationCode(identity.workstationCode)).toBe(true);
    expect(identity.workstationId).not.toBe("");
    expect(identity.deviceId).not.toBe("");
  });

  it("a local reset keeps both the identity and, by not touching it, the credential", () => {
    const paths = resolveRuntimePaths({
      platform: "win32",
      appDataDir: path.join(root, "Roaming"),
      localAppDataDir: root,
      tempDir: path.join(root, "Temp"),
      appPath: path.join(root, "app", "apps", "desktop"),
      overrideDataDir: root,
    });
    ensureRuntimeDirectories(paths);
    // Stands in for device-credential.bin: resetLocalData deletes a named list, and anything
    // else in the data root survives. deviceCredentialStore.test.ts proves the real file does.
    const credentialFile = path.join(paths.dataRoot, "device-credential.bin");
    fs.writeFileSync(credentialFile, "ciphertext", "utf8");

    const before = resolveInstallation({
      dataRoot: paths.dataRoot,
      findExistingWorkstation: noWorkstation,
      credential: noCredential,
      hostname: "FLOOR-PC",
      randomSuffix: () => "4411",
    });

    resetLocalData(paths, "admin");

    expect(fs.existsSync(credentialFile)).toBe(true);
    const after = resolveInstallation({
      dataRoot: paths.dataRoot,
      findExistingWorkstation: () => {
        throw new Error("the database was just wiped and must not be consulted");
      },
      credential: credentialFor(before.identity.deviceId),
    });
    expect(after.source).toBe("STORED");
    expect(after.identity).toEqual(before.identity);
    // A reset does not grant a cloud identity, and does not take one away either.
    expect(after.enrolment).toEqual({ enrolled: true });
  });
});

// ─── what the startup line is allowed to say ────────────────────────────────
//
// A log is read by support, pasted into messages and kept for months. It is the last place a
// secret should reach and the easiest to leak one through by adding "just one more useful
// field", so the payload is built by a function that can be tested rather than assembled
// inline at the call site.

describe("the installation log payload", () => {
  const resolveWith = (credential: DeviceCredentialCheck, existing: ExistingWorkstation | null = null) =>
    resolveInstallation({
      dataRoot: root,
      findExistingWorkstation: () => existing,
      credential,
      hostname: "FLOOR-PC",
      randomSuffix: () => "4242",
    });

  it("says where the identity came from and whether the cloud would accept it", () => {
    const installation = resolveWith(credentialFor("desktop-main"), legacy);
    expect(describeInstallation(installation, true)).toEqual({
      source: "ADOPTED",
      workstationId: "ws-prod-01",
      enrolled: true,
      reason: null,
      secureStorage: true,
    });
  });

  it("carries the refusal reason when this computer is not enrolled", () => {
    const installation = resolveWith(noCredential, legacy);
    expect(describeInstallation(installation, true)).toEqual({
      source: "MINTED",
      workstationId: installation.identity.workstationId,
      enrolled: false,
      reason: "NO_CREDENTIAL",
      secureStorage: true,
    });
  });

  it("distinguishes a machine with no key store from one with no credential", () => {
    const installation = resolveWith(unreadableCredential, legacy);
    const payload = describeInstallation(installation, false);
    expect(payload.reason).toBe("CREDENTIAL_UNREADABLE");
    expect(payload.secureStorage).toBe(false);
  });

  it("never reports a credential for another device as enrolled", () => {
    const installation = resolveWith(credentialFor("some-other-computer"), legacy);
    const payload = describeInstallation(installation, true);
    expect(payload.enrolled).toBe(false);
    expect(payload.reason).toBe("CREDENTIAL_FOR_ANOTHER_DEVICE");
    // And the identity it ended up with is this machine's own, not the one the credential named.
    expect(payload.workstationId).not.toBe(legacy.workstationId);
  });

  it("carries five fields and no secret of any kind", () => {
    const installation = resolveWith(credentialFor("desktop-main"), legacy);
    const payload = describeInstallation(installation, true);

    expect(Object.keys(payload).sort()).toEqual([
      "enrolled",
      "reason",
      "secureStorage",
      "source",
      "workstationId",
    ]);

    // The four things that must never reach a log line. The claim holder cannot reach here at
    // all -- it lives only in the transport's memory for one pass -- and this pins that.
    const serialised = JSON.stringify(payload).toLowerCase();
    for (const secret of ["token", "password", "authuserid", "holder", "epoch", "refresh", "apikey", "anon"]) {
      expect(serialised).not.toContain(secret);
    }
  });
});
