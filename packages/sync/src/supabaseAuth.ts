// Signing this computer in, as itself.
//
// One Supabase Auth account per computer — a device account the owner creates and enrols. The
// application signs in with it and holds a short-lived access token, which is what Row Level
// Security reads through auth.uid(). It never holds a service_role key: that key bypasses RLS
// entirely and must never leave the owner's hands.
//
// WHERE THE SECRETS ARE NOT. Nothing here writes a credential to disk, to a log, or to the
// renderer. The password arrives from the main process's configuration, is used once per
// sign-in, and is never stored by this class. The tokens live in memory for the life of the
// process, so closing the application forgets them. That is deliberate for this first slice:
// persisting a refresh token is a decision about where a long-lived secret lives, and the right
// place is Electron's safeStorage — the same mechanism sessionStore.ts already uses for the
// signed-in user — not a file this package writes behind the application's back.

import { HttpError, readServiceError, redactSecrets, requestJson } from "./httpJson.js";

export interface SupabaseDeviceCredentials {
  /** The project's base URL, e.g. https://<ref>.supabase.co */
  readonly url: string;
  /** The publishable (anon) key. Designed to ship in a client, and worth nothing without a policy. */
  readonly anonKey: string;
  /**
   * The device account's email and password.
   *
   * OPTIONAL, so a provisioned computer need not hold them at all. They are a FIRST-RUN input:
   * once a refresh token has been stored, this class signs in from that and the password has no
   * further use -- which is the whole point of persisting a credential, and why it must not be
   * required to be present forever.
   */
  readonly email?: string;
  readonly password?: string;
  /**
   * A refresh token this computer has already been given, read from its encrypted credential.
   *
   * Tried BEFORE the password, so a restart resumes rather than re-authenticating. A rejected one
   * falls back to the password when there is one, and is reported when there is not.
   */
  readonly refreshToken?: string;
}

export interface DeviceSession {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
  /**
   * The Supabase Auth user this session belongs to, when the service named it.
   *
   * Recorded alongside a stored credential so the file says which account it is for, and so a
   * credential provisioned for one device account is never silently used as another's.
   */
  readonly userId?: string;
}

export class SupabaseAuthError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "SupabaseAuthError";
  }
}

/** Refresh this long before expiry, so a slow push does not die holding a just-expired token. */
const REFRESH_MARGIN_MS = 60_000;

/**
 * Told whenever this computer obtains a session, so the refresh token can be persisted.
 *
 * Called with the session, not the password: there is deliberately no hook that could carry one.
 * It must not throw -- a credential that cannot be stored is a worse reason to fail a sync than
 * no credential at all, so the caller swallows its own failures and says so in a log.
 */
export type DeviceSessionSink = (session: DeviceSession) => void;

export class SupabaseDeviceAuth {
  private session: DeviceSession | null = null;
  /** A stored refresh token, tried before the password and discarded once it is refused. */
  private storedRefreshToken: string | null;

  constructor(
    private readonly credentials: SupabaseDeviceCredentials,
    private readonly now: () => number = () => Date.now(),
    private readonly onSession?: DeviceSessionSink
  ) {
    this.storedRefreshToken = credentials.refreshToken ?? null;
  }

  /** True once this computer has signed in. Says nothing about who it is. */
  get signedIn(): boolean {
    return this.session !== null;
  }

  /** True when this computer can attempt a sign-in at all -- a stored token or a password. */
  get canAuthenticate(): boolean {
    return this.storedRefreshToken !== null || this.hasPassword;
  }

  private get hasPassword(): boolean {
    return typeof this.credentials.email === "string" && this.credentials.email !== ""
      && typeof this.credentials.password === "string" && this.credentials.password !== "";
  }

  /** Remembers the session and tells whoever is persisting it. Never throws for the sink's sake. */
  private adopt(session: DeviceSession): DeviceSession {
    this.session = session;
    this.storedRefreshToken = session.refreshToken;
    this.onSession?.(session);
    return session;
  }

