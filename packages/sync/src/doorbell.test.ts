import test from "node:test";
import assert from "node:assert/strict";
import { SyncDoorbell, readDoorbellMessage, type DoorbellSocket, type DoorbellStatus } from "./doorbell.js";

// THE DOORBELL (doorbell.ts), against a stand-in socket and timers fired by hand: it subscribes with
// this computer's token, rings for other computers' writes and not its own, catches up on every
// connect, notices a silent connection, keeps its token fresh, and never lets go.

class FakeSocket implements DoorbellSocket {
  sent: Array<Record<string, unknown>> = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {
    this.closed = true;
  }
  /** The server says something. */
  say(message: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  last(event: string): Record<string, unknown> | undefined {
    return [...this.sent].reverse().find((message) => message.event === event);
  }
}

function harness() {
  const sockets: FakeSocket[] = [];
  const timers: Array<{ handler: () => void; ms: number; live: boolean }> = [];
  let rings = 0;
  const statuses: DoorbellStatus[] = [];
  let token = "token-1";
  const doorbell = new SyncDoorbell({
    url: "https://abc.supabase.co",
    anonKey: "anon-key",
    accessToken: async () => token,
    ownDeviceId: "dev-me",
    onRing: () => {
      rings += 1;
    },
    onStatus: (status) => statuses.push(status),
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    setTimer: (handler, ms) => {
      const timer = { handler, ms, live: true };
      timers.push(timer);
      return timer as unknown as NodeJS.Timeout;
    },
    clearTimer: (timer) => {
      (timer as unknown as { live: boolean }).live = false;
    },
    heartbeatMs: 25_000,
    tokenRefreshMs: 600_000,
  });
  /** Fires the live timer of this length that was set first. */
  const fire = async (ms: number) => {
    const timer = timers.find((candidate) => candidate.live && candidate.ms === ms);
    assert.ok(timer, `a ${String(ms)} ms timer is pending`);
    timer.live = false;
    timer.handler();
    await settle();
  };
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  /** Connects and subscribes the newest socket. */
  const subscribe = async () => {
    await settle();
    const socket = sockets.at(-1)!;
    socket.onopen?.();
    const join = socket.last("phx_join")!;
    socket.say({ event: "phx_reply", topic: join.topic, ref: join.ref, payload: { status: "ok", response: {} } });
    return socket;
  };
  return {
    doorbell, sockets, timers, statuses, fire, settle, subscribe,
    rings: () => rings,
    setToken: (next: string) => {
      token = next;
    },
  };
}

const ring = (socket: FakeSocket, by: string) =>
  socket.say({
    event: "postgres_changes",
    topic: "realtime:erp-sync-doorbell",
    ref: null,
    payload: { data: { type: "UPDATE", table: "sync_log_doorbell", record: { scope: "global", last_seq: 42, last_origin_device_id: by } } },
  });

test("it subscribes to the doorbell alone, with this computer's token, and catches up once when it does", async () => {
  const h = harness();
  h.doorbell.start();
  const socket = await h.subscribe();
  assert.equal(socket.url, "wss://abc.supabase.co/realtime/v1/websocket?apikey=anon-key&vsn=1.0.0");
  const join = socket.last("phx_join")!;
  const payload = join.payload as { config: { postgres_changes: unknown[] }; access_token: string };
  assert.deepEqual(payload.config.postgres_changes, [{ event: "*", schema: "public", table: "sync_log_doorbell" }]);
  assert.equal(payload.access_token, "token-1");
  assert.equal(h.doorbell.state, "LISTENING");
  assert.equal(h.rings(), 1, "a pull for whatever happened while it was not listening");
});

test("another computer's write rings; its own does not; noise is ignored", async () => {
  const h = harness();
  h.doorbell.start();
  const socket = await h.subscribe();
  ring(socket, "dev-store");
  ring(socket, "dev-me");
  socket.onmessage?.({ data: "not json" });
  socket.onmessage?.({ data: JSON.stringify({ event: "postgres_changes", topic: "realtime:somebody-else", payload: {} }) });
  assert.equal(h.rings(), 2, "the catch-up, and the store's write");
});

test("a connection that closes, or stops answering heartbeats, is replaced, backing off", async () => {
  const h = harness();
  h.doorbell.start();
  const first = await h.subscribe();
  first.onclose?.();
  assert.equal(h.doorbell.state, "RECONNECTING");
  assert.ok(first.closed);
  await h.fire(1_000);
  const second = await h.subscribe();
  assert.equal(h.doorbell.state, "LISTENING");
  assert.equal(h.rings(), 2, "catches up again after the gap");

  // Heartbeat sent, never answered: on the next beat the connection is declared gone.
  await h.fire(25_000);
  assert.ok(second.last("heartbeat"));
  await h.fire(25_000);
  assert.ok(second.closed, "a silent connection is closed");
  assert.equal(h.doorbell.state, "RECONNECTING");
});

test("an answered heartbeat keeps the connection; the token is refreshed on the channel", async () => {
  const h = harness();
  h.doorbell.start();
  const socket = await h.subscribe();
  await h.fire(25_000);
  const beat = socket.last("heartbeat")!;
  socket.say({ event: "phx_reply", topic: "phoenix", ref: beat.ref, payload: { status: "ok", response: {} } });
  await h.fire(25_000);
  assert.equal(socket.closed, false);
  h.setToken("token-2");
  await h.fire(600_000);
  assert.deepEqual(socket.last("access_token")?.payload, { access_token: "token-2" });
});

test("a refused subscription retries, doubling, and stop lets go of everything", async () => {
  const h = harness();
  h.doorbell.start();
  await h.settle();
  const socket = h.sockets.at(-1)!;
  socket.onopen?.();
  const join = socket.last("phx_join")!;
  socket.say({ event: "phx_reply", topic: join.topic, ref: join.ref, payload: { status: "error", response: { reason: "Unauthorized" } } });
  assert.equal(h.doorbell.state, "RECONNECTING");
  await h.fire(1_000);
  h.sockets.at(-1)!.onclose?.();
  assert.ok(h.timers.some((timer) => timer.live && timer.ms === 2_000), "the second wait is longer");

  h.doorbell.stop();
  assert.equal(h.doorbell.state, "OFF");
  assert.ok(h.timers.every((timer) => !timer.live), "nothing left pending");
});

test("a message is read only when it is one the protocol sends", () => {
  assert.equal(readDoorbellMessage(42), null);
  assert.equal(readDoorbellMessage("{"), null);
  assert.equal(readDoorbellMessage(JSON.stringify({ event: "x" })), null);
  assert.deepEqual(readDoorbellMessage(JSON.stringify({ event: "x", topic: "t", ref: "1", payload: { a: 1 } })), { event: "x", topic: "t", ref: "1", payload: { a: 1 } });
});
