// AUTOMATIC UPDATES — the engine, with no UI in it.
//
// A factory PC runs this unattended. Nobody on the floor will read a changelog, click through a
// wizard or know what a version number means, so the whole design is: check quietly, download
// quietly, and ask exactly one question — "restart now?" — when a build is sitting on disk ready
// to go. The Update button in the rail shows how far a download has got.
//
// WHAT IT NEVER DOES
//
//   It never restarts the application by itself. An operator mid-scan, mid-gatepass or mid-bill
//   must not have the window vanish, so the install happens when they say so, or on the next
//   ordinary quit (autoInstallOnAppQuit).
//
//   It never gates the ERP. Every failure path here ends in a state this module reports and the
//   application ignores: no internet, no token, no release, a corrupt download — the ERP opens
//   and works exactly as it does today. An update is an improvement, never a prerequisite.
//
//   It never touches the database. Migrations are the database layer's business and run at the
//   next boot, after the new build is installed, with a backup taken first (see
//   SqliteDatabase.copyDatabaseBeforeMigrating).
//
// THE TOKEN. The releases live in a private GitHub repository, so downloading one needs a
// credential. It is read from ERP_UPDATE_TOKEN in this computer's environment and never
// committed, never logged and never sent to the renderer. A machine without it is simply a
// machine that does not update yet, and says so.
//
// ONE TIMER (13 Nov 2026). Every check, scheduled or pressed, ends by arming the next one: two
// minutes after a completed check, or the retry delay after a failure (1, 2, 4, 8, then every 10
// minutes). A download in progress is never interrupted: a check that comes due while one is
// running is skipped, and the next one is armed.

import type { StructuredLogger } from "@erp/data";
import { createUpdaterLogger, type UpdaterLogger } from "./updaterLog";

/** Environment variable holding this computer's read-only GitHub token. */
export const UPDATE_TOKEN_ENV = "ERP_UPDATE_TOKEN";

/**
 * How long after launch the first check waits.
 *
 * Long enough for the database, migrations and IPC to be up, short enough that a version
 * published while this PC was off is found before anybody has started work (owner, 13 Nov 2026:
 * "publish on GitHub, user should see update button in seconds"). Was 90 s.
 */
export const FIRST_CHECK_DELAY_MS = 15_000;

/**
 * Then every two minutes. Was four hours, which is why an update could take a morning to appear.
 *
 * A check is two small GitHub API requests (the latest release, then latest.yml). Four PCs every
 * two minutes is about 240 requests an hour against the token's 5,000.
 */
export const CHECK_INTERVAL_MS = 2 * 60 * 1000;

/** After a failure the next try comes sooner than the interval, then backs off: 1, 2, 4, 8, 10 min. */
const RETRY_FIRST_MS = 60_000;
const RETRY_MAX_MS = 10 * 60 * 1000;

/** The wait before retry number `failures` (1-based). */
export const retryDelayMs = (failures: number): number =>
  Math.min(RETRY_FIRST_MS * 2 ** Math.max(0, failures - 1), RETRY_MAX_MS);

/** Download progress is logged when it passes these percentages, not on every progress event. */
const PROGRESS_LOG_STEPS = [25, 50, 75] as const;

/**
 * How long a computer may fail to check before somebody is told.
 *
 * SILENCE IS RIGHT FOR ONE FAILURE and wrong for a fortnight. The office internet drops
 * constantly, so a failed check is not news; a PC that has silently stopped receiving versions
 * because its token expired is.
 *
 * Measured in DAYS SINCE THE LAST SUCCESS, not in consecutive failures, for two reasons. A
 * failure count resets every time the application restarts, which on a factory PC is daily — so
 * it could never reach a threshold however broken things were. And a PC that is only open a few
 * hours a day gets few checks, so a count says more about usage than about health. Wall-clock
 * time says what was actually asked: has this computer heard from the release feed recently.
 *
 * Seven days spans a working week: a token that expired on Monday is reported the following
 * Monday at the latest, and an ordinary bad week of internet never triggers it.
 */
const STALE_AFTER_DAYS = 7;

/**
 * A refused credential is reported far sooner, because waiting a week adds nothing.
 *
 * An expired or revoked token fails identically forever. Two days is enough to rule out a
 * transient blip while still catching it inside the week.
 */
