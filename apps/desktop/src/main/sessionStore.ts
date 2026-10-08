import { safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";
import { SESSION_FILE_NAME } from "./runtimePaths";

// Persisted sign-in state for the desktop app: the active session token plus the saved
// multi-account profiles shown in the profile switcher. Kept in the main process,
// encrypted at rest with Electron's safeStorage (DPAPI on Windows), so the renderer never
// writes a token to localStorage. When OS encryption is unavailable nothing is persisted
// and the operator simply signs in again after a restart.

export interface StoredProfile {
  id: string;
  username: string;
  token: string;
  role: "USER" | "ADMIN";
  lastUsedAt?: string;
}

export interface StoredSessionState {
  activeToken: string | null;
  profiles: StoredProfile[];
}

const EMPTY: StoredSessionState = { activeToken: null, profiles: [] };

const isProfile = (value: unknown): value is StoredProfile => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.username === "string" &&
    typeof record.token === "string" &&
    (record.role === "USER" || record.role === "ADMIN")
  );
};

export class SessionStore {
  private readonly filePath: string;

  constructor(directory: string) {
    this.filePath = path.join(directory, SESSION_FILE_NAME);
  }

  private canPersist(): boolean {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  load(): StoredSessionState {
    if (!this.canPersist() || !fs.existsSync(this.filePath)) return { ...EMPTY, profiles: [] };
    try {
      const decrypted = safeStorage.decryptString(fs.readFileSync(this.filePath));
      const parsed: unknown = JSON.parse(decrypted);
      if (typeof parsed !== "object" || parsed === null) return { ...EMPTY, profiles: [] };
      const record = parsed as Record<string, unknown>;
      const profiles = Array.isArray(record.profiles) ? record.profiles.filter(isProfile) : [];
      const activeToken = typeof record.activeToken === "string" && record.activeToken ? record.activeToken : null;
      return { activeToken, profiles };
    } catch {
      return { ...EMPTY, profiles: [] };
    }
  }

  private write(state: StoredSessionState): void {
    if (!this.canPersist()) return;
    fs.writeFileSync(this.filePath, safeStorage.encryptString(JSON.stringify(state)));
  }

  /** Makes `profile` the active session and remembers it in the profile list. */
  setActive(profile: StoredProfile): StoredSessionState {
    const current = this.load();
    const others = current.profiles.filter(
      (item) => item.username.toLowerCase() !== profile.username.toLowerCase() && item.token !== profile.token
    );
    const next: StoredSessionState = {
      activeToken: profile.token,
      profiles: [{ ...profile, lastUsedAt: profile.lastUsedAt ?? new Date().toISOString() }, ...others],
    };
    this.write(next);
    return next;
  }

  /** Forgets one profile (on logout or when its session has expired). */
  removeProfile(token: string): StoredSessionState {
    const current = this.load();
    const next: StoredSessionState = {
      activeToken: current.activeToken === token ? null : current.activeToken,
      profiles: current.profiles.filter((item) => item.token !== token),
    };
    this.write(next);
    return next;
  }

  /** Clears the active session but keeps the saved profiles for quick switching. */
  clearActive(): StoredSessionState {
    const next: StoredSessionState = { ...this.load(), activeToken: null };
    this.write(next);
    return next;
  }
}
