import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { productVariantDedupeKey, qrMasterDedupeKey } from "@erp/data";
import type { SyncEnvelope } from "./contract.js";
import { redactSecrets } from "./httpJson.js";
import { SupabaseAuthError, SupabaseDeviceAuth } from "./supabaseAuth.js";
import { SUPABASE_PUSHABLE_AGGREGATES, SupabaseSyncTransport } from "./supabaseTransport.js";
import { SyncTransportError } from "./transport.js";

// THE REAL TRANSPORT, AGAINST A STAND-IN FOR THE REAL SERVICE.
//
// A loopback server that answers the two shapes Supabase answers — GoTrue's token endpoint and
// PostgREST on qr_master and sync_event_log — so the transport's requests, headers, retry
// classification and secret handling can be checked without a project, a key, or a network.
//
// These tests do NOT prove the transport works against Supabase. They prove it sends what it
// means to send and reacts correctly to what the service can answer. The real project can still
// disagree about a column, a policy or a header, and only a run against it will show that.

const ANON_KEY = "test-anon-key-not-a-real-one";
const PASSWORD = "device-password-not-a-real-one";
const ACCESS_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJkZXZpY2UtYSJ9.signature-part";

interface Call {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

interface Fake {
  readonly url: string;
  readonly calls: Call[];
  /** Queue an answer for the next matching request. */
  reply(match: string, status: number, body: unknown): void;
  /** Another computer claims the same enrolment, leaving this one holding a stale epoch. */
  supersede(): void;
  close(): Promise<void>;
}

/** The one product the fake service starts with. Anything else is refused, as 006 does. */
const KNOWN_VARIANT = "variant-sk9-black-7-10";

/** A product this computer has just created, which the cloud has never been told about. */
const NEW_VARIANT = "variant-sk46-black-4-6";

async function startFakeSupabase(): Promise<Fake> {
  const calls: Call[] = [];
  const queued = new Map<string, Array<{ status: number; body: unknown }>>();
  const log: Array<{ seq: number; row: Record<string, unknown> }> = [];
  // The claim the service currently recognises. A second claim supersedes the first.
  let epoch = 0;
  // The products the service knows. push_product_variant is how a new one gets in (008).
  const knownVariants = new Set<string>([KNOWN_VARIANT]);

  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      const path = request.url ?? "/";
      calls.push({ method: request.method ?? "", path, headers: request.headers, body });

      const key = [...queued.keys()].find((candidate) => path.includes(candidate));
      if (key !== undefined) {
        const next = queued.get(key)?.shift();
        if (next !== undefined) {
          response
            .writeHead(next.status, { "content-type": "application/json" })
            .end(JSON.stringify(next.body));
          return;
        }
      }

      if (path.startsWith("/auth/v1/token")) {
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ access_token: ACCESS_TOKEN, refresh_token: "refresh-value", expires_in: 3600 }));
        return;
      }

      // Migration 006: a device claims, and the epoch it is given is checked by every write.
      if (path === "/rest/v1/rpc/claim_device" && request.method === "POST") {
        epoch += 1;
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ ok: true, epoch, holder: `holder-${String(epoch)}` }));
        return;
      }

      // Migration 006: heartbeat_device confirms the claim this computer already holds and
      // updates last_seen_at. It bumps no epoch and writes no claim event.
      if (path === "/rest/v1/rpc/heartbeat_device" && request.method === "POST") {
        const args = JSON.parse(body) as { p_epoch: number; p_holder: string };
        if (args.p_epoch !== epoch || args.p_holder !== `holder-${String(epoch)}`) {
          response
            .writeHead(403, { "content-type": "application/json" })
            .end(JSON.stringify({ code: "42501", message: "CLAIM_SUPERSEDED" }));
          return;
        }
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
        return;
      }

      // Migration 008: a product variant is inserted, and the service then knows the product.
      if (path === "/rest/v1/rpc/push_product_variant" && request.method === "POST") {
        const args = JSON.parse(body) as { p_epoch: number; p_holder: string; p_rows: Array<Record<string, unknown>> };
        if (args.p_epoch !== epoch || args.p_holder !== `holder-${String(epoch)}`) {
          response
            .writeHead(403, { "content-type": "application/json" })
            .end(JSON.stringify({ code: "42501", message: "CLAIM_SUPERSEDED" }));
          return;
        }
        const results = args.p_rows.map((row) => {
          const id = String(row.id);
          if (knownVariants.has(id)) return { id: row.id, outcome: "DUPLICATE" };
          knownVariants.add(id);
          return { id: row.id, outcome: "INSERTED" };
        });
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ ok: true, epoch, results }));
        return;
      }

      if (path === "/rest/v1/rpc/push_qr_master" && request.method === "POST") {
        const args = JSON.parse(body) as { p_epoch: number; p_holder: string; p_rows: Array<Record<string, unknown>> };
        if (args.p_epoch !== epoch || args.p_holder !== `holder-${String(epoch)}`) {
          response
            .writeHead(403, { "content-type": "application/json" })
            .end(JSON.stringify({ code: "42501", message: "CLAIM_SUPERSEDED" }));
          return;
        }
        const results = args.p_rows.map((row) => {
          if (!knownVariants.has(String(row.product_variant_id))) {
            return { qr_id: row.qr_id, outcome: "REFUSED", reason: "UNKNOWN_PRODUCT_VARIANT" };
          }
          const dedupeKey = `QR_MASTER:${String(row.qr_id)}`;
          if (log.some((entry) => entry.row.dedupe_key === dedupeKey)) {
            return { qr_id: row.qr_id, outcome: "DUPLICATE" };
          }
          // Model the trigger: an accepted carton appears in the log.
          log.push({
            seq: log.length + 1,
            row: {
              seq: log.length + 1,
              dedupe_key: dedupeKey,
              aggregate_type: "QR_MASTER",
              aggregate_id: row.qr_id,
              operation: "INSERT",
              payload: {
                qrId: row.qr_id,
                productVariantId: row.product_variant_id,
                createdAt: row.created_at,
              },
              origin_device_id: null,
              logged_at: "2026-10-16T09:00:00.000Z",
            },
          });
          return { qr_id: row.qr_id, outcome: "INSERTED" };
        });
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ ok: true, epoch, results }));
        return;
      }

      if (path === "/rest/v1/rpc/push_production_produced" && request.method === "POST") {
        const args = JSON.parse(body) as { p_epoch: number; p_rows: Array<Record<string, unknown>> };
        if (args.p_epoch !== epoch) {
          response
            .writeHead(403, { "content-type": "application/json" })
            .end(JSON.stringify({ code: "42501", message: "CLAIM_SUPERSEDED" }));
          return;
        }
        response.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            ok: true,
            epoch,
            results: args.p_rows.map((row) => ({ id: row.id, outcome: "INSERTED" })),
          })
        );
        return;
      }

      if (path.startsWith("/rest/v1/sync_event_log")) {
        const after = Number(new URLSearchParams(path.slice(path.indexOf("?") + 1)).get("seq")?.replace("gt.", "") ?? "0");
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify(log.filter((entry) => entry.seq > after).map((entry) => entry.row)));
        return;
      }

      response.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ message: "not found" }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    calls,
    reply: (match, status, body) => {
      const existing = queued.get(match) ?? [];
      existing.push({ status, body });
      queued.set(match, existing);
    },
    supersede: () => {
      epoch += 1;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

const build = (fake: Fake) => {
  const auth = new SupabaseDeviceAuth({
    url: fake.url,
    anonKey: ANON_KEY,
    email: "pc1@example.invalid",
    password: PASSWORD,
  });
  return { auth, transport: new SupabaseSyncTransport({ url: fake.url, anonKey: ANON_KEY, auth, timeoutMs: 2_000 }) };
};

const carton = (
  qrId: string,
  createdAt = "2026-10-16T08:00:00.000Z",
  productVariantId = KNOWN_VARIANT
): SyncEnvelope => ({
  dedupeKey: qrMasterDedupeKey(qrId),
  aggregateType: "QR_MASTER",
  aggregateId: qrId,
  operation: "INSERT",
  payload: { qrId, productVariantId, createdAt },
  originDeviceId: "device-pc1",
  createdAt,
});

/** A product variant, with every field readProductVariantPayload insists on. */
const variant = (variantId: string): SyncEnvelope => ({
  dedupeKey: productVariantDedupeKey(variantId),
  aggregateType: "PRODUCT_VARIANT",
  aggregateId: variantId,
  operation: "INSERT",
  payload: {
    variantId,
    article: "SK46",
    color: "BLACK",
    size: "4/6",
    description: "SK46 BLACK 4/6",
    createdAt: "2026-10-16T07:59:00.000Z",
  },
  originDeviceId: "device-pc1",
  createdAt: "2026-10-16T07:59:00.000Z",
});

/** A production scan, with every field readProductionProducedPayload insists on. */
const scan = (eventId: string, qrId: string): SyncEnvelope => ({
  dedupeKey: `PRODUCTION_PRODUCED:${eventId}`,
  aggregateType: "PRODUCTION_PRODUCED",
  aggregateId: eventId,
  operation: "INSERT",
  payload: {
    eventId,
    qrId,
    productVariantId: KNOWN_VARIANT,
    occurredAt: "2026-10-16T08:05:00.000Z",
    eventDate: "2026-10-16",
    eventHour: 8,
    factoryId: "factory-777",
    workstationId: "ws-prod-01",
    operatorId: null,
    deviceId: "desktop-main",
    article: "SK9",
    color: "BLACK",
    size: "7/10",
    serial: "000001",
    metadataJson: "{}",
    createdAt: "2026-10-16T08:05:00.000Z",
    sourceApp: "desktop-scanner",
  },
  originDeviceId: "device-pc1",
  createdAt: "2026-10-16T08:05:00.000Z",
});

/** A transport that has already claimed, which is the precondition for every push. */
const claimed = async (fake: Fake): Promise<SupabaseSyncTransport> => {
  const { transport } = build(fake);
  const outcome = await transport.claimDevice({ deviceId: "desktop-main", workstationId: "ws-prod-01", numberBlock: 1 });
  assert.ok(outcome.ok, "the fixture must be able to claim");
  return transport;
};

// ─── sign-in ────────────────────────────────────────────────────────────────

test("the device signs in and reuses the token it already holds", async () => {
  const fake = await startFakeSupabase();
  try {
    const { auth } = build(fake);
    assert.equal(auth.signedIn, false);
    const first = await auth.accessToken();
    const second = await auth.accessToken();

    assert.equal(first, ACCESS_TOKEN);
    assert.equal(second, ACCESS_TOKEN);
    assert.equal(auth.signedIn, true);
    assert.equal(
      fake.calls.filter((call) => call.path.startsWith("/auth/v1/token")).length,
      1,
      "a token with life left is not fetched twice"
    );
  } finally {
    await fake.close();
  }
});

test("an expiring token is refreshed, and a refused refresh falls back to signing in", async () => {
  const fake = await startFakeSupabase();
  try {
    let clock = 1_000_000;
    const auth = new SupabaseDeviceAuth(
      { url: fake.url, anonKey: ANON_KEY, email: "pc1@example.invalid", password: PASSWORD },
      () => clock
    );
    await auth.accessToken();
    clock += 3_600_000; // past expiry

    fake.reply("grant_type=refresh_token", 400, { error: "invalid_grant", error_description: "refresh token expired" });
    const token = await auth.accessToken();

    assert.equal(token, ACCESS_TOKEN);
    const grants = fake.calls.filter((c) => c.path.startsWith("/auth/v1/token")).map((c) => c.path);
    assert.equal(grants.filter((p) => p.includes("refresh_token")).length, 1, "it tried to refresh");
    assert.equal(grants.filter((p) => p.includes("password")).length, 2, "then signed in again");
  } finally {
    await fake.close();
  }
});

// ─── restart-safe authentication ─────────────────────────────────────────────
//
// A computer used to need ERP_DEVICE_PASSWORD in its environment on every launch, because the
// tokens lived in memory and died with the process. The refresh token is now handed out through a
// sink so the desktop can store it encrypted, and handed back on the next start. These tests pin
// the four cases that matter: first run, restart, a stored token that is refused, and a machine
// that has neither.

test("a first sign-in hands out the refresh token, so it can be stored", async () => {
  const fake = await startFakeSupabase();
  try {
    const given: Array<{ refreshToken: string; userId?: string }> = [];
    const auth = new SupabaseDeviceAuth(
      { url: fake.url, anonKey: ANON_KEY, email: "pc1@example.invalid", password: PASSWORD },
      () => 1_000_000,
      (session) => given.push({ refreshToken: session.refreshToken, userId: session.userId })
    );

    await auth.accessToken();

    assert.equal(given.length, 1, "the sink is told exactly once for one sign-in");
    assert.equal(given[0]?.refreshToken, "refresh-value");
    // The password is never offered to the sink -- there is no parameter that could carry one.
    assert.ok(!JSON.stringify(given).includes(PASSWORD));
  } finally {
    await fake.close();
  }
});

test("a restart signs in from the stored token, and never asks for the password", async () => {
  const fake = await startFakeSupabase();
  try {
    // The state after a restart: the credential file has a refresh token, and the environment has
    // no password at all.
    const auth = new SupabaseDeviceAuth(
      { url: fake.url, anonKey: ANON_KEY, refreshToken: "stored-refresh-value" },
      () => 1_000_000
    );
    assert.equal(auth.canAuthenticate, true, "a stored token is enough on its own");

    const token = await auth.accessToken();

    assert.equal(token, ACCESS_TOKEN);
    const grants = fake.calls.filter((c) => c.path.startsWith("/auth/v1/token")).map((c) => c.path);
    assert.deepEqual(
      grants.filter((p) => p.includes("password")),
      [],
      "no password grant was attempted, because there is no password to attempt it with"
    );
    assert.equal(grants.filter((p) => p.includes("refresh_token")).length, 1);
    // And the token it sent was the stored one.
    const refresh = fake.calls.find((c) => c.path.includes("refresh_token"));
    assert.match(refresh?.body ?? "", /stored-refresh-value/);
  } finally {
    await fake.close();
  }
});

test("a stored token that is refused falls back to the password when there is one", async () => {
  const fake = await startFakeSupabase();
  try {
    const auth = new SupabaseDeviceAuth(
      {
        url: fake.url,
        anonKey: ANON_KEY,
        email: "pc1@example.invalid",
        password: PASSWORD,
        refreshToken: "a-revoked-token",
      },
      () => 1_000_000
    );
    fake.reply("grant_type=refresh_token", 400, { error: "invalid_grant", error_description: "refresh token revoked" });

    const token = await auth.accessToken();

    assert.equal(token, ACCESS_TOKEN, "the pass still goes through");
    const grants = fake.calls.filter((c) => c.path.startsWith("/auth/v1/token")).map((c) => c.path);
    assert.equal(grants.filter((p) => p.includes("refresh_token")).length, 1, "the stored token was tried first");
    assert.equal(grants.filter((p) => p.includes("password")).length, 1, "and the password rescued it");
  } finally {
    await fake.close();
  }
});

test("a refused stored token with no password to fall back to is reported, not swallowed", async () => {
  const fake = await startFakeSupabase();
  try {
    const auth = new SupabaseDeviceAuth(
      { url: fake.url, anonKey: ANON_KEY, refreshToken: "a-revoked-token" },
      () => 1_000_000
    );
    fake.reply("grant_type=refresh_token", 400, { error: "invalid_grant", error_description: "refresh token revoked" });

    // Quietly falling back is right only when there IS something to fall back to. Here this is
    // the whole answer, and the operator has to be told the credential needs replacing.
    await assert.rejects(() => auth.accessToken(), SupabaseAuthError);
  } finally {
    await fake.close();
  }
});

test("a computer with neither a credential nor a password says so before any request", async () => {
  const fake = await startFakeSupabase();
  try {
    const auth = new SupabaseDeviceAuth({ url: fake.url, anonKey: ANON_KEY }, () => 1_000_000);
    assert.equal(auth.canAuthenticate, false);

    await assert.rejects(
      () => auth.accessToken(),
      (error: unknown) =>
        error instanceof SupabaseAuthError && /no cloud credential and no device password/i.test(error.message)
    );
    assert.deepEqual(
      fake.calls.filter((c) => c.path.startsWith("/auth/v1/token")),
      [],
      "it did not guess at a sign-in it has nothing to make"
    );
  } finally {
    await fake.close();
  }
});

test("a rotated refresh token is handed out again, so the stored one keeps up", async () => {
  const fake = await startFakeSupabase();
  try {
    let clock = 1_000_000;
    const given: string[] = [];
    const auth = new SupabaseDeviceAuth(
      { url: fake.url, anonKey: ANON_KEY, email: "pc1@example.invalid", password: PASSWORD },
      () => clock,
      (session) => given.push(session.refreshToken)
    );

    await auth.accessToken();
    clock += 3_600_000; // past expiry, so the next call refreshes
    await auth.accessToken();

    assert.equal(given.length, 2, "every session is offered, not just the first");
    assert.deepEqual(given, ["refresh-value", "refresh-value"]);
  } finally {
    await fake.close();
  }
});

test("signOut keeps the stored credential; forgetting it is a separate, deliberate act", async () => {
  const fake = await startFakeSupabase();
  try {
    const auth = new SupabaseDeviceAuth(
      { url: fake.url, anonKey: ANON_KEY, refreshToken: "stored-refresh-value" },
      () => 1_000_000
    );
    await auth.accessToken();

    // A 401 drops the session so the next call re-authenticates. It must NOT throw the device's
    // credential away: one refused request says nothing about the refresh token.
    auth.signOut();
    assert.equal(auth.signedIn, false);
    assert.equal(auth.canAuthenticate, true, "it can still resume from the stored token");

    auth.forgetStoredCredential();
    assert.equal(auth.canAuthenticate, false, "and only this discards it");
  } finally {
    await fake.close();
  }
});

test("a refused sign-in reports the service's reason and never the password", async () => {
  const fake = await startFakeSupabase();
  try {
    const { auth } = build(fake);
    fake.reply("grant_type=password", 400, { error_description: "Invalid login credentials" });

    await assert.rejects(
      () => auth.accessToken(),
      (error: Error) => {
        assert.match(error.message, /Invalid login credentials/);
        assert.equal(error.message.includes(PASSWORD), false, "the password must never appear");
        return true;
      }
    );
  } finally {
    await fake.close();
  }
});

// ─── the claim ──────────────────────────────────────────────────────────────

test("a device claims its identity before anything is sent, and holds the epoch it is given", async () => {
  const fake = await startFakeSupabase();
  try {
    const { transport } = build(fake);
    assert.equal(transport.claimed, false);

    const outcome = await transport.claimDevice({
      deviceId: "desktop-main",
      workstationId: "ws-prod-01",
      appVersion: "0.3.0",
      numberBlock: 1,
    });

    assert.deepEqual(outcome, { ok: true, epoch: 1, holder: "holder-1" });
    assert.equal(transport.claimed, true);

    const call = fake.calls.find((entry) => entry.path === "/rest/v1/rpc/claim_device");
    assert.ok(call, "it claims through the RPC migration 006 defines");
    assert.equal(call?.headers.authorization, `Bearer ${ACCESS_TOKEN}`);
    assert.deepEqual(JSON.parse(call?.body ?? "{}"), {
      p_device_id: "desktop-main",
      p_workstation_id: "ws-prod-01",
      p_app_version: "0.3.0",
      p_number_block: 1,
    });
  } finally {
    await fake.close();
  }
});

test("a refused claim is an answer about the computer, and sends nothing", async () => {
  const fake = await startFakeSupabase();
  try {
    const { transport } = build(fake);
    fake.reply("/rest/v1/rpc/claim_device", 200, { ok: false, reason: "REVOKED" });

    const outcome = await transport.claimDevice({ deviceId: "desktop-main", workstationId: "ws-prod-01", numberBlock: 1 });
    assert.deepEqual(outcome, { ok: false, reason: "REVOKED" });
    assert.equal(transport.claimed, false);

    // And nothing may be offered without one.
    await assert.rejects(() => transport.send([carton("SK9_BLACK_7/10_000001")]), SyncTransportError);
    assert.equal(fake.calls.filter((entry) => entry.path.includes("push_qr_master")).length, 0);
  } finally {
    await fake.close();
  }
});

test("a computer on a number range another computer holds is refused, and told which range", async () => {
  const fake = await startFakeSupabase();
  try {
    const { transport } = build(fake);
    fake.reply("/rest/v1/rpc/claim_device", 200, { ok: false, reason: "NUMBER_BLOCK_TAKEN", block: 1 });

    const outcome = await transport.claimDevice({ deviceId: "desktop-main", workstationId: "ws-prod-01", numberBlock: 1 });
    assert.deepEqual(outcome, { ok: false, reason: "NUMBER_BLOCK_TAKEN", block: 1 });
    assert.equal(transport.claimed, false);
  } finally {
    await fake.close();
  }
});

test("a computer with no number range still asks, and the cloud decides (migration 018)", async () => {
  const fake = await startFakeSupabase();
  try {
    const { transport } = build(fake);
    fake.reply("/rest/v1/rpc/claim_device", 200, { ok: false, reason: "NUMBER_BLOCK_MISSING" });

    const outcome = await transport.claimDevice({ deviceId: "desktop-main", workstationId: "ws-prod-01", numberBlock: null });
    assert.deepEqual(outcome, { ok: false, reason: "NUMBER_BLOCK_MISSING" });
    const call = fake.calls.find((entry) => entry.path === "/rest/v1/rpc/claim_device");
    assert.equal(JSON.parse(call?.body ?? "{}").p_number_block, null, "sent as null, never left out or guessed");
  } finally {
    await fake.close();
  }
});

// ─── the heartbeat ──────────────────────────────────────────────────────────

test("a computer that already holds the claim confirms it, and never claims a second time", async () => {
  const fake = await startFakeSupabase();
  try {
    const transport = await claimed(fake);

    const first = await transport.heartbeatDevice();
    const second = await transport.heartbeatDevice();

    // The epoch it reports is the one it has held all along, not a new one.
    assert.deepEqual(first, { ok: true, epoch: 1, holder: "holder-1" });
    assert.deepEqual(second, { ok: true, epoch: 1, holder: "holder-1" });
    assert.equal(transport.claimed, true);

    // ONE claim for the life of the process. This is the whole point: claim_device bumps the
    // epoch and writes two audit rows, so a pass that re-claimed buried a real takeover in its
    // own noise and grew device_claim_events for ever.
    assert.equal(fake.calls.filter((entry) => entry.path === "/rest/v1/rpc/claim_device").length, 1);

    const beats = fake.calls.filter((entry) => entry.path === "/rest/v1/rpc/heartbeat_device");
    assert.equal(beats.length, 2);
    assert.deepEqual(JSON.parse(beats[0]?.body ?? "{}"), { p_epoch: 1, p_holder: "holder-1" });
  } finally {
    await fake.close();
  }
});

test("a heartbeat with no claim to confirm says so, and sends nothing", async () => {
  const fake = await startFakeSupabase();
  try {
    const { transport } = build(fake);

    assert.deepEqual(await transport.heartbeatDevice(), { ok: false, reason: "NOT_CLAIMED" });
    assert.equal(fake.calls.filter((entry) => entry.path.includes("heartbeat_device")).length, 0);
  } finally {
    await fake.close();
  }
});

test("a heartbeat refused because another computer took the enrolment drops the claim", async () => {
  const fake = await startFakeSupabase();
  try {
    const transport = await claimed(fake);
    fake.supersede(); // another installation claims the same enrolment

    const outcome = await transport.heartbeatDevice();
    assert.equal(outcome.ok, false);
    assert.match(outcome.ok ? "" : outcome.reason, /CLAIM_SUPERSEDED/);

    // The claim is dropped, which is what makes the caller take a fresh one rather than push
    // against an epoch the service has stopped recognising.
    assert.equal(transport.claimed, false);
  } finally {
    await fake.close();
  }
});

test("a heartbeat the service never answered keeps the claim: unreachable is not a verdict", async () => {
  const fake = await startFakeSupabase();
  const transport = await claimed(fake);
  await fake.close();

  await assert.rejects(() => transport.heartbeatDevice(), SyncTransportError);
  // An hour of bad internet must not cost this computer its identity.
  assert.equal(transport.claimed, true);
});

// ─── push ───────────────────────────────────────────────────────────────────

test("a variant travels ahead of its carton, so a new product's first carton is accepted", async () => {
  const fake = await startFakeSupabase();
  try {
    const transport = await claimed(fake);

    // Handed over carton-first on purpose. This is the failure of 2026-10-22: SK46 BLACK 4/6 was
    // created at 17:26:22 and scanned at 17:26:32, and the carton was refused
    // UNKNOWN_PRODUCT_VARIANT because the cloud had never been told about the product.
    const acks = await transport.send([carton("SK46_BLACK_4/6_000001", undefined, NEW_VARIANT), variant(NEW_VARIANT)]);

    assert.equal(acks.length, 2);
    for (const ack of acks) assert.equal(ack.accepted, true, ack.reason ?? "both must be accepted");

    // The order on the wire is the prerequisite order, whatever order the caller used.
    const paths = fake.calls.map((entry) => entry.path);
    assert.ok(
      paths.indexOf("/rest/v1/rpc/push_product_variant") < paths.indexOf("/rest/v1/rpc/push_qr_master"),
      "the product must reach the cloud before a carton of it"
    );
  } finally {
    await fake.close();
  }
});

test("a variant carries its identity and NO price: the client cannot send the company's pricing", async () => {
  const fake = await startFakeSupabase();
  try {
    const transport = await claimed(fake);
    await transport.send([variant(NEW_VARIANT)]);

    const call = fake.calls.find((entry) => entry.path === "/rest/v1/rpc/push_product_variant");
    const args = JSON.parse(call?.body ?? "{}") as { p_rows: Array<Record<string, unknown>> };
    assert.deepEqual(args.p_rows, [
      {
        id: NEW_VARIANT,
        article: "SK46",
        color: "BLACK",
        size: "4/6",
        description: "SK46 BLACK 4/6",
        created_at: "2026-10-16T07:59:00.000Z",
      },
    ]);
    // Identity only. Migration 008 writes `status` itself and declares no price argument at all,
    // so there is no field through which a sale price could travel even by mistake.
    const sent = JSON.stringify(args.p_rows);
    for (const forbidden of ["price", "cost", "paisa", "status"]) {
      assert.ok(!sent.includes(forbidden), `a variant push must not carry ${forbidden}`);
    }
  } finally {
    await fake.close();
  }
});

test("a variant the cloud already holds is accepted again and lands once", async () => {
  const fake = await startFakeSupabase();
  try {
    const transport = await claimed(fake);
    assert.equal((await transport.send([variant(NEW_VARIANT)]))[0]?.accepted, true);
    // DUPLICATE is still "it is in the cloud", so the row leaves the queue rather than retrying.
    assert.equal((await transport.send([variant(NEW_VARIANT)]))[0]?.accepted, true);

    // A variant is not a business event, so it is not in the log either way.
    assert.equal((await transport.fetchChanges(0, 50)).length, 0);
  } finally {
    await fake.close();
  }
});

test("the same product under another id is a bounded refusal, and never stalls the queue", async () => {
  const fake = await startFakeSupabase();
  try {
    const transport = await claimed(fake);
    // What 008 answers when another computer already created this product under its own id:
    // product_variants carries UNIQUE (article, color, size) as well as its primary key.
    fake.reply("/rest/v1/rpc/push_product_variant", 200, {
      ok: true,
      epoch: 1,
      results: [{ id: NEW_VARIANT, outcome: "REFUSED", reason: "VARIANT_IDENTITY_CLASH" }],
    });

    const acks = await transport.send([variant(NEW_VARIANT)]);

    assert.equal(acks[0]?.accepted, false);
    assert.match(acks[0]?.reason ?? "", /VARIANT_IDENTITY_CLASH/);
    // REFUSED, not TRANSIENT. Transient attempts are unbounded, so classifying a clash that way
    // would retry a thing no retry can fix for ever and the queue behind it would never move.
    assert.equal(acks[0]?.failure, "REFUSED", "a clash must spend the bounded budget and park");
  } finally {
    await fake.close();
  }
});

test("a variant whose payload is unreadable is refused and never sent", async () => {
  const fake = await startFakeSupabase();
  try {
    const transport = await claimed(fake);
    const broken: SyncEnvelope = { ...variant(NEW_VARIANT), payload: { variantId: NEW_VARIANT, article: "SK46" } };

    const acks = await transport.send([broken]);
    assert.equal(acks[0]?.accepted, false);
    assert.equal(fake.calls.filter((entry) => entry.path.includes("push_product_variant")).length, 0);
  } finally {
    await fake.close();
  }
});

test("a carton is pushed through the RPC, carrying the claim and only the contract fields", async () => {
  const fake = await startFakeSupabase();
  try {
    const transport = await claimed(fake);
    const acks = await transport.send([carton("SK9_BLACK_7/10_000001")]);

    assert.deepEqual(acks, [{ dedupeKey: qrMasterDedupeKey("SK9_BLACK_7/10_000001"), accepted: true }]);

    const push = fake.calls.find((call) => call.path === "/rest/v1/rpc/push_qr_master");
    assert.ok(push, "it calls the RPC, not the table: 006 revokes the insert");
    assert.equal(fake.calls.filter((call) => call.path.startsWith("/rest/v1/qr_master")).length, 0);
    assert.equal(push?.headers.apikey, ANON_KEY);
    assert.equal(push?.headers.authorization, `Bearer ${ACCESS_TOKEN}`);

    assert.deepEqual(JSON.parse(push?.body ?? "{}"), {
      p_epoch: 1,
      p_holder: "holder-1",
      p_rows: [
        {
          qr_id: "SK9_BLACK_7/10_000001",
          product_variant_id: "variant-sk9-black-7-10",
          // The opening state is NOT sent: migration 006 writes PRODUCED / FACTORY itself, so
          // there is no argument through which a client could ask for another.
          created_at: "2026-10-16T08:00:00.000Z",
        },
      ],
    });
  } finally {
    await fake.close();
  }
});

test("pushing the same carton twice is accepted twice and lands once", async () => {
  const fake = await startFakeSupabase();
  try {
    const transport = await claimed(fake);
    const envelope = carton("SK9_BLACK_7/10_000001");
    assert.equal((await transport.send([envelope]))[0]?.accepted, true);
    // The second answer is DUPLICATE, which is still "it is in the cloud" and still an ack.
    assert.equal((await transport.send([envelope]))[0]?.accepted, true);

    const changes = await transport.fetchChanges(0, 50);
    assert.equal(changes.length, 1, "on conflict do nothing means one row and one log position");
  } finally {
    await fake.close();
  }
});

test("a missing product variant is a bounded refusal naming the cause, not a retry", async () => {
  const fake = await startFakeSupabase();
  try {
    const transport = await claimed(fake);
    const acks = await transport.send([carton("SK46_GREY_6/9_000001", "2026-10-16T08:00:00.000Z", "variant-nobody-seeded")]);

    assert.equal(acks[0]?.accepted, false);
    assert.equal(acks[0]?.failure, "REFUSED", "retrying cannot create the product");
    assert.match(acks[0]?.reason ?? "", /UNKNOWN_PRODUCT_VARIANT/);
  } finally {
    await fake.close();
  }
});

test("one refused carton in a batch does not stop the good ones", async () => {
  const fake = await startFakeSupabase();
  try {
    const transport = await claimed(fake);
    const acks = await transport.send([
      carton("SK46_GREY_6/9_000001", "2026-10-16T08:00:00.000Z", "variant-nobody-seeded"),
      carton("SK9_BLACK_7/10_000003"),
    ]);
    const byKey = new Map(acks.map((ack) => [ack.dedupeKey, ack]));

    assert.equal(byKey.get(qrMasterDedupeKey("SK46_GREY_6/9_000001"))?.accepted, false);
    assert.equal(byKey.get(qrMasterDedupeKey("SK9_BLACK_7/10_000003"))?.accepted, true, "the good one still lands");
    // ONE call, not a batch attempt followed by a row at a time: the RPC answers per row.
    assert.equal(fake.calls.filter((call) => call.path === "/rest/v1/rpc/push_qr_master").length, 1);
    assert.equal((await transport.fetchChanges(0, 50)).length, 1);
  } finally {
    await fake.close();
  }
});

test("a row the service did not answer for is never acknowledged", async () => {
  const fake = await startFakeSupabase();
  try {
    const transport = await claimed(fake);
    // An answer that mentions one of the two cartons offered.
    fake.reply("/rest/v1/rpc/push_qr_master", 200, {
      ok: true,
      epoch: 1,
      results: [{ qr_id: "SK9_BLACK_7/10_000001", outcome: "INSERTED" }],
    });

    const acks = await transport.send([carton("SK9_BLACK_7/10_000001"), carton("SK9_BLACK_7/10_000002")]);
    assert.deepEqual(acks.map((ack) => ack.dedupeKey), [qrMasterDedupeKey("SK9_BLACK_7/10_000001")]);
    // The drain reads a missing ack as undeliverable and offers it again, which is the only
    // safe reading of silence. Nothing is invented for it here.
  } finally {
    await fake.close();
  }
});

test("a superseded claim is retryable, and never spends an event's refusal budget", async () => {
  const fake = await startFakeSupabase();
  try {
    const transport = await claimed(fake);
    // Another computer claims the same enrolment. The server bumps the epoch; this one is now
    // holding a stale ticket, and migration 006 raises CLAIM_SUPERSEDED with errcode 42501 --
    // the very code that means "permanent refusal" for an ordinary write.
    fake.supersede();

    await assert.rejects(
      () => transport.send([carton("SK9_BLACK_7/10_000009")]),
      (error: unknown) => {
        assert.ok(error instanceof SyncTransportError, "thrown, so the drain gives the whole batch back");
        assert.match(error.message, /CLAIM_SUPERSEDED/);
        return true;
      }
    );
    assert.equal((await transport.fetchChanges(0, 50)).length, 0, "and nothing was written");
  } finally {
    await fake.close();
  }
});

test("a revoked device is retryable too: revocation must not park a queue", async () => {
  const fake = await startFakeSupabase();
  try {
    const transport = await claimed(fake);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      fake.reply("/rest/v1/rpc/push_qr_master", 403, { code: "42501", message: "REVOKED" });
    }
    await assert.rejects(() => transport.send([carton("SK9_BLACK_7/10_000010")]), SyncTransportError);
  } finally {
    await fake.close();
  }
});