const STALE_AFTER_DAYS_PERMANENT = 2;

/** The setting that survives a restart. Without persistence the measure above cannot work. */
export const LAST_UPDATE_SUCCESS_SETTING = "update.lastSuccessfulCheckAt";

export type UpdatePhase =
  /** Not running: a development build, or no token on this computer. `reason` says which. */
  | "DISABLED"
  | "IDLE"
  | "CHECKING"
  | "UP_TO_DATE"
  /** A newer build exists and is being fetched. */
  | "DOWNLOADING"
  /** Downloaded and verified. The only state that asks the operator anything. */
  | "READY"
  /** The last attempt failed. The ERP is unaffected; the next check tries again. */
  | "ERROR";

/**
 * What kind of failure an ERROR is, so the UI can offer the right thing.
 *
 *   CHECK          the feed could not be read: no internet, GitHub down, nothing published yet.
 *   DOWNLOAD       a newer version was found but its download failed or was corrupt. The Update
 *                  button offers "Retry".
 *   CONFIGURATION  the credential was refused (401/403). Retrying will not help until an
 *                  administrator renews it; it is still retried, at the slowest rate.
 *
 * All three are retried on their own.
 */
export type UpdateFailure = "CHECK" | "DOWNLOAD" | "CONFIGURATION";

export interface UpdateStatus {
  readonly phase: UpdatePhase;
  /** The version running right now. */
  readonly currentVersion: string;
  /** The version waiting, once one is known. */
  readonly availableVersion?: string;
  /** 0-100 while DOWNLOADING, from electron-updater's own progress events. */
  readonly percent?: number;
  /** Why it is DISABLED, or what went wrong when it is in ERROR. Safe to show an operator. */
  readonly reason?: string;
  /** Set only in ERROR: which kind of failure it was. */
  readonly failure?: UpdateFailure;
  /** Failures in a row since the last completed check or download; drives the retry delay. */
  readonly consecutiveFailures?: number;
  /** When a check last completed, successfully or not. */
  readonly lastCheckedAt?: string;
  /** When a check last SUCCEEDED, across restarts. Undefined if never. */
  readonly lastSuccessAt?: string;
  /**
   * True once this computer has gone too long without a successful check — the state that must
   * become visible to somebody. See STALE_AFTER_DAYS.
   */
  readonly stalled?: boolean;
  /** Whole days since the last success, when stalled. */
  readonly stalledDays?: number;
}

/**
 * Where the last-success timestamp is kept, so it survives a restart.
 *
 * A port rather than the database itself: the updater knows nothing about SQLite, and this keeps
 * it that way. main.ts passes an implementation backed by app_settings.
 */
export interface UpdateHistoryStore {
  readLastSuccessAt(): string | null;
  writeLastSuccessAt(iso: string): void;
}

/**
 * The slice of electron-updater this module uses.
 *
 * Declared here so the engine can be driven by a fake in tests: electron-updater refuses to do
 * anything in an unpackaged process, which would make every test below assert nothing.
 */
export interface AutoUpdaterPort {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  /** Where electron-updater writes its own log lines (updaterLog.ts). */
  logger?: UpdaterLogger | null;
  /** This is an NSIS installer, never a web installer; true also silences a warning per download. */
  disableWebInstaller?: boolean;
  setFeedURL(options: { provider: "github"; owner: string; repo: string; private: boolean; token: string }): void;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void;
  on(event: string, listener: (payload: never) => void): void;
}

export interface UpdateServiceOptions {
  readonly logger: StructuredLogger;
  readonly deviceId: string;
  readonly currentVersion: string;
  /** False in development; electron-updater cannot run against an unpackaged app. */
  readonly isPackaged: boolean;
  /** This computer's read-only release token, or undefined when it has none. */
  readonly token?: string;
  /** The private repository the releases live in. */
  readonly repository: { owner: string; repo: string };
  readonly updater: AutoUpdaterPort;
  /** Durable last-success timestamp. Omitted means the stall measure is disabled. */
  readonly history?: UpdateHistoryStore;
  /**
   * Deletes the staged installer electron-updater has already downloaded. Injected because the
   * folder is electron-updater's, not this module's, and because a test must not touch it.
   */
  readonly removeStagedDownload?: () => void;
  /** Injected so tests do not wait two minutes. */
  readonly setTimer?: (handler: () => void, ms: number) => NodeJS.Timeout;
  readonly clearTimer?: (timer: NodeJS.Timeout) => void;
  /** Injected so tests do not wait seven days. */
  readonly now?: () => number;
}

