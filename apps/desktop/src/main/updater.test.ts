// The update engine's state machine, and the promises it makes to a factory PC.
//
// electron-updater refuses to do anything in an unpackaged process, so every test here drives
// UpdateService through its AutoUpdaterPort with a fake. That is the point of the port: the
// behaviour worth testing is WHICH STATE a sequence of events leaves the machine in, and what
// the operator is allowed to do from there — not whether electron-updater can reach GitHub.

import { describe, expect, it, vi } from "vitest";
import {
  UPDATE_TOKEN_ENV,
  UpdateService,
  describeUpdateError,
  isPermanentUpdateFailure,
  type AutoUpdaterPort,
  type UpdateServiceOptions,
} from "./updater";

/** A stand-in for electron-updater that records what it was told and can replay its events. */
class FakeUpdater implements AutoUpdaterPort {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  feed: unknown = null;
  checks = 0;
  quitAndInstallCalls = 0;
  checkRejectsWith: Error | null = null;
  private listeners = new Map<string, (payload: never) => void>();

  setFeedURL(options: unknown): void {
    this.feed = options;
  }
  checkForUpdates(): Promise<unknown> {
    this.checks += 1;
    return this.checkRejectsWith ? Promise.reject(this.checkRejectsWith) : Promise.resolve(undefined);
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

  it("does not re-check once a build is READY — there is nothing better to find", async () => {
    const { service, updater } = createService();
    service.start();
    updater.emit("update-downloaded", { version: "0.3.2" });
    const before = updater.checks;
    await service.checkNow();
    expect(updater.checks).toBe(before);
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
    ["HTTP 404 Not Found", /no published version/i],
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
    ["HTTP 404 Not Found", true],
    ["getaddrinfo ENOTFOUND github.com", false],
    ["ETIMEDOUT", false],
    ["sha512 mismatch", false],
  ])("%s -> permanent: %s", (raw, expected) => {
    expect(isPermanentUpdateFailure(new Error(raw))).toBe(expected);
  });
});

describe("timers", () => {
  it("schedules a first check well after startup, not during it", () => {
    // Typed with its real signature so the delay can be asserted, not just the call count.
    const setTimer = vi.fn((_handler: () => void, _ms: number) => 1 as unknown as NodeJS.Timeout);
    const { service } = createService({ setTimer });
    service.start();
    expect(setTimer).toHaveBeenCalledTimes(1);
    // Startup is the busiest moment this process has, and the first thing an operator does is
    // scan. The delay is what keeps a download off that.
    expect(setTimer.mock.calls[0][1]).toBeGreaterThanOrEqual(60_000);
  });

  it("stops cleanly, so a pending check cannot fire into a closing process", () => {
    const clearTimer = vi.fn();
    const { service } = createService({ setTimer: () => 7 as unknown as NodeJS.Timeout, clearTimer });
    service.start();
    service.stop();
    expect(clearTimer).toHaveBeenCalledWith(7);
  });
});