test("a service that is unwell is a retryable failure, not a refusal", async () => {
  const fake = await startFakeSupabase();
  try {
    const transport = await claimed(fake);
    fake.reply("/rest/v1/rpc/push_qr_master", 503, { message: "service unavailable" });
    await assert.rejects(() => transport.send([carton("SK9_BLACK_7/10_000004")]), SyncTransportError);
    // Nothing was acknowledged, so the drain puts the whole batch back.
  } finally {
    await fake.close();
  }
});

test("a production scan is pushed through its own RPC, with every column the migration reads", async () => {
  const fake = await startFakeSupabase();
  try {
    const transport = await claimed(fake);
    const acks = await transport.send([scan("event-1", "SK9_BLACK_7/10_000001")]);

    assert.deepEqual(acks, [{ dedupeKey: "PRODUCTION_PRODUCED:event-1", accepted: true }]);
    const push = fake.calls.find((call) => call.path === "/rest/v1/rpc/push_production_produced");
    assert.ok(push, "production scans go through push_production_produced");

    const sent = JSON.parse(push?.body ?? "{}") as Record<string, unknown>;
    assert.equal(sent.p_epoch, 1);
    assert.equal(sent.p_holder, "holder-1");
    // The keys are the column names migration 006 reads out of each row. The contract's own
    // field names are camelCase, and the mapping is what this asserts.
    assert.deepEqual(Object.keys((sent.p_rows as Array<Record<string, unknown>>)[0] ?? {}).sort(), [
      "article_snapshot",
      "color_snapshot",
      "created_at",
      "device_id",
      "event_date",
      "event_hour",
      "event_ts_local",
      "factory_id",
      "id",
      "metadata_json",
      "operator_id",
      "product_variant_id",
      "qr_id",
      "serial_snapshot",
      "size_snapshot",
      "source_app",
      "workstation_id",
    ]);
  } finally {
    await fake.close();
  }
});

