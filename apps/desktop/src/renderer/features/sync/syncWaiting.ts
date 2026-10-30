import { copy } from "../../config/copy";
import { formatDuration } from "../../utils/dates";
import type { SyncWaitCause, SyncWaiting, SyncWaitingEntry } from "../../types/desktopApi";

// WHAT THIS COMPUTER IS WAITING ON, IN WORDS (owner decision 2026-10-25, points 1 to 3).
//
// The main process reads the park (packages/sync/src/waiting.ts) and says, for each wait, what
// waits, for what, since when, and which material it leaves incomplete. This turns that into the
// three things the screens show, with no React in it so the rules are tested directly (R13):
//
//   * a mark on each stock row whose material is incomplete here -- any tier, because the row is
//     incomplete whether it has waited a minute or a week
//   * the stock screen's notice, once a material's wait has lasted (STUCK or STALE)
//   * the app-wide notice: STUCK is a warning, STALE stays up until dismissed

export const recordWord = (type: string): string =>
  copy.syncWaiting.record[type] ?? type.toLowerCase().replace(/_/g, " ");

export const waitingForWords = (cause: SyncWaitCause): string => {
  switch (cause.kind) {
    case "MISSING":
      return copy.syncWaiting.cause.missing(recordWord(cause.record), cause.id);
    case "IN_USE":
      return copy.syncWaiting.cause.inUse;
    case "NAME_TAKEN":
      return copy.syncWaiting.cause.nameTaken;
    case "DISPLACED":
      return copy.syncWaiting.cause.displaced;
    default:
      return copy.syncWaiting.cause.other(cause.code);
  }
};

export interface WaitWords {
  readonly subject: string;
  readonly waitingFor: string;
  readonly duration: string;
}

export const describeWait = (entry: SyncWaitingEntry): WaitWords => ({
  subject: copy.syncWaiting.subject(recordWord(entry.aggregateType), entry.name ?? entry.aggregateId),
  waitingFor: waitingForWords(entry.cause),
  duration: formatDuration(entry.ageMs),
});

/** Each incomplete material's oldest wait, by material id. Entries arrive oldest first. */
export const incompleteMaterials = (waiting: SyncWaiting | null): Map<string, SyncWaitingEntry> => {
  const byItem = new Map<string, SyncWaitingEntry>();
  for (const entry of waiting?.entries ?? []) {
    if (entry.itemId !== null && !byItem.has(entry.itemId)) byItem.set(entry.itemId, entry);
  }
  return byItem;
};

/** The stock screen's notice: materials whose wait has lasted, and the oldest. Null when none has. */
export const stockNotice = (incomplete: Map<string, SyncWaitingEntry>): string | null => {
  const lasting = [...incomplete.values()].filter((entry) => entry.tier !== "WAITING");
  if (lasting.length === 0) return null;
  const oldest = Math.max(...lasting.map((entry) => entry.ageMs));
  return copy.syncWaiting.stockNotice(lasting.length, formatDuration(oldest));
};

export interface AppNotice {
  readonly level: "STUCK" | "STALE";
  readonly text: string;
  /** Changes when a new wait reaches this level, so a dismissed notice comes back for it. */
  readonly signature: string;
}

/** The app-wide notice: the worst tier present, or null while every wait is under an hour. */
export const appNotice = (waiting: SyncWaiting | null): AppNotice | null => {
  if (waiting === null) return null;
  const level = waiting.stale > 0 ? "STALE" : waiting.stuck > 0 ? "STUCK" : null;
  if (level === null) return null;
  const lasting = waiting.entries.filter((entry) => entry.tier !== "WAITING");
  const oldest = formatDuration(Math.max(0, ...lasting.map((entry) => entry.ageMs)));
  const count = lasting.length;
  return {
    level,
    text: level === "STALE" ? copy.syncWaiting.staleNotice(count, oldest) : copy.syncWaiting.stuckNotice(count, oldest),
    signature: `${level}|${lasting.map((entry) => entry.dedupeKey).sort().join(",")}`,
  };
};

const isEntry = (value: unknown): value is SyncWaitingEntry => {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.dedupeKey === "string" &&
    typeof entry.aggregateType === "string" &&
    typeof entry.aggregateId === "string" &&
    typeof entry.ageMs === "number" &&
    (entry.tier === "WAITING" || entry.tier === "STUCK" || entry.tier === "STALE") &&
    typeof entry.cause === "object" && entry.cause !== null
  );
};

/** The main process's answer, checked before a screen relies on it (R25). */
export const isSyncWaiting = (value: unknown): value is SyncWaiting => {
  if (typeof value !== "object" || value === null) return false;
  const waiting = value as Record<string, unknown>;
  return (
    Array.isArray(waiting.entries) &&
    waiting.entries.every(isEntry) &&
    [waiting.waiting, waiting.stuck, waiting.stale, waiting.unsentMarks, waiting.deadLetters].every((count) => typeof count === "number")
  );
};
