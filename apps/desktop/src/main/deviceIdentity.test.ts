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
  sanitizeHostPart,
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

  it("adopts the workstation an existing installation already has", () => {
    const identity = resolveDeviceIdentity({ dataRoot: root, findExistingWorkstation: () => legacy, hostname: "PC", randomSuffix: () => "0001" });

    // production_events.workstation_id is a foreign key to workstations(id): an existing
    // database must keep the identity its own history refers to.
    expect(identity.workstationId).toBe("ws-prod-01");
    expect(identity.workstationCode).toBe("PROD-01");
    expect(identity.deviceId).toBe("desktop-main");
    expect(readStoredIdentity(root)).toEqual(identity);
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
    const identity = resolveDeviceIdentity({ dataRoot: root, findExistingWorkstation: () => legacy, hostname: "PC" });
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
      hostname: "PC",
    });
    expect(recovered.workstationId).toBe(original.workstationId);
    expect(recovered.deviceId).toBe(original.deviceId);
  });
});