test("a scan the server refuses for the wrong workstation is bounded, and named", async () => {
  const fake = await startFakeSupabase();
  try {
    const transport = await claimed(fake);
    fake.reply("/rest/v1/rpc/push_production_produced", 200, {
      ok: true,
      epoch: 1,
      results: [{ id: "event-1", outcome: "REFUSED", reason: "WRONG_WORKSTATION" }],
    });

    const acks = await transport.send([scan("event-1", "SK9_BLACK_7/10_000001")]);
    assert.equal(acks[0]?.accepted, false);
    assert.equal(acks[0]?.failure, "REFUSED");
    assert.match(acks[0]?.reason ?? "", /WRONG_WORKSTATION/);
  } finally {
    await fake.close();
  }
});

test("an event type with no contract at all is refused without being parked", async () => {
  const fake = await startFakeSupabase();
  try {
    const transport = await claimed(fake);
    const acks = await transport.send([
      { ...carton("SK9_BLACK_7/10_000005"), aggregateType: "DISPATCH_EVENT", dedupeKey: "DISPATCH_EVENT:d-1" },
    ]);

    assert.equal(acks[0]?.accepted, false);
    assert.equal(acks[0]?.failure, "TRANSIENT", "it is a good event this transport cannot carry yet");
    assert.match(acks[0]?.reason ?? "", /NOT_SENDABLE_YET/);
    // The five types that HAVE contracts are claimed; the four that do not are left alone.
    // Order matters and is the order leaseBatch claims them in: a variant before a carton of it,
    // a carton before a scan of it, a label run before a packet of it, a material before a
    // movement of it.
    assert.deepEqual(
      [...SUPABASE_PUSHABLE_AGGREGATES],
      [
        "PRODUCT_VARIANT", "QR_MASTER", "PRODUCTION_PRODUCED", "RAW_MATERIAL_QR_BATCH", "RAW_MATERIAL_QR",
        "PARTY_GROUP", "INVENTORY_UNIT", "WORK_SECTION", "UNIT_LADDER_PRESET", "INVENTORY_CATEGORY", "PARTY", "INVENTORY_ITEM", "MACHINE",
        "STOCK_EVENT",
      ]
    );
    for (const absent of ["PRODUCTION_EVENT", "DISPATCH_EVENT", "RETURN_EVENT", "PROJECTION"]) {
      assert.ok(!SUPABASE_PUSHABLE_AGGREGATES.includes(absent), `${absent} has no contract and must not be claimed`);
    }
  } finally {
    await fake.close();
  }
});

