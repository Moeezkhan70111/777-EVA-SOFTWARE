// ELECTRON-UPDATER'S OWN LOG, written into app.log.
//
// Without this electron-updater logs to the console of a packaged app, which nobody can read, so
// the lines that explain a slow or failed update (which version it found, whether it fetched a
// delta or the whole installer, why a download failed) were lost on every office PC.
//
// THREE FILTERS, because app.log has no rotation and a check now runs every two minutes:
//
//   routine   "Checking for update" and "not available" are said on every quiet check. They are
//             dropped: the service records lastCheckedAt, and a failure is logged on its own.
//   repeats   the same line again within an hour (a staged update re-validated on each check,
//             the same network error while offline) is dropped until the hour is up.
//   secrets   the token, anything shaped like a GitHub token or an Authorization value, and every
//             URL's query string (GitHub's asset redirects carry signed parameters) are removed
//             before a line is written. Lines are cut to a readable length.

import type { StructuredLogger } from "@erp/data";

/** The logger shape electron-updater accepts (its `Logger` interface). */
export interface UpdaterLogger {
  info(message?: unknown): void;
  warn(message?: unknown): void;
  error(message?: unknown): void;
  debug(message: string): void;
}

const ROUTINE = [/^Checking for update/i, /is not available \(latest version/i];
const REPEAT_WINDOW_MS = 60 * 60 * 1000;
const MAX_REMEMBERED = 200;
const MAX_LENGTH = 1500;

/** A line with every credential and query string taken out. Exported for its test. */
export function sanitizeUpdaterLine(raw: unknown, secrets: readonly string[] = []): string {
  let text = raw instanceof Error ? (raw.stack ?? raw.message) : String(raw ?? "");
  for (const secret of secrets) {
    if (secret.trim().length >= 8) text = text.split(secret).join("[redacted]");
  }
  text = text
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g, "[redacted]")
    // `authorization: token X`, `"authorization":"Bearer X"`, `token X`: the key stays, the value goes.
    .replace(/\b(authorization|token|bearer)(["']?\s*[:=]\s*["']?|\s+)(?:(?:token|bearer)\s+)?[^\s,"'}]+/gi, "$1$2[redacted]")
    .replace(/(https?:\/\/[^\s?"')]+)\?[^\s"')]*/g, "$1");
  return text.length > MAX_LENGTH ? `${text.slice(0, MAX_LENGTH)}…` : text;
}

export function createUpdaterLogger(options: {
  readonly logger: StructuredLogger;
  readonly deviceId: string;
  readonly secrets?: readonly string[];
  readonly now?: () => number;
}): UpdaterLogger {
  const now = options.now ?? (() => Date.now());
  const lastWritten = new Map<string, number>();

  const write = (severity: "INFO" | "WARNING" | "ERROR", raw: unknown) => {
    const message = sanitizeUpdaterLine(raw, options.secrets);
    if (message === "" || ROUTINE.some((pattern) => pattern.test(message))) return;
    const previous = lastWritten.get(message);
    if (previous !== undefined && now() - previous < REPEAT_WINDOW_MS) return;
    if (lastWritten.size >= MAX_REMEMBERED) lastWritten.clear();
    lastWritten.set(message, now());
    try {
      options.logger.log({ module: "update", severity, operation: "electron-updater", deviceId: options.deviceId, message });
    } catch {
      // A log line that cannot be written must never break an update.
    }
  };

  return {
    info: (message) => write("INFO", message),
    warn: (message) => write("WARNING", message),
    error: (message) => write("ERROR", message),
    // Debug lines are electron-updater's internals (each range request); not worth a disk.
    debug: () => undefined,
  };
}
