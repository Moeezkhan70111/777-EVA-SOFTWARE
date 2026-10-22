// AUTOMATIC UPDATES — the engine, with no UI in it.
//
// A factory PC runs this unattended. Nobody on the floor will read a changelog, click through a
// wizard or know what a version number means, so the whole design is: check quietly, download
// quietly, and ask exactly one question — "restart now?" — when a build is sitting on disk ready
// to go. Everything else happens without anybody being told.
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

import type { StructuredLogger } from "@erp/data";

/** Environment variable holding this computer's read-only GitHub token. */
export const UPDATE_TOKEN_ENV = "ERP_UPDATE_TOKEN";

/**
 * How long after launch the first check waits.
 *
 * Startup is the busiest moment this process has — database open, migrations, identity, IPC —
 * and the first thing an operator does is scan. A download competing with that is felt on the
 * floor, so the check waits until the window has settled.
 */
const FIRST_CHECK_DELAY_MS = 90_000;

/** Then every four hours, which on a shift-long session means two or three quiet checks. */
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

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
 * A permanent refusal is reported far sooner, because waiting a week adds nothing.
 *
 * An expired or revoked token, or a release that was deleted, will fail identically forever.
 * Two days is enough to rule out a transient blip while still catching it inside the week.
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

export interface UpdateStatus {
  readonly phase: UpdatePhase;
  /** The version running right now. */
  readonly currentVersion: string;
  /** The version waiting, once one is known. */
  readonly availableVersion?: string;
  /** 0-100 while DOWNLOADING. */
  readonly percent?: number;
  /** Why it is DISABLED, or what went wrong when it is in ERROR. Safe to show an operator. */
  readonly reason?: string;
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
  setFeedURL(options: { provider: "github"; owner: string; repo: string; private: boolean; token: string }): void;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(): void;
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
  /** Injected so tests do not wait four hours. */
  readonly setTimer?: (handler: () => void, ms: number) => NodeJS.Timeout;
  readonly clearTimer?: (timer: NodeJS.Timeout) => void;
  /** Injected so tests do not wait seven days. */
  readonly now?: () => number;
}

/**
 * Drives electron-updater and keeps one readable status for the UI to poll.
 *
 * Polled rather than pushed: the preload bridge is invoke-only, and an "update ready" prompt
 * does not need sub-second latency. Adding the application's first main-to-renderer push channel
 * for this would be a larger change than the feature is worth.
 */
export class UpdateService {
  private phase: UpdatePhase = "IDLE";
  private availableVersion?: string;
  private percent?: number;
  private reason?: string;
  private lastCheckedAt?: string;
  private timer: NodeJS.Timeout | null = null;
  private checking = false;

  /** True when the last failure was one that will never fix itself (token, missing release). */
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