// ─── waiting is not refusing ─────────────────────────────────────────────────

test("a scan whose carton has not reached the cloud yet WAITS, and is never parked for it", async () => {
  const fake = await startFakeSupabase();
  try {
    const transport = await claimed(fake);
    fake.reply("/rest/v1/rpc/push_production_produced", 200, {
      ok: true,
      epoch: 1,
      results: [{ id: "event-1", outcome: "REFUSED", reason: "QR_NOT_REGISTERED_YET" }],
    });

    const acks = await transport.send([scan("event-1", "SK9_BLACK_7/10_000001")]);

    assert.equal(acks.length, 1);
    assert.equal(acks[0]?.accepted, false);
    assert.match(acks[0]?.reason ?? "", /QR_NOT_REGISTERED_YET/);
    // The whole point: bounded, this parked a good scan after five passes. The carton is simply
    // not there YET, and leaseBatch now sends identities first so it should not arise at all --
    // but a batch boundary or an interrupted pass must cost a wait, not the event.
    assert.equal(acks[0]?.failure, "TRANSIENT");
  } finally {
    await fake.close();
  }
});

test("every other refusal stays bounded, including one the service invents later", async () => {
  const fake = await startFakeSupabase();
  try {
    const transport = await claimed(fake);
    for (const reason of [
      "WRONG_FACTORY",
      "WRONG_WORKSTATION",
      "WRONG_DEVICE",
      "UNKNOWN_PRODUCT_VARIANT",
      "UNKNOWN_OPERATOR",
      "PAYLOAD_INCOMPLETE",
      "SOMETHING_NEW_FROM_A_LATER_MIGRATION",
    ]) {
      fake.reply("/rest/v1/rpc/push_production_produced", 200, {
        ok: true,
        epoch: 1,
        results: [{ id: "event-1", outcome: "REFUSED", reason }],
      });
      const acks = await transport.send([scan("event-1", "SK9_BLACK_7/10_000001")]);
      assert.equal(acks[0]?.accepted, false, reason);
      assert.equal(acks[0]?.failure, "REFUSED", `${reason} is a verdict on the event, not a wait`);
    }
  } finally {
    await fake.close();
  }
});

