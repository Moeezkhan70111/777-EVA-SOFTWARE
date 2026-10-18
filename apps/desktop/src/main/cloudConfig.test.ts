// @vitest-environment node
import { describe, expect, it } from "vitest";
import { CLOUD_ENV_KEYS, childProcessEnv, describeCloudSyncConfig, readCloudSyncConfig } from "./cloudConfig";

// WHAT THIS COMPUTER IS ALLOWED TO BE TOLD ABOUT THE CLOUD.
//
// Two things matter here and neither is cosmetic: a computer with incomplete settings must do
// nothing rather than half-sync, and a service_role key must be refused outright. That key
// bypasses every Row Level Security policy, so accepting it would make everything appear to
// work with every protection switched off -- the worst possible failure, because it is silent.

const ANON_PAYLOAD = Buffer.from(JSON.stringify({ role: "anon", iss: "supabase" })).toString("base64url");
const SERVICE_PAYLOAD = Buffer.from(JSON.stringify({ role: "service_role", iss: "supabase" })).toString("base64url");
const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");

const anonKey = `${header}.${ANON_PAYLOAD}.signature`;
const serviceRoleKey = `${header}.${SERVICE_PAYLOAD}.signature`;

const complete = {
  ERP_SUPABASE_URL: "https://project-ref.supabase.co",
  ERP_SUPABASE_ANON_KEY: anonKey,
  ERP_DEVICE_EMAIL: "pc1@example.invalid",
  ERP_DEVICE_PASSWORD: "not-a-real-password",
};

describe("cloud sync configuration", () => {
  it("accepts a complete set and keeps the values together", () => {
    const result = readCloudSyncConfig(complete);
    expect(result.configured).toBe(true);
    if (result.configured) {
      expect(result.config.url).toBe("https://project-ref.supabase.co");
      expect(result.config.email).toBe("pc1@example.invalid");
    }
  });

  it("does nothing at all when a setting is missing, and names which", () => {
    for (const key of CLOUD_ENV_KEYS) {
      const partial = { ...complete, [key]: "" };
      const result = readCloudSyncConfig(partial);
      expect(result.configured, `${key} missing must not be configured`).toBe(false);
      if (!result.configured) expect(result.problems.join(" ")).toContain(key);
    }
  });

  it("treats an empty environment as a local-only installation, not an error", () => {
    const result = readCloudSyncConfig({});
    expect(result.configured).toBe(false);
    if (!result.configured) expect(result.problems).toHaveLength(CLOUD_ENV_KEYS.length);
  });

  it("REFUSES a service_role key", () => {
    const result = readCloudSyncConfig({ ...complete, ERP_SUPABASE_ANON_KEY: serviceRoleKey });
    expect(result.configured).toBe(false);
    if (!result.configured) {
      expect(result.problems.join(" ")).toContain("service_role");
      expect(result.problems.join(" ")).toContain("bypasses");
    }
  });

  it("insists on https, except on loopback where a test service may live", () => {
    expect(readCloudSyncConfig({ ...complete, ERP_SUPABASE_URL: "http://project-ref.supabase.co" }).configured).toBe(false);
    expect(readCloudSyncConfig({ ...complete, ERP_SUPABASE_URL: "not a url" }).configured).toBe(false);
    expect(readCloudSyncConfig({ ...complete, ERP_SUPABASE_URL: "http://127.0.0.1:54321" }).configured).toBe(true);
  });

  it("describes the setup without ever exposing the key or the password", () => {
    const described = describeCloudSyncConfig(readCloudSyncConfig(complete));
    expect(described).toEqual({ configured: true, host: "project-ref.supabase.co", email: "pc1@example.invalid" });

    const asText = JSON.stringify(described);
    expect(asText).not.toContain(anonKey);
    expect(asText).not.toContain("not-a-real-password");
  });

  it("describes a missing setup as problems, still without values", () => {
    const described = describeCloudSyncConfig(readCloudSyncConfig({ ...complete, ERP_DEVICE_PASSWORD: "" }));
    expect(described.configured).toBe(false);
    expect(described.problems?.join(" ")).toContain("ERP_DEVICE_PASSWORD");
    expect(JSON.stringify(described)).not.toContain(anonKey);
  });
});


// WHAT A SPAWNED CHILD IS ALLOWED TO SEE.
//
// This process reads its cloud settings from the environment, and anything it spawns inherits
// that environment by default -- so a PnP device query would be handed the device account's
// password for no reason, and it would sit in that child's environment block. Nothing this
// application spawns has any use for the four, and nothing it spawns is given them.

describe("the environment handed to a child process", () => {
  it("contains none of the four cloud variables", () => {
    const parent = {
      PATH: "C:\Windows\System32",
      ERP_SUPABASE_URL: "https://project-ref.supabase.co",
      ERP_SUPABASE_ANON_KEY: anonKey,
      ERP_DEVICE_EMAIL: "pc1@example.invalid",
      ERP_DEVICE_PASSWORD: "not-a-real-password",
    };
    const child = childProcessEnv(parent);
    // Asserted on NAMES, never values: a failure here must not print a secret.
    for (const key of CLOUD_ENV_KEYS) expect(Object.keys(child)).not.toContain(key);
    expect(Object.keys(child)).toEqual(["PATH"]);
  });

  it("preserves every other variable exactly, including the ones powershell.exe needs", () => {
    const parent = {
      PATH: "C:\Windows\System32;C:\Windows",
      SystemRoot: "C:\Windows",
      ComSpec: "C:\Windows\System32\cmd.exe",
      PATHEXT: ".COM;.EXE;.BAT",
      ERP_DATA_DIR: "C:\erp-devtest",
      ERP_DEVICE_PASSWORD: "not-a-real-password",
    };
    const child = childProcessEnv(parent);
    expect(child).toEqual({
      PATH: "C:\Windows\System32;C:\Windows",
      SystemRoot: "C:\Windows",
      ComSpec: "C:\Windows\System32\cmd.exe",
      PATHEXT: ".COM;.EXE;.BAT",
      // Not a secret, and the development data folder guard needs it.
      ERP_DATA_DIR: "C:\erp-devtest",
    });
  });

  it("matches the four names however they are cased, as Windows does", () => {
    const child = childProcessEnv({
      PATH: "C:\Windows",
      erp_device_password: "not-a-real-password",
      Erp_Supabase_Anon_Key: anonKey,
    });
    expect(Object.keys(child)).toEqual(["PATH"]);
  });

  it("does not disturb the environment it was given", () => {
    const parent = { PATH: "C:\Windows", ERP_DEVICE_PASSWORD: "not-a-real-password" };
    childProcessEnv(parent);
    expect(Object.keys(parent).sort()).toEqual(["ERP_DEVICE_PASSWORD", "PATH"]);
  });

  it("drops names with no value rather than passing undefined through", () => {
    const child = childProcessEnv({ PATH: "C:\Windows", EMPTY: undefined });
    expect(Object.keys(child)).toEqual(["PATH"]);
  });

  it("reads this process's environment when given none", () => {
    // Whatever this process happens to hold, the four are not in what a child would get.
    for (const key of CLOUD_ENV_KEYS) expect(Object.keys(childProcessEnv())).not.toContain(key);
  });
});
