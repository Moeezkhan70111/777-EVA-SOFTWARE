import { safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";
// Type-only, so this stays a one-way dependency: deviceIdentity.ts keeps its distance from
// Electron and knows nothing about where a credential is kept.
import type { CredentialState } from "./deviceIdentity";

// This computer's cloud credential, kept where a copy of the folder cannot use it.
//
// WHY THIS EXISTS. Every other thing that says which machine this is can be copied:
// `device-identity.json` is plain JSON, the `workstations` row travels inside every backup, and
// the four environment variables are typed by whoever starts the app. A copied UUID proves
// nothing. Electron's safeStorage (DPAPI on Windows) encrypts against the signed-in OS user on
// this machine, so the ciphertext written here is the one artefact a second computer cannot
// read — and that makes it the only thing worth rooting a device's cloud identity in.
//
// It is modelled directly on sessionStore.ts, which already keeps the signed-in user's token
// this way, including its rule that nothing is persisted when OS encryption is unavailable.
//
// WHAT IS KEPT: the Supabase refresh token for this computer's own device account, the account
// it belongs to, and the deviceId it was provisioned for. NEVER a password. The password is a
// first-run provisioning input only; once this file exists the application has no further use
// for it, and it should not stay in the environment.
//
// WHAT IS NOT DONE HERE, deliberately:
//
//   * nothing is logged. A store that never writes a line cannot leak one.
//   * nothing is returned to the renderer. The main process holds this and nothing bridges it.
//   * the file is never read into a backup: a backup is `VACUUM INTO` of the database alone.
//   * no automatic clearing. See below.
//
// REMOVAL IS AN EXPLICIT ACT. `resetLocalData` wipes the database, the product images and the
// saved sign-ins, and it deliberately does not touch this file or `device-identity.json` —
// wiping the local data must not turn a computer into a different computer, and must not force
// an owner to re-enrol it in the cloud just because they cleared a test database. `clear()` is
// the only way out, and it belongs to a deliberate revocation or re-enrolment, nothing else.
//
// WHO CALLS THIS. main.ts reads the credential state while resolving this installation's
// identity, and ipc/cloudSync.ts reads the stored token before a pass and writes back whatever
// the sign-in returns -- which is what makes the device password a first-run input rather than a
// permanent setting. Re-enrolment and revocation are still an owner-side act: see clear().

/** Beside `session.bin` in the data root. `resetLocalData` does not delete it — see above. */
export const DEVICE_CREDENTIAL_FILE_NAME = "device-credential.bin";

export interface DeviceCredential {
  /** The Supabase Auth user this computer signs in as. Not a person. */
  readonly authUserId: string;
  /** The local deviceId this credential was provisioned for, from device-identity.json. */
  readonly deviceId: string;
  /** Long-lived, and the reason this file is encrypted. Never leaves the main process. */
  readonly refreshToken: string;
  /** When the exchange happened, ISO 8601 UTC. */
  readonly provisionedAt: string;
}

/** Everything about the credential that is safe to show an operator or write to a log. */
export interface DeviceCredentialSummary {
  readonly present: boolean;
  readonly authUserId?: string;
  readonly deviceId?: string;
  readonly provisionedAt?: string;
}

/** Why a save did not happen. A caller has to be able to tell these apart. */
export type SaveOutcome = "SAVED" | "ENCRYPTION_UNAVAILABLE" | "INVALID" | "WRITE_FAILED";

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/**
 * A stored credential, or null. Null for every unusable case without distinguishing them,
 * because every one of them means the same thing to a caller: this computer is not enrolled and
 * must not sync. A credential that cannot be read is never a different credential.
 */
const parse = (text: string): DeviceCredential | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (
    !isNonEmptyString(record.authUserId) ||
    !isNonEmptyString(record.deviceId) ||
    !isNonEmptyString(record.refreshToken) ||
    !isNonEmptyString(record.provisionedAt)
  ) {
    return null;
  }
  return {
    authUserId: record.authUserId,
    deviceId: record.deviceId,
    refreshToken: record.refreshToken,
    provisionedAt: record.provisionedAt,
  };
};

export class DeviceCredentialStore {
  private readonly filePath: string;

  constructor(directory: string) {
    this.filePath = path.join(directory, DEVICE_CREDENTIAL_FILE_NAME);
  }

