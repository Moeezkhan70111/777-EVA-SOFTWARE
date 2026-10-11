import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Who this installation says it is.
//
// Until Phase 0 every copy of the ERP claimed to be the same workstation — `ws-prod-01` /
// `desktop-main` were hard-coded in main.ts — so two machines produced scan events that were
// indistinguishable, and `workstations.workstation_code`, `workstations.device_id` and
// `factories.code` (all UNIQUE) would collide the moment a second machine shared a database.
//
// The identity is decided once and then kept in `device-identity.json` beside the database.
// It deliberately lives in the data folder rather than in the database: `resetLocalData`
// wipes the database, and wiping the data must not turn a machine into a different
// workstation.
//
// This module has no Electron dependency so it can be unit-tested, exactly like
// runtimePaths.ts; main.ts feeds it the data root and a lookup into the database.
//
// KNOWN LIMITATION — folder-copy duplication. Copying the whole `777-erp` data folder to
// another PC copies this file too, and both machines would then claim one identity. Phase 0
// deliberately does not bind the identity to a machine GUID (that trades one failure mode for
// another when hardware changes). Duplicate-device detection must be built and tested on the
// server BEFORE cloud synchronisation is switched on — see docs/26 and the Phase 0 report.

export const DEVICE_IDENTITY_FILE_NAME = "device-identity.json";

/** The one factory. Shared by every installation on purpose — it is the tenant, not the machine. */
const FACTORY = {
  factoryId: "factory-777",
  factoryCode: "777",
  factoryName: "777 Manufacturing",
} as const;

export interface DeviceIdentity {
  factoryId: string;
  factoryCode: string;
  factoryName: string;
  workstationId: string;
  workstationCode: string;
  workstationName: string;
  deviceId: string;
  deviceName: string;
}

/** The workstation row an existing installation already has, if any. */
export interface ExistingWorkstation {
  workstationId: string;
  workstationCode: string;
  workstationName: string;
  deviceId: string;
}

export interface DeviceIdentityEnvironment {
  dataRoot: string;
  /** Reads one workstation row from the database, or null on a fresh install. */
  findExistingWorkstation: () => ExistingWorkstation | null;
  /** os.hostname() — injected so the generated code is testable. */
  hostname?: string;
  /** Random suffix generator — injected so tests can make it deterministic. */
  randomSuffix?: () => string;
}

/**
 * Windows computer names allow characters that have no business in a code we may later put in
 * a URL or a filename. Keep A–Z, 0–9 and dashes, collapse the rest, and cap the length so the
 * finished code stays readable in a log line.
 */
const MAX_HOST_PART = 12;

export const sanitizeHostPart = (hostname: string): string => {
  const cleaned = hostname
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_HOST_PART)
    .replace(/-+$/g, "");
  return cleaned || "WS";
};

/** Four hex characters. Short enough to read aloud, wide enough to not collide in a factory. */
const defaultRandomSuffix = (): string => crypto.randomBytes(2).toString("hex").toUpperCase();

/** `WS-<HOSTNAME>-<4 hex>`, e.g. `WS-STORE-PC-1-9F2A`. Internal only — never shown to an operator. */
export const buildWorkstationCode = (hostname: string, suffix: string): string =>
  `WS-${sanitizeHostPart(hostname)}-${suffix}`;

/** The shape a workstation code must have. Used to validate what we generate and what we read back. */
export const WORKSTATION_CODE_PATTERN = /^WS-[A-Z0-9][A-Z0-9-]*-[0-9A-F]{4}$/;

export const isValidWorkstationCode = (code: string): boolean => WORKSTATION_CODE_PATTERN.test(code);

const identityFile = (dataRoot: string): string => path.join(dataRoot, DEVICE_IDENTITY_FILE_NAME);

const isCompleteIdentity = (value: unknown): value is DeviceIdentity => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const required: Array<keyof DeviceIdentity> = [
    "factoryId",
    "factoryCode",
    "factoryName",
    "workstationId",
    "workstationCode",
    "workstationName",
    "deviceId",
    "deviceName",
  ];
  return required.every((key) => typeof record[key] === "string" && (record[key] as string).trim() !== "");
};

/** The stored identity, or null when there is none, it is unreadable, or it is incomplete. */
export function readStoredIdentity(dataRoot: string): DeviceIdentity | null {
  const file = identityFile(dataRoot);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return isCompleteIdentity(parsed) ? parsed : null;
  } catch {
    // A corrupt file must not stop the ERP starting: fall through and re-derive the identity,
    // which on an existing installation means adopting the workstation already in the database.
    return null;
  }
}

function writeIdentity(dataRoot: string, identity: DeviceIdentity): void {
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.writeFileSync(identityFile(dataRoot), JSON.stringify(identity, null, 2), "utf8");
}

/** A brand-new identity for a machine that has never run the ERP. */
function mintIdentity(env: DeviceIdentityEnvironment): DeviceIdentity {
  const hostname = env.hostname ?? os.hostname();
  const suffix = (env.randomSuffix ?? defaultRandomSuffix)();
  const workstationCode = buildWorkstationCode(hostname, suffix);
  return {
    ...FACTORY,
    workstationId: crypto.randomUUID(),
    workstationCode,
    workstationName: sanitizeHostPart(hostname),
    deviceId: crypto.randomUUID(),
    deviceName: hostname,
  };
}

/**
 * This installation's identity, created once and stable thereafter.
 *
 * Order matters:
 *   1. the stored file, if it is present and complete;
 *   2. otherwise the workstation this database already has — an EXISTING installation keeps the
 *      identity its history already refers to. `production_events.workstation_id` is a foreign
 *      key to `workstations(id)`, so minting a new id here would leave old events pointing at
 *      one workstation and new events at another, for one physical machine;
 *   3. otherwise a fresh identity.
 *
 * The result is written back in cases 2 and 3, so step 1 answers every later launch.
 */
export function resolveDeviceIdentity(env: DeviceIdentityEnvironment): DeviceIdentity {
  const stored = readStoredIdentity(env.dataRoot);
  if (stored) return stored;

  const existing = env.findExistingWorkstation();
  const identity: DeviceIdentity = existing
    ? {
        ...FACTORY,
        workstationId: existing.workstationId,
        workstationCode: existing.workstationCode,
        workstationName: existing.workstationName,
        deviceId: existing.deviceId,
        deviceName: existing.workstationName,
      }
    : mintIdentity(env);

  writeIdentity(env.dataRoot, identity);
  return identity;
}