  /**
   * A usable access token: the one in hand if it has life left, a refreshed one if not, and a
   * fresh sign-in if the refresh is rejected.
   *
   * ORDER MATTERS. A stored refresh token is tried BEFORE the password, so a restarted computer
   * resumes from its encrypted credential rather than needing the password again. Only when there
   * is no usable token does the password come into it -- and on a provisioned machine there may be
   * no password at all, which is the point.
   */
  async accessToken(): Promise<string> {
    const held = this.session;
    if (held !== null && held.expiresAt - REFRESH_MARGIN_MS > this.now()) return held.accessToken;

    const refreshToken = held?.refreshToken ?? this.storedRefreshToken;
    if (refreshToken !== null && refreshToken !== undefined) {
      try {
        return this.adopt(await this.exchange({ grant_type: "refresh_token", refresh_token: refreshToken })).accessToken;
      } catch (error) {
        // A refresh token can be revoked or simply too old. Falling back to a full sign-in is
        // correct and quiet: it is not a failure the operator needs to see. But with no password
        // to fall back TO, this is the whole answer and must be reported rather than swallowed.
        this.session = null;
        this.storedRefreshToken = null;
        if (!this.hasPassword) throw error;
      }
    }

    if (!this.hasPassword) {
      throw new SupabaseAuthError(
        "this computer has no cloud credential and no device password to obtain one",
        0
      );
    }

    return this.adopt(
      await this.exchange({
        grant_type: "password",
        email: this.credentials.email ?? "",
        password: this.credentials.password ?? "",
      })
    ).accessToken;
  }

  /**
   * Forgets the tokens held in memory. The credentials stay where they came from.
   *
   * This is NOT a logout: it drops the session so the next call re-authenticates, which is what a
   * 401 needs. It deliberately does not clear the stored refresh token -- a rejected ACCESS token
   * says nothing about the refresh token, and throwing away a device's credential because one
   * request was refused would cost an enrolment the owner has to restore by hand.
   */
  signOut(): void {
    this.session = null;
  }

  /** Forgets the stored refresh token too, for a deliberate re-enrolment. */
  forgetStoredCredential(): void {
    this.session = null;
    this.storedRefreshToken = null;
  }

  private async exchange(body: Record<string, string>): Promise<DeviceSession> {
    const grant = body.grant_type ?? "password";
    const response = await requestJson({
      url: `${trimSlash(this.credentials.url)}/auth/v1/token?grant_type=${encodeURIComponent(grant)}`,
      method: "POST",
      headers: { apikey: this.credentials.anonKey },
      body: JSON.stringify(body),
    });

    if (response.status < 200 || response.status >= 300) {
      const error = readServiceError(response.status, response.text);
      // The message is the service's, scrubbed. The request body held a password and is never
      // mentioned.
      throw new SupabaseAuthError(`sign-in refused: ${error.message}`, response.status);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.text);
    } catch {
      throw new SupabaseAuthError("the sign-in answer was not readable", response.status);
    }
    const record = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    const accessToken = record.access_token;
    const refreshToken = record.refresh_token;
    const expiresIn = record.expires_in;
    if (typeof accessToken !== "string" || accessToken === "" || typeof refreshToken !== "string") {
      throw new SupabaseAuthError("the sign-in answer did not contain a session", response.status);
    }

    const lifetimeMs = typeof expiresIn === "number" && expiresIn > 0 ? expiresIn * 1000 : 3_600_000;
    // The account the session belongs to, when the service names it. Supabase returns it as
    // user.id; absent, the credential simply records no account and nothing depends on it.
    const user = typeof record.user === "object" && record.user !== null ? (record.user as Record<string, unknown>) : {};
    const userId = typeof user.id === "string" && user.id !== "" ? user.id : undefined;
    return { accessToken, refreshToken, expiresAt: this.now() + lifetimeMs, userId };
  }
}

const trimSlash = (url: string): string => url.replace(/\/+$/, "");

/** For an operator-facing message. Never includes a key, a token or a password. */
export const describeAuthFailure = (error: unknown): string =>
  error instanceof SupabaseAuthError || error instanceof HttpError
    ? redactSecrets(error.message)
    : "the cloud could not be reached";