  /** Where the credential lives. For a diagnostic that needs to name the file, never its contents. */
  get path(): string {
    return this.filePath;
  }

  /**
   * Whether this machine can encrypt at all. False on a system without OS key storage, and the
   * reason cloud sync refuses to start there rather than falling back to a readable file.
   */
  canPersist(): boolean {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      // A throwing API is an unavailable one.
      return false;
    }
  }

  /**
   * This computer's credential, or null when there is none, encryption is unavailable, the file
   * belongs to another machine or user, or it cannot be read as a complete credential.
   *
   * A decrypt that fails is the normal, expected signal that the data folder was copied, the
   * Windows profile changed, or the machine was re-imaged. It is never repaired automatically:
   * re-provisioning silently would hand a copied folder a working identity.
   */
  load(): DeviceCredential | null {
    if (!this.canPersist() || !fs.existsSync(this.filePath)) return null;
    try {
      return parse(safeStorage.decryptString(fs.readFileSync(this.filePath)));
    } catch {
      return null;
    }
  }

  /** True when a usable credential for this machine is present. */
  has(): boolean {
    return this.load() !== null;
  }

  /**
   * How this machine's credential looks to identity resolution.
   *
   * ABSENT and UNREADABLE are kept apart because they mean different things to an owner, even
   * though both refuse adoption identically: ABSENT is "never enrolled", UNREADABLE is "there
   * is something here that this machine cannot read" — a copied data folder, a different
   * Windows user, a re-imaged PC, or a truncated file.
   *
   * NO OS KEY STORAGE IS ALSO UNREADABLE, not absent. Without it a restored backup cannot be
   * told from the original machine, so adoption is refused rather than guessed at. The cost is
   * that a legitimate same-machine recovery on a system with no key store mints a fresh
   * identity instead of adopting; the ERP is unaffected either way.
   *
   * Reads only. Nothing here saves, clears, mints or rotates a credential.
   */
  credentialState(): CredentialState {
    if (!this.canPersist()) return { kind: "UNREADABLE" };
    if (!fs.existsSync(this.filePath)) return { kind: "ABSENT" };
    const stored = this.load();
    return stored === null ? { kind: "UNREADABLE" } : { kind: "PRESENT", deviceId: stored.deviceId };
  }

  /** True when the stored credential was provisioned for this installation's deviceId. */
  matchesDevice(deviceId: string): boolean {
    const stored = this.load();
    return stored !== null && stored.deviceId === deviceId;
  }

  /** What may be shown or logged. Never the token, whatever the caller asks for. */
  summary(): DeviceCredentialSummary {
    const stored = this.load();
    if (stored === null) return { present: false };
    return {
      present: true,
      authUserId: stored.authUserId,
      deviceId: stored.deviceId,
      provisionedAt: stored.provisionedAt,
    };
  }

  /**
   * Stores the credential, replacing any previous one.
   *
   * Written to a temporary file and renamed, unlike sessionStore's direct write: a torn write
   * there costs a sign-in, and here it would cost an enrolment that only the owner can restore.
   */
  save(credential: DeviceCredential): SaveOutcome {
    if (
      !isNonEmptyString(credential.authUserId) ||
      !isNonEmptyString(credential.deviceId) ||
      !isNonEmptyString(credential.refreshToken) ||
      !isNonEmptyString(credential.provisionedAt)
    ) {
      return "INVALID";
    }
    if (!this.canPersist()) return "ENCRYPTION_UNAVAILABLE";

    const temporary = `${this.filePath}.tmp`;
    try {
      fs.writeFileSync(temporary, safeStorage.encryptString(JSON.stringify(credential)));
      fs.renameSync(temporary, this.filePath);
      return "SAVED";
    } catch {
      // Leave no half-written credential and no stray temporary behind.
      fs.rmSync(temporary, { force: true });
      return "WRITE_FAILED";
    }
  }

  /**
   * Forgets this computer's credential.
   *
   * THE ONLY WAY A CREDENTIAL IS REMOVED. It belongs to a deliberate revocation or
   * re-enrolment. Resetting the local data does not call it, failing to decrypt does not call
   * it, and a failed sign-in does not call it — a computer that cannot reach the cloud today is
   * not a computer that should need enrolling again tomorrow.
   */
  clear(): void {
    fs.rmSync(this.filePath, { force: true });
    fs.rmSync(`${this.filePath}.tmp`, { force: true });
  }
}
