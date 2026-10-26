// LISTENS FOR THE CLOUD LOG'S DOORBELL, so this computer pulls within seconds of another computer's
// write instead of on its next timer pass (cloud migration 016, owner decision 2026-10-27).
//
// It subscribes, through Supabase Realtime, to sync_log_doorbell -- one row per scope, rung by every
// write to the log. A ring from ANOTHER computer calls onRing, and the host starts an ordinary pass
// (SyncScheduler.wake). The ring carries a position and who rang it, never an event: what changed is
// still read through the pull, which validates everything.
//
// IT CAN ONLY MAKE THINGS FASTER, NEVER WRONG:
//   * A missed ring costs nothing. The timer pass still runs every minute, and on every (re)connect
//     the doorbell rings once itself, to cover whatever happened while it was not listening.
//   * A connection that dies silently is noticed by a heartbeat that goes unanswered, and replaced.
//   * Reconnects back off, from a second to a minute, so a flapping line does not hammer the cloud.
//
// Spoken directly: Realtime's channel protocol (Phoenix, JSON, vsn 1.0.0) over the WebSocket built
// into Node, rather than a client library for a few messages (CLAUDE.md R22). Every message read is
// checked before it is acted on (R25); one that does not read is ignored.

export type DoorbellStatus = "OFF" | "CONNECTING" | "LISTENING" | "RECONNECTING";

