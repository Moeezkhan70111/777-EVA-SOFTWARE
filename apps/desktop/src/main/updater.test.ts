// The update engine's state machine, and the promises it makes to a factory PC.
//
// electron-updater refuses to do anything in an unpackaged process, so every test here drives
// UpdateService through its AutoUpdaterPort with a fake. That is the point of the port: the
// behaviour worth testing is WHICH STATE a sequence of events leaves the machine in, and what
// the operator is allowed to do from there — not whether electron-updater can reach GitHub.

import { describe, expect, it, vi } from "vitest";
import {
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  UPDATE_TOKEN_ENV,
  UpdateService,
  describeUpdateError,
  isPermanentUpdateFailure,
  retryDelayMs,
  type AutoUpdaterPort,
  type UpdateServiceOptions,
} from "./updater";
import type { UpdaterLogger } from "./updaterLog";

/** A stand-in for electron-updater that records what it was told and can replay its events. */
class FakeUpdater implements AutoUpdaterPort {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  logger: UpdaterLogger | null = null;
  disableWebInstaller = false;
  feed: unknown = null;
  checks = 0;
  quitAndInstallCalls = 0;
  checkRejectsWith: Error | null = null;
  /** What the feed "answers" during a check: the events electron-updater would emit. */
  onCheck: (() => void) | null = null;
  /** When set, checkForUpdates waits on this instead of answering at once. */
  holdCheck: Promise<void> | null = null;
  private listeners = new Map<string, (payload: never) => void>();

  setFeedURL(options: unknown): void {
    this.feed = options;
  }
  async checkForUpdates(): Promise<unknown> {
    this.checks += 1;
    if (this.holdCheck) await this.holdCheck;
    if (this.checkRejectsWith) {
      // As the real one does: a failed check is emitted as "error" AND rejected.
      this.emit("error", this.checkRejectsWith);
      throw this.checkRejectsWith;
    }
    this.onCheck?.();
    return undefined;
  }
  quitAndInstallArgs: Array<{ isSilent: boolean; isForceRunAfter: boolean }> = [];
  quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void {
    this.quitAndInstallCalls += 1;
    this.quitAndInstallArgs.push({ isSilent, isForceRunAfter });
  }
  on(event: string, listener: (payload: never) => void): void {
    this.listeners.set(event, listener);
  }
  /** Fires an electron-updater event, as the real module would. */
  emit(event: string, payload?: unknown): void {
    const listener = this.listeners.get(event);
    if (!listener) throw new Error(`nothing is listening for "${event}"`);
    listener(payload as never);
  }
}

const logger = () => ({ log: vi.fn() });

function createService(overrides: Partial<UpdateServiceOptions> = {}) {
  const updater = overrides.updater instanceof FakeUpdater ? overrides.updater : new FakeUpdater();
  const log = logger();
  const service = new UpdateService({
    logger: log as unknown as UpdateServiceOptions["logger"],
    deviceId: "device-1",
    currentVersion: "0.3.1",
    isPackaged: true,
    token: "a-read-only-token",
    repository: { owner: "Moeezkhan70111", repo: "777-EVA-SOFTWARE" },
    updater,
    // Timers are captured, never armed: nothing in a test should wait 90 seconds.
    setTimer: () => 0 as unknown as NodeJS.Timeout,
    clearTimer: () => undefined,
    ...overrides,
    ...(overrides.updater ? {} : { updater }),
  });
  return { service, updater: updater as FakeUpdater, log };
}

describe("when updates cannot run at all", () => {
  it("is DISABLED in a development build, and says why without blaming the operator", () => {
    const { service } = createService({ isPackaged: false });
    service.start();
    const status = service.status();
    expect(status.phase).toBe("DISABLED");
    expect(status.reason).toMatch(/development build/i);
  });

  it("is DISABLED with no token, and names the variable an administrator must set", () => {
    const { service } = createService({ token: undefined });
    service.start();
    expect(service.status().phase).toBe("DISABLED");
    expect(service.status().reason).toContain(UPDATE_TOKEN_ENV);
  });

  it("treats a blank token as no token — a set-but-empty variable is the likelier mistake", () => {
    const { service } = createService({ token: "   " });
    service.start();
    expect(service.status().phase).toBe("DISABLED");
  });

  it("never touches the updater when disabled, so nothing can be configured by accident", () => {
    const { service, updater } = createService({ isPackaged: false });
    service.start();
    expect(updater.feed).toBeNull();
    expect(updater.checks).toBe(0);
  });

  it("reports the running version even when disabled", () => {
    const { service } = createService({ isPackaged: false });
    service.start();
    expect(service.status().currentVersion).toBe("0.3.1");
  });

  it("refuses to install when disabled", async () => {
    const { service } = createService({ token: undefined });
    service.start();
    expect(service.installNow().accepted).toBe(false);
    await expect(service.checkNow()).resolves.toMatchObject({ phase: "DISABLED" });
  });
});

