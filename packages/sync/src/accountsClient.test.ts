import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fetchAccountState, signUp, verifyLogin } from "./accountsClient.js";
import { SupabaseDeviceAuth } from "./supabaseAuth.js";
import { SupabaseSyncTransport } from "./supabaseTransport.js";

// CLOUD ACCOUNT CALLS, against a loopback stand-in for the service (as supabaseTransport.test.ts).
//
// What is proved here is the part the sign-in rules turn on (docs/41 section 4): the transport
// sorts every way a call can go into ANSWERED, NOT_SUPPORTED, REFUSED, UNREACHABLE or UNREADABLE,
// and the client reads an answer whole or not at all. A refusal must never be mistaken for the
// cloud being out of reach, because only the second may let a cached check sign anyone in.

const ANON_KEY = "test-anon-key-not-a-real-one";
const TOKEN = "a".repeat(64);
const PERSON = {
  personId: "p-ali", revision: 1, email: "ali@777.pk", displayName: "Ali", status: "PENDING", isAdmin: false,
  roleCode: null, extraPermissions: [], jobRole: "", authorityLevel: 10, credentialVersion: 1,
};

interface Stand {
  readonly url: string;
  readonly bodies: string[];
  reply(status: number, body: unknown): void;
  close(): Promise<void>;
}

/** Answers the token endpoint, then every RPC with the next queued reply. */
async function standIn(): Promise<Stand> {
  const bodies: string[] = [];
  const queue: Array<{ status: number; body: unknown }> = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    request.on("end", () => {
      if ((request.url ?? "").startsWith("/auth/v1/token")) {
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: "jwt", refresh_token: "r", expires_in: 3600 }));
        return;
      }
      bodies.push(body);
      const next = queue.shift() ?? { status: 500, body: { message: "nothing queued" } };
      response.writeHead(next.status, { "content-type": "application/json" }).end(JSON.stringify(next.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    bodies,
    reply: (status, body) => void queue.push({ status, body }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function transportFor(url: string): SupabaseSyncTransport {
  const auth = new SupabaseDeviceAuth({ url, anonKey: ANON_KEY, email: "pc@example.invalid", password: "device-password" }, () => 1_000_000);
  return new SupabaseSyncTransport({ url, anonKey: ANON_KEY, auth, timeoutMs: 2_000 });
}

test("a signed-in person is read whole, and the password goes in the body and nowhere else", async () => {
  const stand = await standIn();
  try {
    stand.reply(200, { ok: true, person: PERSON, token: TOKEN, expiresAt: "2026-11-01T22:00:00+00:00" });
    const answer = await verifyLogin(transportFor(stand.url), "ali@777.pk", "alipass12");
    assert.equal(answer.kind, "SIGNED_IN");
    if (answer.kind === "SIGNED_IN") {
      assert.equal(answer.person.personId, "p-ali");
      assert.equal(answer.expiresAt, "2026-11-01T22:00:00.000Z");
    }
    assert.deepEqual(JSON.parse(stand.bodies[0] ?? "{}"), { p_email: "ali@777.pk", p_password: "alipass12" });
  } finally {
    await stand.close();
  }
});

test("the function saying no is DECLINED with its code; a locked person carries the wait", async () => {
  const stand = await standIn();
  try {
    stand.reply(200, { ok: false, reason: "WRONG_CREDENTIALS" });
    stand.reply(200, { ok: false, reason: "LOCKED", retryAfterSeconds: 840 });
    const caller = transportFor(stand.url);
    assert.deepEqual(await verifyLogin(caller, "ali@777.pk", "x"), { kind: "DECLINED", reason: "WRONG_CREDENTIALS" });
    assert.deepEqual(await verifyLogin(caller, "ali@777.pk", "x"), { kind: "DECLINED", reason: "LOCKED", retryAfterSeconds: 840 });
  } finally {
    await stand.close();
  }
});

test("a 4xx is a REFUSED call, a 5xx, 408 or 429 is UNREACHABLE, a 404 is NOT_SUPPORTED", async () => {
  const stand = await standIn();
  try {
    const caller = transportFor(stand.url);
    const cases: Array<[number, string]> = [[403, "REFUSED"], [400, "REFUSED"], [500, "UNREACHABLE"], [503, "UNREACHABLE"], [408, "UNREACHABLE"], [429, "UNREACHABLE"], [404, "NOT_SUPPORTED"]];
    for (const [status, kind] of cases) {
      stand.reply(status, { message: `status ${String(status)}` });
      assert.equal((await verifyLogin(caller, "ali@777.pk", "x")).kind, kind, `HTTP ${String(status)}`);
    }
  } finally {
    await stand.close();
  }
});

test("no service at all is UNREACHABLE, never a refusal", async () => {
  const stand = await standIn();
  const url = stand.url;
  await stand.close();
  assert.equal((await signUp(transportFor(url), "new@777.pk", "newpass12", "New")).kind, "UNREACHABLE");
});

test("an answer that is not what was promised is UNREADABLE, never half-used", async () => {
  const stand = await standIn();
  try {
    const caller = transportFor(stand.url);
    stand.reply(200, { ok: true, person: { ...PERSON, status: "WHATEVER" }, token: TOKEN, expiresAt: "2026-11-01T22:00:00Z" });
    assert.equal((await verifyLogin(caller, "a@b.c", "x")).kind, "UNREADABLE");
    stand.reply(200, { ok: true, person: PERSON, token: "short", expiresAt: "2026-11-01T22:00:00Z" });
    assert.equal((await verifyLogin(caller, "a@b.c", "x")).kind, "UNREADABLE");
    stand.reply(200, { ok: true, roles: [], people: [PERSON, { personId: "half" }], requests: [] });
    assert.equal((await fetchAccountState(caller)).kind, "UNREADABLE", "one bad person spoils the whole state");
    stand.reply(200, { ok: true, roles: [], people: [PERSON], requests: [] });
    const state = await fetchAccountState(caller);
    assert.equal(state.kind, "STATE");
  } finally {
    await stand.close();
  }
});