test("a refused CALL says so, so the drain can park the batch instead of retrying for ever", async () => {
  const fake = await startFakeSupabase();
  try {
    const transport = await claimed(fake);
    // 23514 is in PERMANENT_CODES and is not a claim refusal: the service looked at this call and
    // said no for a reason repeating it cannot change.
    fake.reply("/rest/v1/rpc/push_qr_master", 400, { code: "23514", message: "check violation" });

    await assert.rejects(
      () => transport.send([carton("SK9_BLACK_7/10_000009")]),
      (error: unknown) => {
        assert.ok(error instanceof SyncTransportError, "the drain only reads SyncTransportError");
        assert.equal(error.failure, "REFUSED", "the classification travels on the error");
        return true;
      }
    );
  } finally {
    await fake.close();
  }
});

test("a claim refusal thrown from a push is still transient, whatever its errcode", async () => {
  const fake = await startFakeSupabase();
  try {
    const transport = await claimed(fake);
    // CLAIM_SUPERSEDED also arrives as 42501, which is in PERMANENT_CODES -- the claim-refusal
    // list has to win, or a revoked device parks every carton it was holding.
    fake.reply("/rest/v1/rpc/push_qr_master", 403, { code: "42501", message: "CLAIM_SUPERSEDED" });

    await assert.rejects(
      () => transport.send([carton("SK9_BLACK_7/10_000010")]),
      (error: unknown) => {
        assert.ok(error instanceof SyncTransportError);
        assert.notEqual(error.failure, "REFUSED", "a device problem must never park an event");
        return true;
      }
    );
  } finally {
    await fake.close();
  }
});

