// Which code is running: read once at startup from the file scripts/write-build-info.mjs wrote
// beside the compiled main process.
//
// Never throws and never guesses. If the file is missing or unreadable — a developer running
// before the first build, say — every field that cannot be known is null, and `dirty` stays null
// rather than false. "We do not know" must not read as "clean".

import fs from "node:fs";
import path from "node:path";

export interface BuildInfo {
  /** From apps/desktop/package.json at build time. */
  version: string | null;
  /** Full commit SHA the build was made from, or null when it could not be determined. */
  commit: string | null;
  /** First 12 characters of `commit`, for showing to an operator. */
  shortCommit: string | null;
  /** True when the tree had uncommitted or untracked changes. Null when unknown. */
  dirty: boolean | null;
  /** ISO 8601, UTC. */
  builtAt: string | null;
  /** Highest migration number the build ships, or null when unknown. */
  migrationCeiling: number | null;
}

export const UNKNOWN_BUILD_INFO: BuildInfo = {
  version: null,
  commit: null,
  shortCommit: null,
  dirty: null,
  builtAt: null,
  migrationCeiling: null,
};

const asString = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);
const asBoolean = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);
const asNumber = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/**
 * Validates whatever is in the file rather than trusting its shape — it is written by a build
 * script that may be older than this code.
 */
export function parseBuildInfo(raw: unknown): BuildInfo {
  if (typeof raw !== "object" || raw === null) return UNKNOWN_BUILD_INFO;
  const candidate = raw as Record<string, unknown>;
  const commit = asString(candidate.commit);
  return {
    version: asString(candidate.version),
    commit,
    shortCommit: asString(candidate.shortCommit) ?? (commit ? commit.slice(0, 12) : null),
    dirty: asBoolean(candidate.dirty),
    builtAt: asString(candidate.builtAt),
    migrationCeiling: asNumber(candidate.migrationCeiling),
  };
}

/** One line for the log and for an operator to read back over the phone. */
export function describeBuildInfo(info: BuildInfo): string {
  const parts = [
    info.version ? `v${info.version}` : "version unknown",
    info.shortCommit ?? "revision unknown",
  ];
  if (info.dirty === true) parts.push("DIRTY BUILD");
  if (info.dirty === null) parts.push("cleanliness unknown");
  if (info.migrationCeiling != null) parts.push(`migrations<=${info.migrationCeiling}`);
  if (info.builtAt) parts.push(`built ${info.builtAt}`);
  return parts.join(" · ");
}

export function readBuildInfo(directory: string = __dirname): BuildInfo {
  try {
    const file = path.join(directory, "build-info.json");
    if (!fs.existsSync(file)) return UNKNOWN_BUILD_INFO;
    return parseBuildInfo(JSON.parse(fs.readFileSync(file, "utf-8")));
  } catch {
    return UNKNOWN_BUILD_INFO;
  }
}