/**
 * Drives electron-updater and keeps one readable status for the UI to poll.
 *
 * Polled rather than pushed: the preload bridge is invoke-only. The renderer reads this every few
 * seconds (state/UpdateStatusContext.tsx); it is an in-process read of the fields below.
 */
export class UpdateService {
  private phase: UpdatePhase = "IDLE";
  private availableVersion?: string;
  private percent?: number;
  private reason?: string;
  private failure?: UpdateFailure;
  private lastCheckedAt?: string;
  private timer: NodeJS.Timeout | null = null;
  private checking = false;
  private started = false;
  private stopped = false;
  private consecutiveFailures = 0;
  private progressLogged = 0;
  /** The READY version already reported as no longer published, so it is said once, not every check. */
  private withdrawnWarnedFor?: string;
  /** The version an administrator discarded on this computer (discardDownloaded). */
  private discardedVersion?: string;

  /** True when the last failure was one that will never fix itself (a refused credential). */
  private lastFailurePermanent = false;

  private readonly setTimer: (handler: () => void, ms: number) => NodeJS.Timeout;
  private readonly clearTimer: (timer: NodeJS.Timeout) => void;
  private readonly now: () => number;

  constructor(private readonly options: UpdateServiceOptions) {
    this.setTimer = options.setTimer ?? ((handler, ms) => setTimeout(handler, ms));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
    this.now = options.now ?? (() => Date.now());
  }

  status(): UpdateStatus {
    const stall = this.assessStall();
    return {
      phase: this.phase,
      currentVersion: this.options.currentVersion,
      availableVersion: this.availableVersion,
      percent: this.percent,
      reason: this.reason,
      failure: this.phase === "ERROR" ? this.failure : undefined,
      consecutiveFailures: this.consecutiveFailures,
      lastCheckedAt: this.lastCheckedAt,
      lastSuccessAt: stall.lastSuccessAt ?? undefined,
      stalled: stall.stalled,
      stalledDays: stall.stalled ? stall.days : undefined,
    };
  }

  /**
   * Whether this computer has gone too long without hearing from the release feed.
   *
   * A computer with NO recorded success is not reported: that is a fresh installation, and a
   * machine installed yesterday has not failed at anything. It becomes reportable once the first
   * success is recorded, which happens on its first working check.
   *
   * DISABLED is never stalled either. "No token on this computer" is already reported plainly by
   * `reason`, and calling it a stall would say the same thing twice in a more alarming way.
   */
  private assessStall(): { stalled: boolean; days: number; lastSuccessAt: string | null } {
    const lastSuccessAt = this.options.history?.readLastSuccessAt() ?? null;
    if (this.phase === "DISABLED" || lastSuccessAt === null) {
      return { stalled: false, days: 0, lastSuccessAt };
    }
    const elapsedMs = this.now() - new Date(lastSuccessAt).getTime();
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return { stalled: false, days: 0, lastSuccessAt };

    const days = Math.floor(elapsedMs / (24 * 60 * 60 * 1000));
    const threshold = this.lastFailurePermanent ? STALE_AFTER_DAYS_PERMANENT : STALE_AFTER_DAYS;
    return { stalled: days >= threshold, days, lastSuccessAt };
  }

  /** Records that the feed answered, which is what resets the stall measure. */
  private recordFeedReached(): void {
    this.lastFailurePermanent = false;
    try {
      this.options.history?.writeLastSuccessAt(new Date(this.now()).toISOString());
    } catch {
      // A timestamp that cannot be stored costs only the stall warning. It must never fail the
      // check that just succeeded.
    }
  }

  /**
   * A check or a download that COMPLETED: the retry delay goes back to the ordinary interval.
   *
   * Finding an update is not enough on its own: a download that keeps failing must keep backing
   * off rather than retrying every minute because each retry found the version again.
   */
  private recordCompleted(): void {
    this.consecutiveFailures = 0;
    this.failure = undefined;
  }