test("a write refused for want of a number range is the device's problem, never the event's", async () => {
  const fake = await startFakeSupabase();
  try {
    const transport = await claimed(fake);
    // A claim taken before 018 was applied: every write is refused until the next claim registers one.
    fake.reply("/rest/v1/rpc/push_qr_master", 403, { code: "42501", message: "NUMBER_BLOCK_NOT_REGISTERED" });

    await assert.rejects(
      () => transport.send([carton("SK9_BLACK_7/10_000011")]),
      (error: unknown) => {
        assert.ok(error instanceof SyncTransportError);
        assert.notEqual(error.failure, "REFUSED", "a device problem must never park an event");
        return true;
      }
    );
  } finally {
    await fake.close();
  }
});

// ─── pull ───────────────────────────────────────────────────────────────────

test("changes are read from the log after the cursor, in order, as envelopes", async () => {
  const fake = await startFakeSupabase();
  try {
    const transport = await claimed(fake);
    await transport.send([carton("SK9_BLACK_7/10_000001"), carton("SK9_BLACK_7/10_000002")]);

    const all = await transport.fetchChanges(0, 50);
    assert.deepEqual(all.map((change) => change.seq), [1, 2]);
    assert.equal(all[0]?.envelope.aggregateType, "QR_MASTER");
    assert.equal(all[0]?.envelope.dedupeKey, qrMasterDedupeKey("SK9_BLACK_7/10_000001"));
    assert.deepEqual(all[0]?.envelope.payload, {
      qrId: "SK9_BLACK_7/10_000001",
      productVariantId: "variant-sk9-black-7-10",
      createdAt: "2026-10-16T08:00:00.000Z",
    });
    // qr_master has no device column, so the log has no origin for a carton. Nothing decides
    // anything from it, and an empty string would fail the envelope's own shape check.
    assert.equal(all[0]?.envelope.originDeviceId, "cloud");

    const after = await transport.fetchChanges(1, 50);
    assert.deepEqual(after.map((change) => change.seq), [2]);

    const query = fake.calls.filter((call) => call.path.startsWith("/rest/v1/sync_event_log")).pop();
    assert.match(query?.path ?? "", /seq=gt\.1/);
    assert.match(query?.path ?? "", /order=seq\.asc/);
    assert.equal(query?.headers.authorization, `Bearer ${ACCESS_TOKEN}`);
  } finally {
    await fake.close();
  }
});