  /** Records a check that reached the service, which is what resets the stall measure. */
  private recordSuccess(): void {
    this.lastFailurePermanent = false;
    try {
      this.options.history?.writeLastSuccessAt(new Date(this.now()).toISOString());
    } catch {
      // A timestamp that cannot be stored costs only the stall warning. It must never fail the
      // check that just succeeded.
    }
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
      updater.autoDownload = true;
      // The decisive setting for a factory PC: if the operator never presses Restart, the update
      // still lands the next time the application is closed normally at the end of a shift.
      updater.autoInstallOnAppQuit = true;
      updater.setFeedURL({
        provider: "github",
        owner: repository.owner,
        repo: repository.repo,
        private: true,
        token: String(token),
      });

      updater.on("update-available", (info: never) => {
        // The feed answered, which is what "successful check" means here.
        this.recordSuccess();
        this.phase = "DOWNLOADING";
        this.percent = 0;
        this.availableVersion = readVersion(info);
        this.reason = undefined;
        this.log("INFO", `A newer version is available (${this.availableVersion ?? "unknown"}) and is downloading in the background.`);
      });
      updater.on("update-not-available", () => {
        this.recordSuccess();
        this.phase = "UP_TO_DATE";
        this.availableVersion = undefined;
        this.percent = undefined;
        this.reason = undefined;
      });
      updater.on("download-progress", (progress: never) => {
        this.phase = "DOWNLOADING";
        this.percent = readPercent(progress);
      });
      updater.on("update-downloaded", (info: never) => {
        this.recordSuccess();
        this.phase = "READY";
        this.percent = 100;
        this.availableVersion = readVersion(info) ?? this.availableVersion;
        this.reason = undefined;
        this.log("INFO", `Version ${this.availableVersion ?? "unknown"} is downloaded and will install when 777 ERP is restarted.`);
      });
      updater.on("error", (error: never) => {
        // A DOWNLOADED update must not be forgotten because a LATER check failed — the build on
        // disk is still good, and still installs on quit.
        if (this.phase === "READY") {
          this.log("WARNING", `An update check failed, but version ${this.availableVersion ?? "unknown"} is already downloaded and still ready to install.`);
          return;
        }
        this.phase = "ERROR";
        this.reason = describeUpdateError(error);
        this.lastFailurePermanent = isPermanentUpdateFailure(error);
        this.log("WARNING", `Could not check for updates: ${this.reason}`);
      });

      this.schedule(FIRST_CHECK_DELAY_MS);
    } catch (error) {
      this.phase = "ERROR";
      this.reason = describeUpdateError(error);
      this.log("WARNING", `Automatic updates could not be started: ${this.reason}`);
    }
  }

  private schedule(delayMs: number): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      void this.checkNow().finally(() => this.schedule(CHECK_INTERVAL_MS));
    }, delayMs);
  }

  /**
   * One check. Returns the status afterwards so a manual press gets an immediate answer.
   *
   * Never throws: every failure becomes a reported state. A check that finds a build already
   * downloaded leaves READY alone — there is nothing better it could do.
   */
  async checkNow(): Promise<UpdateStatus> {
    if (this.phase === "DISABLED") return this.status();
    if (this.phase === "READY") return this.status();
    if (this.checking) return this.status();

    this.checking = true;
    this.phase = "CHECKING";
    try {
      await this.options.updater.checkForUpdates();
    } catch (error) {
      this.phase = "ERROR";
      this.reason = describeUpdateError(error);
      this.lastFailurePermanent = isPermanentUpdateFailure(error);
      this.log("WARNING", `Could not check for updates: ${this.reason}`);
    } finally {
      this.checking = false;
      this.lastCheckedAt = new Date().toISOString();
      // The event handlers above move the phase on. If none fired, the check answered nothing,
      // and saying "checking" forever would be a lie.
      if (this.phase === "CHECKING") this.phase = "IDLE";
    }
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
      this.options.updater.quitAndInstall();
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
    this.phase = "IDLE";
    this.availableVersion = undefined;
    this.percent = undefined;
    this.log("INFO", `The downloaded update ${version ?? "(unknown version)"} was discarded and will not install.`);
    return { accepted: true };
  }

  /** Stops the timer. Called on quit so a pending check cannot fire into a closing process. */
  stop(): void {
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

/**
 * An update failure in words an operator can act on, with no token in it.
 *
 * electron-updater's messages carry URLs and HTTP codes, and for a private repository the URL
 * can carry the credential — so the common cases are translated rather than passed through, and
 * anything unrecognised is reported as a plain connection problem instead of echoed.
 */
/**
 * Whether a failure will go on failing identically until somebody intervenes.
 *
 * An expired or revoked token, and a release that was deleted, never recover on their own — so
 * they are reported in days rather than a week. A network failure is the opposite: it is the
 * normal state of this office's internet and says nothing about the computer's health.
 */
export function isPermanentUpdateFailure(error: unknown): boolean {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  return /401|403|404|Bad credentials|Unauthorized|Not Found/i.test(raw);
}

export function describeUpdateError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  if (/404|Not Found/i.test(raw)) {
    return "No published version was found to update to.";
  }
  if (/401|403|Bad credentials|Unauthorized/i.test(raw)) {
    return "This computer's update credential was refused. An administrator needs to renew it.";
  }
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|network/i.test(raw)) {
    return "The internet could not be reached. 777 ERP will try again later.";
  }
  if (/sha512|checksum|signature/i.test(raw)) {
    return "The downloaded update failed its integrity check and was discarded. It will be fetched again.";
  }
  return "The update service could not be reached. 777 ERP will try again later.";
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