  /**
   * Why this computer cannot update, or null when it can.
   *
   * Both answers are ordinary, not faults: a developer running from source, and an office PC
   * whose token has not been set yet, are both expected states.
   */
  private disabledReason(): string | null {
    if (!this.options.isPackaged) {
      return "Updates are off in a development build. Only an installed copy of 777 ERP updates itself.";
    }
    const token = this.options.token?.trim();
    if (!token) {
      return `This computer has no update credential, so it cannot download new versions. An administrator sets ${UPDATE_TOKEN_ENV} on this machine. Everything else in 777 ERP works normally.`;
    }
    return null;
  }

  /**
   * Wires the updater and schedules the first check. Safe to call once, at startup.
   *
   * Never throws: a failure to arrange updates must not stop the ERP from opening.
   */
  start(): void {
    const disabled = this.disabledReason();
    if (disabled !== null) {
      this.phase = "DISABLED";
      this.reason = disabled;
      this.log("INFO", `Automatic updates are off: ${disabled}`);
      return;
    }

    try {
      const { updater, token, repository } = this.options;
      updater.logger = createUpdaterLogger({ logger: this.options.logger, deviceId: this.options.deviceId, secrets: [String(token)] });
      updater.disableWebInstaller = true;
      updater.autoDownload = true;
      // The decisive setting for a factory PC: if the operator never presses Restart, the update
      // still lands the next time the application is closed normally at the end of a shift.
      updater.autoInstallOnAppQuit = true;
      updater.setFeedURL({ provider: "github", owner: repository.owner, repo: repository.repo, private: true, token: String(token) });
      this.listen(updater);
      this.started = true;
      this.schedule(FIRST_CHECK_DELAY_MS);
    } catch (error) {
      this.phase = "ERROR";
      this.failure = "CHECK";
      this.reason = describeUpdateError(error);
      this.log("WARNING", `Automatic updates could not be started: ${this.reason}`);
    }
  }

  private listen(updater: AutoUpdaterPort): void {
    updater.on("update-available", (info: never) => this.onUpdateAvailable(readVersion(info)));
    updater.on("update-not-available", () => this.onUpToDate());
    updater.on("download-progress", (progress: never) => this.onProgress(progress));
    updater.on("update-downloaded", (info: never) => this.onDownloaded(readVersion(info)));
    updater.on("error", (error: never) => this.onUpdaterError(error));
  }

  /**
   * The feed has a version newer than the one running.
   *
   * While a build is READY, every check finds that same version again and electron-updater
   * re-validates the staged file without downloading it: nothing changes here, so the "Restart"
   * prompt is not raised again. A DIFFERENT version means a newer release has replaced it:
   * electron-updater sees the staged file's checksum no longer matches, deletes it and downloads
   * the new one. From that moment the older build is gone and cannot be installed, so the phase
   * leaves READY and the restart is refused until the newer one is on disk.
   */
  private onUpdateAvailable(version: string | undefined): void {
    this.recordFeedReached();
    if (this.phase === "READY" && version === this.availableVersion) return;
    if (this.phase === "READY") {
      this.log("INFO", `Version ${version ?? "unknown"} has been published since ${this.availableVersion ?? "unknown"} was downloaded. It replaces it and is downloading now; ${this.availableVersion ?? "the older version"} will not be installed.`);
    } else if (this.phase !== "DOWNLOADING" || version !== this.availableVersion) {
      this.log("INFO", `A newer version is available (${version ?? "unknown"}) and is downloading in the background.`);
    }
    this.phase = "DOWNLOADING";
    this.percent = 0;
    this.progressLogged = 0;
    this.availableVersion = version;
    this.reason = undefined;
  }

  /**
   * The feed's newest version is not newer than the one running.
   *
   * With a build READY that means its release is no longer the latest published (deleted on
   * GitHub, docs/36 §A2). NOTHING IS DISCARDED HERE: throwing away a downloaded build is an
   * administrator's decision (discardDownloaded, owner 13 Nov 2026), so the build stays READY and
   * still installs as before. It is said once per version in app.log, so whoever is pulling the
   * release back knows this PC still holds it.
   */
  private onUpToDate(): void {
    this.recordFeedReached();
    this.recordCompleted();
    if (this.phase === "READY") {
      if (this.withdrawnWarnedFor !== this.availableVersion) {
        this.withdrawnWarnedFor = this.availableVersion;
        this.log("WARNING", `Version ${this.availableVersion ?? "unknown"} is downloaded here but is no longer the latest published release. It is kept and will still install unless an administrator discards it.`);
      }
      return;
    }
    this.phase = "UP_TO_DATE";
    this.availableVersion = undefined;
    this.percent = undefined;
    this.reason = undefined;
  }

