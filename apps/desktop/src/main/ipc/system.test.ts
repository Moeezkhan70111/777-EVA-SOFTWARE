// @vitest-environment node
import type { IpcMainInvokeEvent } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLOUD_ENV_KEYS } from "../cloudConfig";
import { IPC } from "../../shared/ipcChannels";
import type { IpcContext } from "./context";
import { registerSystemHandlers } from "./system";

// WHAT THE SCANNER PROBE IS HANDED.
//
// This is the only child process the application starts. By default a child inherits the whole
// environment, and this one's parent holds the cloud device account's password -- so a PnP
// device query would be given a secret it has no use for, sitting in its own environment block
// for anything able to read it.
//
// These prove the probe is given an explicit environment with those four names removed and
// everything else intact, and that nothing else about it moved: the same executable, the same
// arguments, the same timeout, and the same true/false answer.

const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    },
  },
  app: { getVersion: () => "0.3.0" },
}));

interface ExecFileCall {
  file: string;
  args: readonly string[];
  options: { timeout?: number; windowsHide?: boolean; env?: NodeJS.ProcessEnv };
}

let calls: ExecFileCall[];
let stdout: string;
let execFileThrows: Error | null;

vi.mock("node:child_process", () => ({
  execFile: (
    file: string,
    args: readonly string[],
    options: ExecFileCall["options"],
    callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void
  ) => {
    calls.push({ file, args, options });
    if (execFileThrows !== null) callback(execFileThrows);
    else callback(null, { stdout, stderr: "" });
  },
}));

// Obviously fake. Nothing here is a real credential, and no assertion below prints a value.
const FAKE_CLOUD_ENV: Record<string, string> = {
  ERP_SUPABASE_URL: "https://zzdisposable.supabase.co",
  ERP_SUPABASE_ANON_KEY: "zz-not-a-real-anon-key",
  ERP_DEVICE_EMAIL: "device@example.invalid",
  ERP_DEVICE_PASSWORD: "zz-not-a-real-password",
};
const MARKER = "ERP_SYSTEM_TEST_MARKER";

const windowEvent = { sender: { id: 1 } } as unknown as IpcMainInvokeEvent;

/** Only the fields registerSystemHandlers destructures. Nothing here is called by the probe. */
const buildContext = (): IpcContext =>
  ({
    db: {},
    logger: { log: () => undefined },
    authorizer: { requireUser: () => undefined, requireAdmin: () => undefined },
    deviceId: "device-under-test",
    paths: {},
    useCases: {
      processScanUseCase: {},
      dispatchScanUseCase: {},
      returnScanUseCase: {},
      storeEntryScanUseCase: {},
      storeExitScanUseCase: {},
      createGatepassUseCase: {},
      cancelGatepassUseCase: {},
    },
  }) as unknown as IpcContext;

const probe = async (): Promise<boolean> => {
  const handler = handlers.get(IPC.scannerStatus);
  if (!handler) throw new Error("the scanner handler was not registered");
  return (await handler(windowEvent)) as boolean;
};

const childEnv = (): NodeJS.ProcessEnv => {
  expect(calls).toHaveLength(1);
  const env = calls[0]?.options.env;
  expect(env).toBeDefined();
  return env as NodeJS.ProcessEnv;
};

beforeEach(() => {
  handlers.clear();
  calls = [];
  stdout = "True\n";
  execFileThrows = null;
  for (const [key, value] of Object.entries(FAKE_CLOUD_ENV)) process.env[key] = value;
  process.env[MARKER] = "present";
  registerSystemHandlers(buildContext());
});

afterEach(() => {
  for (const key of Object.keys(FAKE_CLOUD_ENV)) delete process.env[key];
  delete process.env[MARKER];
});

describe("the scanner probe's child process", () => {
  it("is given an explicit environment rather than inheriting this one", async () => {
    await probe();
    expect(calls[0]?.options.env).toBeDefined();
    expect(calls[0]?.options.env).not.toBe(process.env);
  });

  it("is handed none of the four cloud variables", async () => {
    await probe();
    const names = Object.keys(childEnv());
    // Asserted on NAMES only: a failure here must not print a value.
    for (const key of CLOUD_ENV_KEYS) expect(names).not.toContain(key);
    expect(CLOUD_ENV_KEYS).toHaveLength(4);
  });

  it("keeps everything else this process has, so powershell.exe can still run", async () => {
    await probe();
    const child = childEnv();
    const expected = Object.keys(process.env)
      .filter((name) => !(CLOUD_ENV_KEYS as readonly string[]).includes(name))
      .sort();
    expect(Object.keys(child).sort()).toEqual(expected);

    // The ones a Windows process actually needs, named explicitly. Looked up case-insensitively
    // on purpose: `process.env` is a special object that ignores case on Windows, while the copy
    // handed to the child is an ordinary one that carries Windows's own casing (SYSTEMROOT, say).
    // Nothing is lost -- the key-set comparison above proves that -- and the child's own
    // variable lookups are case-insensitive against the environment block it is given.
    const lookup = (name: string): string | undefined =>
      Object.entries(child).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
    for (const required of ["PATH", "SystemRoot", "ComSpec"]) {
      if (process.env[required] !== undefined) expect(lookup(required)).toBe(process.env[required]);
    }
    // And an unrelated variable is carried through untouched.
    expect(child[MARKER]).toBe("present");
  });

  it("still runs the same command, with the same arguments and the same timeout", async () => {
    await probe();
    const call = calls[0];
    expect(call?.file).toBe("powershell.exe");
    expect(call?.args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
    expect(call?.args).toHaveLength(4);
    // The PnP query itself is unchanged: the scanner's MAC and its cradle's VID/PID.
    expect(call?.args[3]).toContain("C47DCC16FAE5");
    expect(call?.args[3]).toContain("VID_05E0.*PID_1200");
    expect(call?.args[3]).toContain("Get-PnpDevice");
    expect(call?.options.timeout).toBe(5000);
    expect(call?.options.windowsHide).toBe(true);
  });

  it("answers exactly as it did before", async () => {
    await expect(probe()).resolves.toBe(true);

    calls = [];
    stdout = "False\n";
    await expect(probe()).resolves.toBe(false);

    calls = [];
    stdout = "  TRUE  ";
    await expect(probe()).resolves.toBe(true);
  });

  it("answers false when the probe cannot run, and says nothing about the environment", async () => {
    execFileThrows = new Error("powershell.exe is not available");
    await expect(probe()).resolves.toBe(false);
  });
});