test("a pull against an unreachable service fails as a transport error", async () => {
  const fake = await startFakeSupabase();
  await fake.close();
  const { transport } = build(fake);
  await assert.rejects(() => transport.fetchChanges(0, 10), SyncTransportError);
});

// ─── secrets ────────────────────────────────────────────────────────────────

test("nothing a failure carries can contain a key, a token or a password", () => {
  const leaky = `apikey: ${ANON_KEY}, authorization: Bearer ${ACCESS_TOKEN}, "password":"${PASSWORD}"`;
  const scrubbed = redactSecrets(leaky);

  assert.equal(scrubbed.includes(ACCESS_TOKEN), false, "a JWT must be scrubbed");
  assert.equal(scrubbed.includes(PASSWORD), false, "a password must be scrubbed");
  assert.match(scrubbed, /\[redacted/);
});

test("the token is sent as a header and never in the path or the body", async () => {
  const fake = await startFakeSupabase();
  try {
    const transport = await claimed(fake);
    await transport.send([carton("SK9_BLACK_7/10_000001")]);
    await transport.fetchChanges(0, 10);

    for (const call of fake.calls) {
      assert.equal(call.path.includes(ACCESS_TOKEN), false, `${call.path} must not carry the token`);
      assert.equal(call.path.includes(ANON_KEY), false, `${call.path} must not carry the key`);
      if (!call.path.startsWith("/auth/")) {
        assert.equal(call.body.includes(ACCESS_TOKEN), false, "no request body may carry the token");
        assert.equal(call.body.includes(PASSWORD), false, "no request body may carry the password");
      }
    }
  } finally {
    await fake.close();
  }
});

// ─── raw material, leased (cloud migrations 011 and 012) ─────────────────────

const RM_AT = "2026-10-25T05:00:00.000Z";

const labelRun = (batchId: string, leaseEpoch: number | null): SyncEnvelope => ({
  dedupeKey: `RAW_MATERIAL_QR_BATCH:${batchId}`,
  aggregateType: "RAW_MATERIAL_QR_BATCH",
  aggregateId: batchId,
  operation: "INSERT",
  payload: {
    batchId, partyId: "party-1", itemId: "item-1", startSequence: 11, endSequence: 12, quantity: 2,
    createdAt: RM_AT, createdBy: "user-1", requestedBy: null,
  },
  originDeviceId: "desktop-main",
  createdAt: RM_AT,
  leaseEpoch,
});

const labelPacket = (qrId: string, batchId: string, leaseEpoch: number | null): SyncEnvelope => ({
  dedupeKey: `RAW_MATERIAL_QR:${qrId}`,
  aggregateType: "RAW_MATERIAL_QR",
  aggregateId: qrId,
  operation: "INSERT",
  payload: {
    qrId, batchId, partyId: "party-1", itemId: "item-1", sequence: 11,
    packingQuantity: 2.5, packingUnitId: "unit-kg", createdAt: RM_AT,
  },
  originDeviceId: "desktop-main",
  createdAt: RM_AT,
  leaseEpoch,
});

const rowsSentTo = (fake: Fake, rpc: string): Array<Record<string, unknown>> =>
  fake.calls
    .filter((call) => call.path === `/rest/v1/rpc/${rpc}`)
    .flatMap((call) => (JSON.parse(call.body) as { p_rows: Array<Record<string, unknown>> }).p_rows);

test("a label run and its packets go with the lease epoch they were written under, the run first", async () => {
  const fake = await startFakeSupabase();
  try {
    const transport = await claimed(fake);
    fake.reply("/rpc/push_raw_material_qr_batch", 200, { ok: true, results: [{ id: "rmb-1", outcome: "INSERTED" }] });
    fake.reply("/rpc/push_raw_material_qr", 200, { ok: true, results: [{ id: "rmq-11", outcome: "INSERTED" }] });

    // Handed over packet first: the transport still sends the run first.
    const acks = await transport.send([labelPacket("rmq-11", "rmb-1", 7), labelRun("rmb-1", 7)]);
    assert.deepEqual(acks.map((ack) => [ack.dedupeKey, ack.accepted]), [
      ["RAW_MATERIAL_QR_BATCH:rmb-1", true],
      ["RAW_MATERIAL_QR:rmq-11", true],
    ]);
    const order = fake.calls.map((call) => call.path).filter((p) => p.includes("raw_material"));
    assert.deepEqual(order, ["/rest/v1/rpc/push_raw_material_qr_batch", "/rest/v1/rpc/push_raw_material_qr"]);

    // Exactly the keys 012 reads, the epoch among them, and no origin device: the cloud takes
    // that from the proven claim.
    assert.deepEqual(rowsSentTo(fake, "push_raw_material_qr_batch"), [{
      id: "rmb-1", party_id: "party-1", item_id: "item-1", start_sequence: 11, end_sequence: 12, quantity: 2,
      created_at: RM_AT, created_by: "user-1", requested_by: null, lease_epoch: 7,
    }]);
    assert.deepEqual(rowsSentTo(fake, "push_raw_material_qr"), [{
      id: "rmq-11", batch_id: "rmb-1", party_id: "party-1", item_id: "item-1", sequence: 11,
      packing_quantity: 2.5, packing_unit_id: "unit-kg", created_at: RM_AT, lease_epoch: 7,
    }]);
  } finally {
    await fake.close();
  }
});

test("a packet whose run has not arrived waits, and a write on a lost lease is refused", async () => {
  const fake = await startFakeSupabase();
  try {
    const transport = await claimed(fake);
    fake.reply("/rpc/push_raw_material_qr_batch", 200, { ok: true, results: [{ id: "rmb-2", outcome: "REFUSED", reason: "NOT_LEASE_HOLDER" }] });
    fake.reply("/rpc/push_raw_material_qr", 200, { ok: true, results: [{ id: "rmq-12", outcome: "REFUSED", reason: "RUN_NOT_REGISTERED_YET" }] });
    const acks = await transport.send([labelRun("rmb-2", 3), labelPacket("rmq-12", "rmb-1", 3)]);
    const byKey = new Map(acks.map((ack) => [ack.dedupeKey, ack]));
    // Taken over: refused, so it is bounded and lands visibly in the dead letters (docs/37 W.3).
    assert.equal(byKey.get("RAW_MATERIAL_QR_BATCH:rmb-2")?.failure, "REFUSED");
    assert.equal(byKey.get("RAW_MATERIAL_QR_BATCH:rmb-2")?.reason, "NOT_LEASE_HOLDER");
    // A prerequisite, not a fault: waits without spending its refusal budget.
    assert.equal(byKey.get("RAW_MATERIAL_QR:rmq-12")?.failure, "TRANSIENT");
  } finally {
    await fake.close();
  }
});

test("a leased row without an epoch is never sent, and waits", async () => {
  const fake = await startFakeSupabase();
  try {
    const transport = await claimed(fake);
    const acks = await transport.send([labelRun("rmb-3", null), labelPacket("rmq-13", "rmb-3", null)]);
    assert.ok(acks.every((ack) => !ack.accepted && ack.failure === "TRANSIENT" && ack.reason === "NO_LEASE_EPOCH"));
    assert.equal(fake.calls.filter((call) => call.path.includes("raw_material")).length, 0, "nothing reached the cloud");
  } finally {
    await fake.close();
  }
});

test("the leases are read from current_leases, and not knowing is an answer, not a failure", async () => {
  const fake = await startFakeSupabase();
  try {
    const transport = await claimed(fake);
    const row = { domain: "RAW_MATERIAL_STORE", holder_device_id: "desktop-main", holder_label: "Store PC", epoch: 7, barrier_seq: 40, granted_at: null };
    fake.reply("/rpc/current_leases", 200, [row]);
    assert.deepEqual(await transport.fetchLeases(), {
      ok: true,
      leases: [{ domain: "RAW_MATERIAL_STORE", holderDeviceId: "desktop-main", holderLabel: "Store PC", epoch: 7, barrierSeq: 40, grantedAt: null }],
    });
    // A project without 011 (production today): carton sync must carry on.
    fake.reply("/rpc/current_leases", 404, { code: "PGRST202", message: "Could not find the function public.current_leases" });
    assert.deepEqual(await transport.fetchLeases(), { ok: false, reason: "NOT_SUPPORTED" });
    fake.reply("/rpc/current_leases", 200, [{ ...row, epoch: "seven" }]);
    assert.deepEqual(await transport.fetchLeases(), { ok: false, reason: "UNREADABLE" });
    // Unreachable or refused is a transport failure, like every other call.
    fake.reply("/rpc/current_leases", 503, { message: "unavailable" });
    await assert.rejects(transport.fetchLeases(), SyncTransportError);
  } finally {
    await fake.close();
  }
});

// ─── master data, whole by revision (cloud migration 013) ───────────────────

const revisionOf = (type: string, recordId: string, revision: number, leaseEpoch: number | null, body: Record<string, unknown> | null): SyncEnvelope => ({
  dedupeKey: `${type}:${recordId}:${String(revision)}`,
  aggregateType: type,
  aggregateId: recordId,
  operation: "INSERT",
  payload: { recordId, revision, deleted: body === null, body },
  originDeviceId: "desktop-main",
  createdAt: RM_AT,
  leaseEpoch,
});

test("master-data revisions go with their epoch, and each answer finds its own revision even for one record twice", async () => {
  const fake = await startFakeSupabase();
  try {
    const transport = await claimed(fake);
    const unit = { row: { id: "u-kg", code: "KG" }, children: { inventory_unit_conversions: [] } };
    fake.reply("/rpc/push_leased_record", 200, {
      ok: true,
      results: [
        { aggregate_type: "INVENTORY_UNIT", record_id: "u-kg", outcome: "INSERTED" },
        { aggregate_type: "INVENTORY_UNIT", record_id: "u-kg", outcome: "SUPERSEDED" },
        { aggregate_type: "PARTY", record_id: "p-1", outcome: "REFUSED", reason: "NOT_LEASE_HOLDER" },
      ],
    });
    const acks = await transport.send([
      revisionOf("INVENTORY_UNIT", "u-kg", 2, 5, unit),
      revisionOf("INVENTORY_UNIT", "u-kg", 1, 5, unit),
      revisionOf("PARTY", "p-1", 1, 4, { row: { id: "p-1", party_name: "Supplier" }, children: {} }),
      revisionOf("PARTY", "p-2", 1, null, { row: { id: "p-2" }, children: {} }),
    ]);
    const byKey = new Map(acks.map((ack) => [ack.dedupeKey, ack]));
    assert.equal(byKey.get("INVENTORY_UNIT:u-kg:2")?.accepted, true);
    assert.equal(byKey.get("INVENTORY_UNIT:u-kg:1")?.accepted, true, "superseded by a newer revision in the cloud: nothing left to send");
    assert.equal(byKey.get("PARTY:p-1:1")?.failure, "REFUSED");
    assert.equal(byKey.get("PARTY:p-1:1")?.reason, "NOT_LEASE_HOLDER");
    assert.equal(byKey.get("PARTY:p-2:1")?.failure, "TRANSIENT", "no epoch: waits, never sent");

    const sentRows = rowsSentTo(fake, "push_leased_record");
    assert.deepEqual(sentRows.map((row) => [row.aggregate_type, row.record_id, row.revision, row.lease_epoch]), [
      ["INVENTORY_UNIT", "u-kg", 2, 5], ["INVENTORY_UNIT", "u-kg", 1, 5], ["PARTY", "p-1", 1, 4],
    ]);
    assert.deepEqual(sentRows[0]?.body, unit);
  } finally {
    await fake.close();
  }
});