  private onProgress(progress: unknown): void {
    if (this.phase === "READY") return;
    this.phase = "DOWNLOADING";
    this.percent = readPercent(progress);
    const passed = PROGRESS_LOG_STEPS.filter((step) => (this.percent ?? 0) >= step).length;
    if (passed > this.progressLogged) {
      this.progressLogged = passed;
      this.log("INFO", `Downloading ${this.availableVersion ?? "the update"}: ${describeProgress(progress)}.`);
    }
  }

  private onDownloaded(version: string | undefined): void {
    this.recordFeedReached();
    this.recordCompleted();
    // An administrator's discard turns install-on-quit off. It stays off for the version they
    // discarded, even if that same version is fetched again; a DIFFERENT version turns it back on.
    const downloaded = version ?? this.availableVersion;
    if (this.discardedVersion === undefined || downloaded !== this.discardedVersion) {
      this.options.updater.autoInstallOnAppQuit = true;
    }
    const already = this.phase === "READY" && (version ?? this.availableVersion) === this.availableVersion;
    this.phase = "READY";
    this.percent = 100;
    this.availableVersion = version ?? this.availableVersion;
    this.reason = undefined;
    if (!already) this.log("INFO", `Version ${this.availableVersion ?? "unknown"} is downloaded and will install when 777 ERP is restarted.`);
  }

  /**
   * electron-updater's error event.
   *
   * A failed CHECK both rejects checkForUpdates and emits this, so while a check is running the
   * rejection in checkNow is the one that counts it; counting both would double the backoff. What
   * arrives here otherwise is a download (or install) failure.
   */
  private onUpdaterError(error: unknown): void {
    if (this.checking) return;
    // A DOWNLOADED update must not be forgotten because a LATER step failed — the build on disk
    // is still good, and still installs on quit.
    if (this.phase === "READY") {
      this.log("WARNING", `An update step failed, but version ${this.availableVersion ?? "unknown"} is already downloaded and still ready to install.`);
      return;
    }
    this.recordFailure(error, this.phase === "DOWNLOADING" ? "DOWNLOAD" : "CHECK");
    this.scheduleNext();
  }

  private recordFailure(error: unknown, kind: "CHECK" | "DOWNLOAD"): void {
    const permanent = isPermanentUpdateFailure(error);
    this.consecutiveFailures += 1;
    this.lastFailurePermanent = permanent;
    this.failure = permanent ? "CONFIGURATION" : kind;
    this.phase = "ERROR";
    this.percent = undefined;
    this.reason = kind === "DOWNLOAD" && !permanent ? describeDownloadError(error, this.availableVersion) : describeUpdateError(error);
    const retryMinutes = Math.round(retryDelayMs(this.consecutiveFailures) / 60_000);
    this.log("WARNING", `${kind === "DOWNLOAD" ? "The update download failed" : "Could not check for updates"}: ${this.reason} Retry ${String(this.consecutiveFailures)} in ${String(retryMinutes)} min.`);
  }