describe("configuration handed to electron-updater", () => {
  it("downloads in the background and installs on quit, so an update never waits on a prompt", () => {
    const { service, updater } = createService();
    service.start();
    expect(updater.autoDownload).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(true);
  });

  it("points at the private repository with this computer's token", () => {
    const { service, updater } = createService();
    service.start();
    expect(updater.feed).toEqual({
      provider: "github",
      owner: "Moeezkhan70111",
      repo: "777-EVA-SOFTWARE",
      private: true,
      token: "a-read-only-token",
    });
  });
});

describe("the happy path an office PC walks", () => {
  it("goes CHECKING -> DOWNLOADING -> READY and carries the version through", async () => {
    const { service, updater } = createService();
    service.start();
    expect(service.status().phase).toBe("IDLE");

    const checking = service.checkNow();
    updater.emit("update-available", { version: "0.3.2" });
    expect(service.status().phase).toBe("DOWNLOADING");
    expect(service.status().availableVersion).toBe("0.3.2");

    updater.emit("download-progress", { percent: 42.6 });
    expect(service.status().percent).toBe(43);

    updater.emit("update-downloaded", { version: "0.3.2" });
    await checking;
    expect(service.status().phase).toBe("READY");
    expect(service.status().percent).toBe(100);
    expect(service.status().availableVersion).toBe("0.3.2");
  });

  it("installs only once a build is actually on disk", () => {
    const { service, updater } = createService();
    service.start();

    // THE DANGEROUS CASE: quitAndInstall with nothing downloaded closes the application and
    // installs nothing, which to an operator is indistinguishable from a crash.
    expect(service.installNow()).toMatchObject({ accepted: false });
    expect(updater.quitAndInstallCalls).toBe(0);

    updater.emit("update-downloaded", { version: "0.3.2" });
    expect(service.installNow()).toMatchObject({ accepted: true });
    expect(updater.quitAndInstallCalls).toBe(1);
  });

  it("installs without asking anything, and starts the new version afterwards", () => {
    const { service, updater } = createService();
    service.start();
    updater.emit("update-downloaded", { version: "0.3.3" });

    expect(service.installNow()).toMatchObject({ accepted: true });

    // HOW 0.3.3 FAILED ON 2026-10-23. The defaults are (false, false): the installer shows its
    // UI and nothing restarts the app. With the assisted installer that was configured then,
    // that meant a wizard nobody could complete -- the app quit, a prompt appeared, and the
    // install never happened. The log said "Restarting to install version 0.3.3" and the next
    // startup reported v0.3.2.
    //
    // isSilent      no dialog, no wizard: nothing for an operator to answer.
    // isForceRunAfter  777 ERP comes back by itself, instead of leaving a dark screen.
    expect(updater.quitAndInstallArgs).toEqual([{ isSilent: true, isForceRunAfter: true }]);
  });

  it("reports UP_TO_DATE without inventing a version", async () => {
    const { service, updater } = createService();
    service.start();
    const checking = service.checkNow();
    updater.emit("update-not-available", { version: "0.3.1" });
    await checking;
    expect(service.status().phase).toBe("UP_TO_DATE");
    expect(service.status().availableVersion).toBeUndefined();
  });

  it("records when a check last finished, so the UI never has to guess", async () => {
    const { service, updater } = createService();
    service.start();
    expect(service.status().lastCheckedAt).toBeUndefined();
    const checking = service.checkNow();
    updater.emit("update-not-available", {});
    await checking;
    expect(service.status().lastCheckedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("failures, none of which may cost a downloaded build", () => {
  it("a failed check becomes ERROR, and the ERP is never blocked", async () => {
    const { service, updater } = createService();
    service.start();
    updater.checkRejectsWith = new Error("getaddrinfo ENOTFOUND github.com");
    await service.checkNow();
    expect(service.status().phase).toBe("ERROR");
    expect(service.status().reason).toMatch(/internet could not be reached/i);
  });

  it("KEEPS a downloaded update when a later check fails", async () => {
    const { service, updater } = createService();
    service.start();
    updater.emit("update-downloaded", { version: "0.3.2" });
    expect(service.status().phase).toBe("READY");

    // The office internet drops after the download. The build on disk is still good, and still
    // installs on quit — forgetting it would strand the PC on the old version for no reason.
    updater.emit("error", new Error("ECONNRESET"));
    expect(service.status().phase).toBe("READY");
    expect(service.installNow().accepted).toBe(true);
  });

  it("does not sit in CHECKING forever when a check answers nothing", async () => {
    const { service } = createService();
    service.start();
    await service.checkNow();
    expect(service.status().phase).toBe("IDLE");
  });

  it("keeps checking behind a READY build, because a newer release may have been published since", async () => {
    const { service, updater } = createService();
    service.start();
    updater.emit("update-downloaded", { version: "0.3.2" });
    const before = updater.checks;
    await service.checkNow();
    expect(updater.checks).toBe(before + 1);
    expect(service.status().phase).toBe("READY");
  });

  it("survives a feed that cannot be configured at all", () => {
    const broken = new FakeUpdater();
    broken.setFeedURL = () => {
      throw new Error("app-update.yml is missing");
    };
    const { service } = createService({ updater: broken });
    // start() must not throw: the window opens either way.
    expect(() => service.start()).not.toThrow();
    expect(service.status().phase).toBe("ERROR");
  });

  it("ignores a malformed payload rather than rendering junk as a version", () => {
    const { service, updater } = createService();
    service.start();
    updater.emit("update-available", { version: 42 });
    expect(service.status().availableVersion).toBeUndefined();
    updater.emit("download-progress", { percent: "lots" });
    expect(service.status().percent).toBeUndefined();
  });

  it("clamps a progress percentage so the UI can render it blindly", () => {
    const { service, updater } = createService();
    service.start();
    updater.emit("download-progress", { percent: -5 });
    expect(service.status().percent).toBe(0);
    updater.emit("download-progress", { percent: 140 });
    expect(service.status().percent).toBe(100);
  });
});

describe("error messages an operator reads", () => {
  // THE SECURITY PROPERTY: for a private repository electron-updater's messages can carry the
  // credential in a URL, so messages are translated, never echoed.
  it("never passes a raw message through, so a token in a URL cannot leak into the UI", () => {
    const leaky = new Error("Cannot download https://api.github.com/repos/x?access_token=ghp_SECRETVALUE");
    expect(describeUpdateError(leaky)).not.toContain("ghp_SECRETVALUE");
    expect(describeUpdateError(leaky)).not.toContain("api.github.com");
  });

  it.each([
    ["HTTP 404 Not Found", /no complete new version could be found on github yet/i],
    ["HttpError: 403 API rate limit exceeded", /slow down/i],
    ["401 Bad credentials", /credential was refused/i],
    ["getaddrinfo EAI_AGAIN", /internet could not be reached/i],
    ["sha512 checksum mismatch", /integrity check/i],
  ])("translates %s into something actionable", (raw, expected) => {
    expect(describeUpdateError(new Error(raw))).toMatch(expected);
  });

  it("falls back to a plain connection problem for anything unrecognised", () => {
    expect(describeUpdateError(new Error("\u0000 weird"))).toMatch(/could not be reached/i);
    expect(describeUpdateError(undefined)).toMatch(/could not be reached/i);
  });
});

describe("a computer that has quietly stopped receiving versions", () => {
  const DAY = 24 * 60 * 60 * 1000;

  /** A history store backed by a plain value, as app_settings is in the real thing. */
  const history = (lastSuccessAt: string | null) => {
    let stored = lastSuccessAt;
    return {
      readLastSuccessAt: () => stored,
      writeLastSuccessAt: (iso: string) => {
        stored = iso;
      },
      current: () => stored,
    };
  };

  it("says nothing about a fresh installation that has never checked", () => {
    const store = history(null);
    const { service } = createService({ history: store });
    service.start();
    // A machine installed yesterday has not failed at anything.
    expect(service.status().stalled).toBe(false);
  });

  it("says nothing while checks are succeeding", async () => {
    const store = history(null);
    const { service, updater } = createService({ history: store });
    service.start();
    const checking = service.checkNow();
    updater.emit("update-not-available", {});
    await checking;
    expect(store.current()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(service.status().stalled).toBe(false);
  });

  it("says nothing after a few bad days — the office internet drops constantly", () => {
    const now = Date.now();
    const store = history(new Date(now - 4 * DAY).toISOString());
    const { service } = createService({ history: store, now: () => now });
    service.start();
    expect(service.status().stalled).toBe(false);
    expect(service.status().lastSuccessAt).toBe(store.current());
  });

  it("becomes visible after a week without a successful check", () => {
    const now = Date.now();
    const store = history(new Date(now - 8 * DAY).toISOString());
    const { service } = createService({ history: store, now: () => now });
    service.start();
    expect(service.status().stalled).toBe(true);
    expect(service.status().stalledDays).toBe(8);
  });

  it("becomes visible in two days when the credential was refused, which never self-heals", async () => {
    const now = Date.now();
    const store = history(new Date(now - 3 * DAY).toISOString());
    const { service, updater } = createService({ history: store, now: () => now });
    service.start();
    // Three days is under the ordinary seven-day threshold.
    expect(service.status().stalled).toBe(false);

    updater.checkRejectsWith = new Error("HTTP 401 Bad credentials");
    await service.checkNow();
    // An expired or revoked token will fail identically forever; waiting out the week adds
    // nothing but an older build on the factory floor.
    expect(service.status().stalled).toBe(true);
  });

  it("a later success clears it", async () => {
    let now = Date.now();
    const store = history(new Date(now - 10 * DAY).toISOString());
    const { service, updater } = createService({ history: store, now: () => now });
    service.start();
    expect(service.status().stalled).toBe(true);

    const checking = service.checkNow();
    updater.emit("update-not-available", {});
    await checking;
    now += 1000;
    expect(service.status().stalled).toBe(false);
  });

  it("never reports a stall on a computer where updates are switched off", () => {
    const now = Date.now();
    const store = history(new Date(now - 30 * DAY).toISOString());
    // No token. "This computer has no update credential" is already said by `reason`; calling it
    // a stall as well would say the same thing twice, more alarmingly.
    const { service } = createService({ history: store, now: () => now, token: undefined });
    service.start();
    expect(service.status().phase).toBe("DISABLED");
    expect(service.status().stalled).toBe(false);
  });

  it("ignores a stored timestamp that is nonsense rather than reporting a fake stall", () => {
    const { service } = createService({ history: history("not a date") });
    service.start();
    expect(service.status().stalled).toBe(false);
  });
});

describe("discarding a downloaded update", () => {
  it("refuses when nothing is downloaded", () => {
    const { service } = createService();
    service.start();
    expect(service.discardDownloaded()).toMatchObject({ accepted: false });
  });

  it("removes the staged build and stops it installing on quit", () => {
    const removeStagedDownload = vi.fn();
    const { service, updater } = createService({ removeStagedDownload });
    service.start();
    updater.emit("update-downloaded", { version: "0.3.2" });
    expect(updater.autoInstallOnAppQuit).toBe(true);

    expect(service.discardDownloaded()).toMatchObject({ accepted: true });
    expect(removeStagedDownload).toHaveBeenCalledTimes(1);
    // THE POINT: without this, a bad build already on disk installs at the end of the shift even
    // after the release has been deleted.
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(service.status().phase).toBe("IDLE");
    expect(service.status().availableVersion).toBeUndefined();
    // And it can no longer be installed by pressing Restart.
    expect(service.installNow().accepted).toBe(false);
  });
});

describe("which failures will never fix themselves", () => {
  it.each([
    ["HTTP 401 Bad credentials", true],
    ["403 Forbidden", true],
    // A release still being assembled, or none yet: it resolves on its own (it used to be "permanent").
    ["HTTP 404 Not Found", false],
    ["HttpError: 403 API rate limit exceeded for user", false],
    ["getaddrinfo ENOTFOUND github.com", false],
    ["ETIMEDOUT", false],
    ["sha512 mismatch", false],
  ])("%s -> permanent: %s", (raw, expected) => {
    expect(isPermanentUpdateFailure(new Error(raw))).toBe(expected);
  });
});

describe("timers", () => {
  it("schedules the first check 15 seconds after startup (was 90)", () => {
    // Typed with its real signature so the delay can be asserted, not just the call count.
    const setTimer = vi.fn((_handler: () => void, _ms: number) => 1 as unknown as NodeJS.Timeout);
    const { service } = createService({ setTimer });
    service.start();
    expect(setTimer).toHaveBeenCalledTimes(1);
    expect(setTimer.mock.calls[0][1]).toBe(15_000);
    expect(FIRST_CHECK_DELAY_MS).toBe(15_000);
  });

  it("stops cleanly, so a pending check cannot fire into a closing process", () => {
    const clearTimer = vi.fn();
    const { service } = createService({ setTimer: () => 7 as unknown as NodeJS.Timeout, clearTimer });
    service.start();
    service.stop();
    expect(clearTimer).toHaveBeenCalledWith(7);
  });
});

/** Timers that are captured, never armed, and can be fired by hand — so nothing waits two minutes. */
function handTimers() {
  type Armed = { id: number; handler: () => void; ms: number; done: boolean };
  const armed: Armed[] = [];
  let nextId = 1;
  const pending = () => armed.filter((timer) => !timer.done);
  return {
    setTimer: (handler: () => void, ms: number) => {
      armed.push({ id: nextId, handler, ms, done: false });
      nextId += 1;
      return (nextId - 1) as unknown as NodeJS.Timeout;
    },
    clearTimer: (id: NodeJS.Timeout) => {
      const timer = armed.find((candidate) => candidate.id === (id as unknown as number));
      if (timer) timer.done = true;
    },
    pending,
    /** The delay of the one timer waiting, or null. */
    nextDelay: () => pending().at(-1)?.ms ?? null,
    /** Fires the waiting timer and lets the check it starts finish. */
    fire: async () => {
      const timer = pending().at(-1);
      if (!timer) throw new Error("no timer is armed");
      timer.done = true;
      timer.handler();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

const network = () => new Error("net::ERR_INTERNET_DISCONNECTED getaddrinfo ENOTFOUND api.github.com");

/** A gate a fake check waits on, opened by hand. */
const gate = () => {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open: () => open() };
};

function scheduled(overrides: Partial<UpdateServiceOptions> = {}) {
  const timers = handTimers();
  const made = createService({ setTimer: timers.setTimer, clearTimer: timers.clearTimer, ...overrides });
  made.service.start();
  return { ...made, timers };
}

const messagesOf = (log: { log: ReturnType<typeof vi.fn> }) =>
  log.log.mock.calls.map(([entry]) => entry as { operation: string; message: string; severity: string });

describe("how often it checks (13 Nov 2026: 15 s, then every 2 minutes)", () => {
  it("checks 15 s after launch, then every two minutes after a completed check", async () => {
    const { updater, timers } = scheduled();
    expect(timers.nextDelay()).toBe(15_000);
    updater.onCheck = () => updater.emit("update-not-available", {});
    await timers.fire();
    expect(updater.checks).toBe(1);
    expect(timers.nextDelay()).toBe(2 * 60 * 1000);
    expect(CHECK_INTERVAL_MS).toBe(120_000);
    await timers.fire();
    expect(updater.checks).toBe(2);
    expect(timers.pending()).toHaveLength(1);
  });

  it("never runs two checks at once, however often it is asked", async () => {
    const { service, updater } = scheduled();
    const held = gate();
    updater.holdCheck = held.promise;
    const first = service.checkNow();
    await service.checkNow();
    held.open();
    await first;
    expect(updater.checks).toBe(1);
  });

  it("does not interrupt a download: a check that comes due is skipped and the next one armed", async () => {
    const { updater, timers } = scheduled();
    updater.emit("update-available", { version: "0.3.2" });
    await timers.fire();
    expect(updater.checks).toBe(0);
    expect(timers.nextDelay()).toBe(CHECK_INTERVAL_MS);
  });

  it("a press during a download answers with the download, without checking", async () => {
    const { service, updater } = scheduled();
    updater.emit("update-available", { version: "0.3.2" });
    updater.emit("download-progress", { percent: 30 });
    await expect(service.checkNow()).resolves.toMatchObject({ phase: "DOWNLOADING", percent: 30 });
    expect(updater.checks).toBe(0);
  });

  it("keeps ONE timer: a press re-arms it rather than adding a second", async () => {
    const { service, updater, timers } = scheduled();
    updater.onCheck = () => updater.emit("update-not-available", {});
    await service.checkNow();
    expect(timers.pending()).toHaveLength(1);
    expect(timers.nextDelay()).toBe(CHECK_INTERVAL_MS);
  });

  it("stops re-arming once stopped, even if a check finishes afterwards", async () => {
    const { service, updater, timers } = scheduled();
    const held = gate();
    updater.holdCheck = held.promise;
    const checking = service.checkNow();
    service.stop();
    held.open();
    await checking;
    expect(timers.pending()).toHaveLength(0);
  });
});

describe("retrying after a failure", () => {
  it("backs off 1, 2, 4, 8, then 10 minutes, and never longer", async () => {
    expect([1, 2, 3, 4, 5, 9].map(retryDelayMs)).toEqual([60_000, 120_000, 240_000, 480_000, 600_000, 600_000]);
    const { updater, timers } = scheduled();
    updater.checkRejectsWith = network();
    const delays: Array<number | null> = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await timers.fire();
      delays.push(timers.nextDelay());
    }
    expect(delays).toEqual([60_000, 120_000, 240_000, 480_000, 600_000, 600_000]);
  });

  it("counts a failed check once, although electron-updater both emits and rejects it", async () => {
    const { service, updater } = scheduled();
    updater.checkRejectsWith = network();
    await service.checkNow();
    expect(service.status().consecutiveFailures).toBe(1);
    expect(service.status().failure).toBe("CHECK");
  });

  it("goes back to the two-minute interval after a successful check", async () => {
    const { service, updater, timers } = scheduled();
    updater.checkRejectsWith = network();
    await timers.fire();
    await timers.fire();
    expect(timers.nextDelay()).toBe(120_000);
    updater.checkRejectsWith = null;
    updater.onCheck = () => updater.emit("update-not-available", {});
    await timers.fire();
    expect(service.status().consecutiveFailures).toBe(0);
    expect(timers.nextDelay()).toBe(CHECK_INTERVAL_MS);
  });

  it("treats a 404 (a release still being published) as temporary, not as 'nothing published'", async () => {
    const now = Date.now();
    const threeDaysAgo = new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString();
    const store = { readLastSuccessAt: () => threeDaysAgo, writeLastSuccessAt: () => undefined };
    const { service, updater, timers } = scheduled({ history: store, now: () => now });
    updater.checkRejectsWith = new Error("Cannot find latest.yml in the latest release artifacts: HttpError: 404 Not Found");
    await timers.fire();
    const status = service.status();
    expect(status.phase).toBe("ERROR");
    expect(status.failure).toBe("CHECK");
    expect(status.reason).not.toMatch(/no published version/i);
    // Retried in a minute, and NOT counted toward the two-day "credential refused" warning.
    expect(timers.nextDelay()).toBe(60_000);
    expect(status.stalled).toBe(false);
  });

  it("calls a refused credential a CONFIGURATION failure, and still retries it", async () => {
    const { service, updater, timers } = scheduled();
    updater.checkRejectsWith = new Error("HttpError: 401 Bad credentials");
    await timers.fire();
    expect(service.status().failure).toBe("CONFIGURATION");
    expect(timers.nextDelay()).toBe(60_000);
  });
});

describe("a download that is interrupted", () => {
  it("becomes a DOWNLOAD failure, retries in a minute, and recovers on the retry", async () => {
    const { service, updater, timers } = scheduled();
    updater.emit("update-available", { version: "0.3.2" });
    updater.emit("download-progress", { percent: 40 });
    updater.emit("error", new Error("net::ERR_CONNECTION_RESET ECONNRESET"));
    expect(service.status()).toMatchObject({ phase: "ERROR", failure: "DOWNLOAD", availableVersion: "0.3.2" });
    expect(service.status().reason).toMatch(/0\.3\.2 could not be downloaded/);
    expect(timers.nextDelay()).toBe(60_000);

    updater.onCheck = () => {
      updater.emit("update-available", { version: "0.3.2" });
      updater.emit("download-progress", { percent: 100 });
      updater.emit("update-downloaded", { version: "0.3.2" });
    };
    await timers.fire();
    expect(service.status()).toMatchObject({ phase: "READY", consecutiveFailures: 0 });
    expect(service.status().failure).toBeUndefined();
  });

  it("keeps backing off when the download keeps failing, although each retry finds the version", async () => {
    const { updater, timers } = scheduled();
    updater.onCheck = () => updater.emit("update-available", { version: "0.3.2" });
    updater.emit("update-available", { version: "0.3.2" });
    updater.emit("error", new Error("ECONNRESET"));
    expect(timers.nextDelay()).toBe(60_000);
    await timers.fire();
    updater.emit("error", new Error("ECONNRESET"));
    expect(timers.nextDelay()).toBe(120_000);
  });
});

describe("download progress", () => {
  it("reports real progress, and logs it at 25, 50 and 75 percent only", () => {
    const { service, updater, log } = scheduled();
    updater.emit("update-available", { version: "0.3.2" });
    expect(service.status()).toMatchObject({ phase: "DOWNLOADING", percent: 0 });
    for (const percent of [5, 20, 26, 30, 49, 51, 74, 76, 99]) {
      updater.emit("download-progress", { percent, transferred: percent * 1_048_576, total: 100 * 1_048_576, bytesPerSecond: 2_097_152 });
    }
    expect(service.status().percent).toBe(99);
    const progressLines = messagesOf(log).map((entry) => entry.message).filter((message) => message.startsWith("Downloading 0.3.2"));
    expect(progressLines).toEqual([
      "Downloading 0.3.2: 26% (26.0 of 100.0 MB, 2.0 MB/s).",
      "Downloading 0.3.2: 51% (51.0 of 100.0 MB, 2.0 MB/s).",
      "Downloading 0.3.2: 76% (76.0 of 100.0 MB, 2.0 MB/s).",
    ]);
  });
});

describe("a newer release published after one was downloaded", () => {
  it("leaves READY for the newer version, refuses to install the older, then offers the newer", async () => {
    const { service, updater } = scheduled();
    updater.emit("update-downloaded", { version: "0.3.2" });
    updater.onCheck = () => updater.emit("update-available", { version: "0.3.3" });
    await service.checkNow();
    expect(service.status()).toMatchObject({ phase: "DOWNLOADING", availableVersion: "0.3.3", percent: 0 });
    // electron-updater has deleted 0.3.2's staged file to fetch 0.3.3: restarting now would install nothing.
    expect(service.installNow().accepted).toBe(false);
    expect(updater.quitAndInstallCalls).toBe(0);

    updater.emit("update-downloaded", { version: "0.3.3" });
    expect(service.status()).toMatchObject({ phase: "READY", availableVersion: "0.3.3" });
    expect(service.installNow().accepted).toBe(true);
  });

  it("stays READY, without flickering through CHECKING, when the recheck finds the same version", async () => {
    const { service, updater, log } = scheduled();
    updater.emit("update-downloaded", { version: "0.3.2" });
    const phasesSeen: string[] = [];
    updater.onCheck = () => {
      phasesSeen.push(service.status().phase);
      updater.emit("update-available", { version: "0.3.2" });
      phasesSeen.push(service.status().phase);
      updater.emit("update-downloaded", { version: "0.3.2" });
    };
    const logsBefore = log.log.mock.calls.length;
    await service.checkNow();
    expect(phasesSeen).toEqual(["READY", "READY"]);
    expect(service.status().phase).toBe("READY");
    // Nothing new happened, so nothing new is written to app.log every two minutes.
    expect(log.log.mock.calls.length).toBe(logsBefore);
  });

  it("keeps a READY build when a recheck fails, and does not count it as a failure", async () => {
    const { service, updater, timers } = scheduled();
    updater.emit("update-downloaded", { version: "0.3.2" });
    updater.checkRejectsWith = network();
    await service.checkNow();
    expect(service.status()).toMatchObject({ phase: "READY", consecutiveFailures: 0 });
    expect(timers.nextDelay()).toBe(CHECK_INTERVAL_MS);
  });

  it("never discards a build by itself when its release disappears — that is an administrator's decision", async () => {
    const removeStagedDownload = vi.fn();
    const { service, updater, log } = scheduled({ removeStagedDownload });
    updater.emit("update-downloaded", { version: "0.3.2" });
    // The 0.3.2 release was deleted on GitHub: the feed's newest is now the running version.
    updater.onCheck = () => updater.emit("update-not-available", { version: "0.3.1" });
    await service.checkNow();
    await service.checkNow();
    expect(removeStagedDownload).not.toHaveBeenCalled();
    expect(updater.autoInstallOnAppQuit).toBe(true);
    expect(service.status()).toMatchObject({ phase: "READY", availableVersion: "0.3.2" });
    expect(service.installNow().accepted).toBe(true);
    // Said once in app.log, not on every two-minute check.
    const warnings = messagesOf(log).filter((entry) => entry.message.includes("no longer the latest published release"));
    expect(warnings).toHaveLength(1);
  });
});

describe("an administrator's discard, with checks every two minutes", () => {
  it("still discards on request: the staged file goes and nothing installs on quit", () => {
    const removeStagedDownload = vi.fn();
    const { service, updater } = scheduled({ removeStagedDownload });
    updater.emit("update-downloaded", { version: "0.3.2" });
    expect(service.discardDownloaded()).toMatchObject({ accepted: true });
    expect(removeStagedDownload).toHaveBeenCalledTimes(1);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(service.installNow().accepted).toBe(false);
  });

  it("is not undone when a later check fetches the same discarded version again", () => {
    const { service, updater } = scheduled({ removeStagedDownload: vi.fn() });
    updater.emit("update-downloaded", { version: "0.3.2" });
    service.discardDownloaded();
    updater.emit("update-available", { version: "0.3.2" });
    updater.emit("update-downloaded", { version: "0.3.2" });
    expect(updater.autoInstallOnAppQuit).toBe(false);
  });

  it("lets a different, newer version install on quit again", () => {
    const { service, updater } = scheduled({ removeStagedDownload: vi.fn() });
    updater.emit("update-downloaded", { version: "0.3.2" });
    service.discardDownloaded();
    updater.emit("update-available", { version: "0.3.3" });
    updater.emit("update-downloaded", { version: "0.3.3" });
    expect(updater.autoInstallOnAppQuit).toBe(true);
    expect(service.status()).toMatchObject({ phase: "READY", availableVersion: "0.3.3" });
  });
});

describe("Restart never installs an outdated download", () => {
  it("refuses while a newer version is replacing the staged one, whatever the progress", async () => {
    const { service, updater } = scheduled();
    updater.emit("update-downloaded", { version: "0.3.2" });
    updater.onCheck = () => updater.emit("update-available", { version: "0.3.3" });
    await service.checkNow();
    for (const percent of [0, 50, 99]) {
      updater.emit("download-progress", { percent });
      expect(service.installNow().accepted).toBe(false);
    }
    // A failed newer download does not bring the deleted older build back either.
    updater.emit("error", new Error("ECONNRESET"));
    expect(service.status()).toMatchObject({ phase: "ERROR", failure: "DOWNLOAD", availableVersion: "0.3.3" });
    expect(service.installNow().accepted).toBe(false);
    expect(updater.quitAndInstallCalls).toBe(0);
  });
});

describe("electron-updater's own log", () => {
  it("is connected to app.log, with routine lines dropped and secrets removed", () => {
    const { updater, log } = scheduled();
    expect(updater.disableWebInstaller).toBe(true);
    expect(updater.logger).not.toBeNull();
    updater.logger?.info("Checking for update");
    updater.logger?.info("Found version 0.3.2 (url: https://github.com/o/r/releases/download/v0.3.2/x.exe?X-Amz-Signature=abc)");
    updater.logger?.warn("request failed for a-read-only-token");
    const lines = messagesOf(log).filter((entry) => entry.operation === "electron-updater");
    expect(lines.map((line) => line.message)).toEqual([
      "Found version 0.3.2 (url: https://github.com/o/r/releases/download/v0.3.2/x.exe)",
      "request failed for [redacted]",
    ]);
    expect(lines[1].severity).toBe("WARNING");
  });
});