/** The part of a WebSocket the doorbell uses, so a test can stand in for one. */
export interface DoorbellSocket {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

export interface SyncDoorbellOptions {
  /** The project, as configured: https://<ref>.supabase.co */
  readonly url: string;
  readonly anonKey: string;
  /** A current access token for this computer's session (SupabaseDeviceAuth.accessToken). */
  readonly accessToken: () => Promise<string>;
  /** Rings caused by this computer's own writes are not news to it. */
  readonly ownDeviceId: string;
  /** Another computer's work has reached the log. */
  readonly onRing: () => void;
  readonly onStatus?: (status: DoorbellStatus, detail?: string) => void;
  readonly createSocket?: (url: string) => DoorbellSocket;
  readonly setTimer?: (handler: () => void, ms: number) => NodeJS.Timeout;
  readonly clearTimer?: (timer: NodeJS.Timeout) => void;
  /** An unanswered heartbeat after this long means the connection is dead. Default 25 s. */
  readonly heartbeatMs?: number;
  /** How often the channel is handed a fresh access token. Default 10 minutes. */
  readonly tokenRefreshMs?: number;
  readonly minBackoffMs?: number;
  readonly maxBackoffMs?: number;
}

const TOPIC = "realtime:erp-sync-doorbell";

type Message = { readonly event: string; readonly topic: string; readonly ref: string | null; readonly payload: Record<string, unknown> };

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** One message off the socket, or null when it is not one this protocol sends. */
export function readDoorbellMessage(data: unknown): Message | null {
  if (typeof data !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  const message = asRecord(parsed);
  if (message === null || typeof message.event !== "string" || typeof message.topic !== "string") return null;
  const payload = asRecord(message.payload) ?? {};
  const ref = typeof message.ref === "string" ? message.ref : null;
  return { event: message.event, topic: message.topic, ref, payload };
}

/** The device that rang, from a postgres_changes payload, or null when it does not say. */
const ringerOf = (payload: Record<string, unknown>): string | null => {
  const record = asRecord(asRecord(payload.data)?.record);
  return typeof record?.last_origin_device_id === "string" ? record.last_origin_device_id : null;
};

const defaultSocket = (url: string): DoorbellSocket => {
  const Socket = (globalThis as { WebSocket?: new (address: string) => DoorbellSocket }).WebSocket;
  if (Socket === undefined) throw new Error("this runtime has no WebSocket");
  return new Socket(url);
};

export class SyncDoorbell {
  private socket: DoorbellSocket | null = null;
  private status: DoorbellStatus = "OFF";
  private stopped = true;
  private failures = 0;
  private nextRef = 1;
  private joinRef: string | null = null;
  private heartbeatRef: string | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private tokenTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: SyncDoorbellOptions) {}

  get state(): DoorbellStatus {
    return this.status;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.dropSocket();
    this.setStatus("OFF");
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.setStatus(this.failures === 0 ? "CONNECTING" : "RECONNECTING");
    let token: string;
    try {
      token = await this.options.accessToken();
    } catch (error) {
      this.retryLater(error instanceof Error ? error.message : "no session");
      return;
    }
    if (this.stopped) return;
    const address = `${this.options.url.replace(/^http/, "ws").replace(/\/$/, "")}/realtime/v1/websocket?apikey=${encodeURIComponent(this.options.anonKey)}&vsn=1.0.0`;
    let socket: DoorbellSocket;
    try {
      socket = (this.options.createSocket ?? defaultSocket)(address);
    } catch (error) {
      this.retryLater(error instanceof Error ? error.message : "the socket could not be opened");
      return;
    }
    this.socket = socket;
    socket.onopen = () => this.join(token);
    socket.onmessage = (event) => this.receive(event.data);
    socket.onclose = () => this.lost("the connection closed");
    socket.onerror = () => this.lost("the connection failed");
  }

  private join(token: string): void {
    this.joinRef = this.send("phx_join", TOPIC, {
      config: {
        broadcast: { ack: false, self: false },
        presence: { key: "" },
        postgres_changes: [{ event: "*", schema: "public", table: "sync_log_doorbell" }],
        private: false,
      },
      access_token: token,
    });
  }

  private receive(data: unknown): void {
    const message = readDoorbellMessage(data);
    if (message === null) return;
    if (message.event === "phx_reply" && message.ref !== null && message.ref === this.heartbeatRef) {
      this.heartbeatRef = null;
      return;
    }
    if (message.event === "phx_reply" && message.ref !== null && message.ref === this.joinRef) {
      if (message.payload.status === "ok") this.listening();
      else this.lost(`the cloud refused the subscription: ${JSON.stringify(message.payload.response ?? {})}`);
      return;
    }
    if (message.topic !== TOPIC) return;
    if (message.event === "postgres_changes") {
      if (ringerOf(message.payload) !== this.options.ownDeviceId) this.options.onRing();
      return;
    }
    if (message.event === "phx_error" || message.event === "phx_close") this.lost(`the channel ${message.event === "phx_error" ? "failed" : "closed"}`);
    if (message.event === "system" && message.payload.status === "error") this.lost(String(message.payload.message ?? "the channel reported an error"));
  }

  /** Subscribed: listen, keep the connection proven and the token fresh, and catch up once. */
  private listening(): void {
    this.failures = 0;
    this.setStatus("LISTENING");
    this.scheduleHeartbeat();
    this.scheduleTokenRefresh();
    // Whatever was written while this computer was not listening.
    this.options.onRing();
  }

  /** Proves the connection: an unanswered heartbeat means it is gone, whatever the socket says. */
  private scheduleHeartbeat(): void {
    this.heartbeatTimer = this.later(this.options.heartbeatMs ?? 25_000, () => {
      if (this.heartbeatRef !== null) {
        this.lost("the connection stopped answering");
        return;
      }
      this.heartbeatRef = this.send("heartbeat", "phoenix", {});
      this.scheduleHeartbeat();
    });
  }

  /** Hands the channel a fresh token before the one it joined with expires. */
  private scheduleTokenRefresh(): void {
    this.tokenTimer = this.later(this.options.tokenRefreshMs ?? 10 * 60_000, () => {
      void this.options
        .accessToken()
        .then((token) => this.send("access_token", TOPIC, { access_token: token }))
        .catch(() => undefined); // the next refresh, or a reconnect, tries again
      this.scheduleTokenRefresh();
    });
  }

  private lost(detail: string): void {
    if (this.stopped || this.socket === null) return;
    this.clearTimers();
    this.dropSocket();
    this.retryLater(detail);
  }

  private retryLater(detail: string): void {
    if (this.stopped) return;
    this.failures += 1;
    const min = this.options.minBackoffMs ?? 1_000;
    const delay = Math.min(this.options.maxBackoffMs ?? 60_000, min * 2 ** (this.failures - 1));
    this.setStatus("RECONNECTING", detail);
    this.reconnectTimer = (this.options.setTimer ?? setTimeout)(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private send(event: string, topic: string, payload: Record<string, unknown>): string {
    const ref = String(this.nextRef++);
    const message = { topic, event, payload, ref, ...(event === "phx_join" ? { join_ref: ref } : {}) };
    try {
      this.socket?.send(JSON.stringify(message));
    } catch {
      this.lost("a message could not be sent");
    }
    return ref;
  }

  /** Runs `handler` once after `ms`, unless the doorbell stopped or lost its socket meanwhile. */
  private later(ms: number, handler: () => void): NodeJS.Timeout {
    return (this.options.setTimer ?? setTimeout)(() => {
      if (this.stopped || this.socket === null) return;
      handler();
    }, ms);
  }

  private clearTimers(): void {
    const clear = this.options.clearTimer ?? clearTimeout;
    for (const timer of [this.heartbeatTimer, this.tokenTimer, this.reconnectTimer]) if (timer !== null) clear(timer);
    this.heartbeatTimer = null;
    this.tokenTimer = null;
    this.reconnectTimer = null;
    this.heartbeatRef = null;
  }

  private dropSocket(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket === null) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try {
      socket.close();
    } catch {
      // Already closed.
    }
  }

  private setStatus(status: DoorbellStatus, detail?: string): void {
    this.status = status;
    try {
      this.options.onStatus?.(status, detail);
    } catch {
      // A listener that throws must not stop the doorbell.
    }
  }
}