  private schedule(delayMs: number): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.checkNow();
    }, delayMs);
  }

  /** Arms the one timer: the ordinary interval, or the retry delay after a failure. */
  private scheduleNext(): void {
    if (!this.started || this.stopped) return;
    this.schedule(this.consecutiveFailures > 0 ? retryDelayMs(this.consecutiveFailures) : CHECK_INTERVAL_MS);
  }

  /**
   * One check, scheduled or pressed. Returns the status afterwards so a press gets an answer.
   *
   * Never throws: every failure becomes a reported state. Never overlaps another check, and never
   * starts while a download is running — that download is the answer already.
   */
  async checkNow(): Promise<UpdateStatus> {
    if (this.phase === "DISABLED" || !this.started) return this.status();
    if (this.checking || this.phase === "DOWNLOADING") {
      if (this.timer === null) this.scheduleNext();
      return this.status();
    }
    const wasReady = this.phase === "READY";
    this.checking = true;
    // A recheck behind a READY build stays READY on screen: the Restart prompt must not flicker.
    if (!wasReady) this.phase = "CHECKING";
    try {
      await this.options.updater.checkForUpdates();
    } catch (error) {
      if (wasReady) this.log("WARNING", `An update check failed, but version ${this.availableVersion ?? "unknown"} is already downloaded and still ready to install.`);
      else this.recordFailure(error, "CHECK");
    } finally {
      this.checking = false;
      this.lastCheckedAt = new Date(this.now()).toISOString();
      // The event handlers above move the phase on. If none fired, the check answered nothing,
      // and saying "checking" forever would be a lie.
      if (this.phase === "CHECKING") this.phase = "IDLE";
    }
    this.scheduleNext();
    return this.status();
  }

  /**
   * Restarts into the downloaded version. Refused unless one is actually on disk — quitAndInstall
   * with nothing downloaded closes the application and installs nothing, which to an operator is
   * indistinguishable from a crash.
   */
  installNow(): { accepted: boolean; reason?: string } {
    if (this.phase !== "READY") {
      return { accepted: false, reason: "There is no downloaded update to install yet." };
    }
    this.log("INFO", `Restarting to install version ${this.availableVersion ?? "unknown"}.`);
    try {
      // SILENT, AND RUN AFTERWARDS. The defaults are (false, false): the installer shows its
      // UI and nothing restarts the app, so an operator sees 777 ERP vanish and has a dialog to
      // answer -- or, with the assisted installer this used to build, a wizard to complete,
      // which is how 0.3.3 failed to install at all on 2026-10-23.
      //
      // Both arguments depend on the one-click installer configured in electron-builder.yml.
      // An assisted installer ignores silence and asks anyway.
      this.options.updater.quitAndInstall(true, true);
      return { accepted: true };
    } catch (error) {
      const reason = describeUpdateError(error);
      this.log("WARNING", `The update could not be installed: ${reason}`);
      return { accepted: false, reason };
    }
  }

  /**
   * Throws away a downloaded update so it does NOT install on the next quit.
   *
   * Why this exists: deleting the release on GitHub stops other computers fetching a bad build,
   * but a computer that already downloaded it will still install it when it next closes. Without
   * this, cancelling that meant deleting `%LOCALAPPDATA%\@erpdesktop-updater\pending` by hand on
   * each machine — which is not something an operator can be asked to do.
   *
   * It only clears the staged file and this computer's state. The next check may well find the
   * same version again, so the release should be deleted or the token revoked as well; docs/36
   * §A1-A2 says so in order.
   */
  discardDownloaded(): { accepted: boolean; reason?: string } {
    if (this.phase !== "READY") {
      return { accepted: false, reason: "There is no downloaded update to discard." };
    }
    const version = this.availableVersion;
    try {
      this.options.updater.autoInstallOnAppQuit = false;
      this.options.removeStagedDownload?.();
    } catch (error) {
      const reason = describeUpdateError(error);
      this.log("WARNING", `A downloaded update could not be discarded: ${reason}`);
      return { accepted: false, reason };
    }
    this.discardedVersion = version;
    this.phase = "IDLE";
    this.availableVersion = undefined;
    this.percent = undefined;
    this.log("INFO", `The downloaded update ${version ?? "(unknown version)"} was discarded and will not install.`);
    return { accepted: true };
  }

  /** Stops the timer. Called on quit so a pending check cannot fire into a closing process. */
  stop(): void {
    this.stopped = true;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  private log(severity: "INFO" | "WARNING", message: string): void {
    this.options.logger.log({
      module: "update",
      severity,
      operation: "auto-update",
      deviceId: this.options.deviceId,
      message,
    });
  }
}

/** The version out of an electron-updater payload, without trusting its shape (R25). */
const readVersion = (info: unknown): string | undefined => {
  if (typeof info !== "object" || info === null) return undefined;
  const version = (info as { version?: unknown }).version;
  return typeof version === "string" && version.trim() !== "" ? version : undefined;
};

