// Where this computer's cloud settings come from, and what is allowed to be in them.
//
// Four environment variables, read in the MAIN process only. Nothing here is compiled into the
// application, committed, or handed to the renderer:
//
//   ERP_SUPABASE_URL        https://<project-ref>.supabase.co
//   ERP_SUPABASE_ANON_KEY   the publishable (anon) key
//   ERP_DEVICE_EMAIL        this computer's device account
//   ERP_DEVICE_PASSWORD     its password
//
// THE ANON KEY IS MEANT TO SHIP. It identifies the project, not a person, and it is worth
// nothing on its own here: migration 004 gives anon no policy and revokes its table privileges.
// What does the work is the device account's access token, and Row Level Security reads that.
//
// THE SERVICE ROLE KEY MUST NEVER BE USED. It bypasses Row Level Security completely. A key with
// that shape is refused below rather than quietly accepted, because the failure it would cause
// is silent: everything would appear to work, with every protection switched off.
//
// Sync does nothing at all unless all four are present. An installation with none of them is a
// local-only ERP, exactly as it is today.

export interface CloudSyncConfig {
  readonly url: string;
  readonly anonKey: string;
  /**
   * The device account's email and password. ABSENT once this computer holds an encrypted
   * credential: the password is a first-run input, and a provisioned machine signs in from its
   * stored refresh token instead. See readCloudSyncConfig.
   */
  readonly email?: string;
  readonly password?: string;
  /** A refresh token read from this computer's encrypted credential, tried before the password. */
  readonly refreshToken?: string;
}

export type CloudSyncConfigResult =
  | { readonly configured: true; readonly config: CloudSyncConfig }
  | { readonly configured: false; readonly problems: readonly string[] };

export const CLOUD_ENV_KEYS = [
  "ERP_SUPABASE_URL",
  "ERP_SUPABASE_ANON_KEY",
  "ERP_DEVICE_EMAIL",
  "ERP_DEVICE_PASSWORD",
] as const;

/** A JWT whose payload names the service_role. Never acceptable in this application. */
function isServiceRoleKey(key: string): boolean {
  const parts = key.split(".");
  if (parts.length !== 3) return false;
  try {
    const payload = Buffer.from(parts[1] ?? "", "base64url").toString("utf8");
    return /"role"\s*:\s*"service_role"/.test(payload);
  } catch {
    return false;
  }
}

/** Loopback is allowed so a test service can be pointed at. Anything else must be https. */
function isAcceptableUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  } catch {
    return false;
  }
}

/**
 * The environment a child process should be given: everything this one has, minus the four
 * variables above.
 *
 * The main process reads its cloud settings from the environment, and anything it spawns
 * inherits that environment by default — so the PowerShell scanner probe would be handed the
 * device account's password for no reason at all, and it would show up in that child's own
 * environment block for anything able to read it. Nothing spawned by this application has any
 * use for these four, so nothing spawned by it is given them.
 *
 * Built HERE, beside the list it filters, so adding a fifth cloud variable cannot quietly start
 * leaking into child processes because a second copy of the list was missed.
 *
 * Everything else is preserved exactly: PATH, SystemRoot and ComSpec are what let powershell.exe
 * start and find its own device queries at all, and stripping anything beyond the four named
 * secrets would break the probe rather than protect it.
 *
 * Names are matched case-insensitively: Windows environment variables are, and a variable set
 * as `erp_device_password` is the same secret as `ERP_DEVICE_PASSWORD`.
 */
export function childProcessEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const excluded = new Set<string>(CLOUD_ENV_KEYS.map((key) => key.toLowerCase()));
  const safe: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || excluded.has(name.toLowerCase())) continue;
    safe[name] = value;
  }
  return safe;
}

export function readCloudSyncConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: { hasStoredCredential?: boolean } = {}
): CloudSyncConfigResult {
  const values = Object.fromEntries(CLOUD_ENV_KEYS.map((key) => [key, (env[key] ?? "").trim()])) as Record<
    (typeof CLOUD_ENV_KEYS)[number],
    string
  >;

  const problems: string[] = [];
  for (const key of CLOUD_ENV_KEYS) {
    // THE PASSWORD IS A FIRST-RUN INPUT, not a permanent setting.
    //
    // Once this computer holds an encrypted credential, it signs in from the refresh token in it
    // and the password has no further use -- so requiring it forever would defeat the point of
    // persisting one. The caller passes `hasStoredCredential` when the credential store holds a
    // usable credential for this device, and the password stops being required.
    //
    // The url and the anon key stay required either way: they say WHICH project this is, and a
    // stored refresh token is worthless without them.
    if (key === "ERP_DEVICE_PASSWORD" && options.hasStoredCredential) continue;
    if (key === "ERP_DEVICE_EMAIL" && options.hasStoredCredential) continue;
    if (values[key] === "") problems.push(`${key} is not set`);
  }
  if (problems.length > 0) return { configured: false, problems };

  if (!isAcceptableUrl(values.ERP_SUPABASE_URL)) {
    problems.push("ERP_SUPABASE_URL must be an https address (http is allowed only for 127.0.0.1)");
  }
  if (isServiceRoleKey(values.ERP_SUPABASE_ANON_KEY)) {
    problems.push(
      "ERP_SUPABASE_ANON_KEY is a service_role key. That key bypasses every security policy and must never be given to the application -- use the publishable (anon) key"
    );
  }
  if (problems.length > 0) return { configured: false, problems };

  return {
    configured: true,
    config: {
      url: values.ERP_SUPABASE_URL,
      anonKey: values.ERP_SUPABASE_ANON_KEY,
      // Empty rather than absent when this computer is running from a stored credential: the
      // auth layer treats a blank password as "no password", tries the refresh token, and says so
      // plainly if that is refused and there is nothing to fall back to.
      email: values.ERP_DEVICE_EMAIL === "" ? undefined : values.ERP_DEVICE_EMAIL,
      password: values.ERP_DEVICE_PASSWORD === "" ? undefined : values.ERP_DEVICE_PASSWORD,
    },
  };
}

/**
 * What may be shown to an operator or written to the log: the project's host and the account
 * name, and nothing else. Never the key, never the password.
 */
export function describeCloudSyncConfig(result: CloudSyncConfigResult): {
  configured: boolean;
  host?: string;
  email?: string;
  problems?: readonly string[];
} {
  if (!result.configured) return { configured: false, problems: result.problems };
  let host = "";
  try {
    host = new URL(result.config.url).host;
  } catch {
    host = "";
  }
  return { configured: true, host, email: result.config.email };
}
