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

/**
 * What this machine's cloud credential looks like from here — the only signal in the whole
 * installation that a second computer cannot forge by copying a folder.
 *
 * ABSENT and UNREADABLE are kept apart on purpose. Both refuse adoption identically, but they
 * are different things to say to an owner: ABSENT is "this computer has never been enrolled",
 * while UNREADABLE is "there is a credential here that was written on another machine, by
 * another Windows user, or before this machine was re-imaged". The second is the one that needs
 * a recovery, and an operator cannot be told to perform one they have not been told about.
 */
export type CredentialState =
  | { readonly kind: "ABSENT" }
  | { readonly kind: "UNREADABLE" }
  | { readonly kind: "PRESENT"; readonly deviceId: string };

/** Injected, like findExistingWorkstation, so this module keeps its distance from Electron. */
export type DeviceCredentialCheck = () => CredentialState;

/** Where the identity came from. For a log line and for the tests, never persisted. */
export type IdentitySource = "STORED" | "ADOPTED" | "MINTED";

/**
 * Whether this installation may speak to the cloud as itself.
 *
 * Never written to device-identity.json. It is a conclusion about the machine the application
 * is running on right now, and a persisted copy of it would be the first thing a copied folder
 * would carry across.
 */
export type EnrolmentState =
  | { readonly enrolled: true }
  | {
      readonly enrolled: false;
      readonly reason: "NO_CREDENTIAL" | "CREDENTIAL_UNREADABLE" | "CREDENTIAL_FOR_ANOTHER_DEVICE";
    };

export interface ResolvedInstallation {
  readonly identity: DeviceIdentity;
  readonly source: IdentitySource;
  readonly enrolment: EnrolmentState;
}

export interface DeviceIdentityEnvironment {
  dataRoot: string;
  /** Reads one workstation row from the database, or null on a fresh install. */
  findExistingWorkstation: () => ExistingWorkstation | null;
  /**
   * This machine's credential. Left out means there is none — which is what every installation
   * looks like until provisioning exists, and is why leaving it out changes nothing today
   * except that a database is no longer adopted on trust.
   */
  credential?: DeviceCredentialCheck;
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

/** Whether a credential authorises adopting THIS workstation — not merely some workstation. */
const credentialAuthorises = (state: CredentialState, candidate: ExistingWorkstation): boolean =>
  state.kind === "PRESENT" && state.deviceId === candidate.deviceId;

const enrolmentFor = (state: CredentialState, identity: DeviceIdentity): EnrolmentState => {
  if (state.kind === "ABSENT") return { enrolled: false, reason: "NO_CREDENTIAL" };
  if (state.kind === "UNREADABLE") return { enrolled: false, reason: "CREDENTIAL_UNREADABLE" };
  if (state.deviceId !== identity.deviceId) {
    return { enrolled: false, reason: "CREDENTIAL_FOR_ANOTHER_DEVICE" };
  }
  return { enrolled: true };
};

/**
 * This installation's identity, created once and stable thereafter, plus whether this machine
 * may act as it in the cloud.
 *
 * Order matters:
 *   1. the stored file, if it is present and complete;
 *   2. otherwise the workstation this database already has — but ONLY when the credential on
 *      this machine proves this is that same computer (see below);
 *   3. otherwise a fresh identity.
 *
 * The result is written back in cases 2 and 3, so step 1 answers every later launch. Writing it
 * down is not enrolment: a freshly minted identity is recorded so the machine stops changing
 * its mind on every restart, and stays unenrolled until an owner enrols it.
 *
 * WHY STEP 2 IS GATED. A backup is a copy of the database and nothing else, so the
 * `workstations` row inside it travels to whatever machine the file is restored on. Adopting it
 * on sight meant a restored backup silently became the computer it came from: same workstation
 * id, same device id, and every scan afterwards recorded under another machine's name. A UUID
 * inside a file that copies freely proves nothing about which computer is running.
 *
 * So adoption now needs the one artefact that does not copy — a credential encrypted against
 * this OS user on this machine — AND that credential must name the very workstation being
 * adopted. A credential for a different device does not authorise taking this one.
 *
 * NOTHING IS DELETED when adoption is refused. The old `workstations` row stays exactly where
 * it is, every `production_events` row still points at it, and the fresh identity simply takes
 * a new row beside it. History keeps referring to the machine that made it.
 *
 * AND THE ERP KEEPS WORKING. A missing, unreadable or foreign credential costs this computer
 * its cloud enrolment and nothing else: it still resolves an identity, still satisfies
 * `workstations(id)`, still scans, bills and prints.
 */
export function resolveInstallation(env: DeviceIdentityEnvironment): ResolvedInstallation {
  const credential: CredentialState = env.credential ? env.credential() : { kind: "ABSENT" };

  const stored = readStoredIdentity(env.dataRoot);
  if (stored) {
    return { identity: stored, source: "STORED", enrolment: enrolmentFor(credential, stored) };
  }

  const existing = env.findExistingWorkstation();
  const adopt = existing !== null && credentialAuthorises(credential, existing);
  const identity: DeviceIdentity = adopt
    ? {
        ...FACTORY,
        // production_events.workstation_id is a foreign key to workstations(id): a computer
        // that has proved it is this one keeps the identity its own history refers to.
        workstationId: existing.workstationId,
        workstationCode: existing.workstationCode,
        workstationName: existing.workstationName,
        deviceId: existing.deviceId,
        deviceName: existing.workstationName,
      }
    : mintIdentity(env);

  writeIdentity(env.dataRoot, identity);
  return {
    identity,
    source: adopt ? "ADOPTED" : "MINTED",
    enrolment: enrolmentFor(credential, identity),
  };
}

/**
 * This installation's identity. The same resolution as `resolveInstallation`, for callers that
 * need only the identity itself.
 */
export function resolveDeviceIdentity(env: DeviceIdentityEnvironment): DeviceIdentity {
  return resolveInstallation(env).identity;
}

/** What a startup line may say about this installation. Five non-secret facts, and no more. */
export interface InstallationLogPayload {
  readonly source: IdentitySource;
  readonly workstationId: string;
  readonly enrolled: boolean;
  /** A short machine-readable refusal, or null when enrolled. Never free text. */
  readonly reason: string | null;
  /** Whether this machine has OS key storage at all — the difference between "no credential"
   *  and "cannot read one". */
  readonly secureStorage: boolean;
}

/**
 * The startup line's payload, built here so it can be tested.
 *
 * WHAT IT MUST NEVER CARRY: the refresh token, the auth user id, anything out of the credential
 * file, and the claim holder — which cannot reach here in any case, since it lives only in the
 * transport's memory for the length of one pass and is never written down. A log is read by
 * support, pasted into messages and kept for months; it is the last place a secret should
 * reach, and the easiest to leak one through by adding "just one more useful field".
 *
 * The device id is deliberately absent: the log entry carries it as its own `deviceId` field,
 * and repeating it here would only invite the two to disagree.
 */
export function describeInstallation(
  installation: ResolvedInstallation,
  secureStorage: boolean
): InstallationLogPayload {
  return {
    source: installation.source,
    workstationId: installation.identity.workstationId,
    enrolled: installation.enrolment.enrolled,
    reason: installation.enrolment.enrolled ? null : installation.enrolment.reason,
    secureStorage,
  };
}