/** The percentage out of a progress payload, clamped so the UI can render it blindly. */
const readPercent = (progress: unknown): number | undefined => {
  if (typeof progress !== "object" || progress === null) return undefined;
  const percent = (progress as { percent?: unknown }).percent;
  if (typeof percent !== "number" || !Number.isFinite(percent)) return undefined;
  return Math.max(0, Math.min(100, Math.round(percent)));
};

const megabytes = (value: unknown): string | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? (value / (1024 * 1024)).toFixed(1) : null;

/** "50% (54.1 of 108.3 MB, 1.2 MB/s)", from whatever the payload actually carries. */
function describeProgress(progress: unknown): string {
  const record = typeof progress === "object" && progress !== null ? (progress as Record<string, unknown>) : {};
  const percent = readPercent(progress);
  const done = megabytes(record.transferred);
  const total = megabytes(record.total);
  const speed = megabytes(record.bytesPerSecond);
  const parts = [done !== null && total !== null ? `${done} of ${total} MB` : null, speed !== null ? `${speed} MB/s` : null].filter(Boolean);
  return `${percent === undefined ? "?" : String(percent)}%${parts.length > 0 ? ` (${parts.join(", ")})` : ""}`;
}

/**
 * Whether a failure will go on failing identically until somebody intervenes.
 *
 * Only a refused credential (401/403). A 404 is NOT permanent: GitHub answers 404 while a release
 * is still being assembled, or before the first one exists, and both resolve on their own; a
 * network failure is the normal state of this office's internet.
 */
export function isPermanentUpdateFailure(error: unknown): boolean {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  // GitHub also answers 403 when the hourly request limit is used up, which clears on its own.
  if (RATE_LIMITED.test(raw)) return false;
  return CREDENTIAL_REFUSED.test(raw);
}

const RATE_LIMITED = /rate limit/i;
const CREDENTIAL_REFUSED = /\b401\b|\b403\b|Bad credentials|Unauthorized|Forbidden/i;

/**
 * An update failure in words an operator can act on, with no token in it.
 *
 * electron-updater's messages carry URLs and HTTP codes, and for a private repository the URL
 * can carry the credential — so the common cases are translated rather than passed through, and
 * anything unrecognised is reported as a plain connection problem instead of echoed.
 */
export function describeUpdateError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  if (RATE_LIMITED.test(raw)) {
    return "GitHub asked 777 ERP to slow down for a while. It will try again shortly.";
  }
  if (CREDENTIAL_REFUSED.test(raw)) {
    return "This computer's update credential was refused. An administrator needs to renew it.";
  }
  if (/\b404\b|Not Found|ERR_UPDATER_CHANNEL_FILE_NOT_FOUND|ERR_UPDATER_LATEST_VERSION_NOT_FOUND/i.test(raw)) {
    return "No complete new version could be found on GitHub yet. 777 ERP will check again shortly.";
  }
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|socket hang up|network|timeout/i.test(raw)) {
    return "The internet could not be reached. 777 ERP will try again shortly.";
  }
  if (/sha512|checksum|signature/i.test(raw)) {
    return "The downloaded update failed its integrity check and was discarded. It will be fetched again.";
  }
  return "The update service could not be reached. 777 ERP will try again shortly.";
}

/** A download failure, naming the version, in the same safe words. */
function describeDownloadError(error: unknown, version: string | undefined): string {
  const cause = describeUpdateError(error);
  return `Version ${version ?? "(unknown)"} could not be downloaded. ${cause}`;
}

/**
 * The real electron-updater, loaded lazily.
 *
 * Imported here rather than at the top of the file so a development run never loads it at all:
 * electron-updater reads app-update.yml at import time and logs a complaint when there is none,
 * which is noise in every `npm run dev` session.
 */
export async function loadElectronUpdater(): Promise<AutoUpdaterPort> {
  const module = await import("electron-updater");
  // electron-updater ships CJS with a default export under NodeNext resolution.
  const candidate = (module as unknown as { autoUpdater?: unknown; default?: { autoUpdater?: unknown } });
  const instance = candidate.autoUpdater ?? candidate.default?.autoUpdater;
  if (instance === undefined) {
    throw new Error("electron-updater did not expose autoUpdater.");
  }
  return instance as AutoUpdaterPort;
}
