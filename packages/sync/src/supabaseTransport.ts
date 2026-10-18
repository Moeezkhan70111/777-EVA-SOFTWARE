// Talking to the real project, over PostgREST, as a signed-in device.
//
// PUSH. Through migration 006's RPCs, never by inserting a row: that migration revokes the
// direct insert, so push_qr_master and push_production_produced are the only way in, and each
// validates this computer's claim in the same transaction as the write. The log is still filled
// by the trigger in migration 003, which is what stops a device forging an entry. A retried
// push is a no-op because the RPCs insert ON CONFLICT DO NOTHING, and each row is answered
// separately so one refusal costs the rest of the batch nothing.
//
// THE CLAIM COMES FIRST. claimDevice() must succeed before send() will try anything: a copied
// enrolment is detected by the server evicting the previous holder, and a write presenting a
// superseded epoch is refused. A refused claim is a verdict on the DEVICE, never on a queued
// event, so it is transient and parks nothing.
//
// PULL. Changes are read from sync_event_log, ordered by seq, from the cursor. The reader may
// walk `seq > cursor` because migration 003's advisory lock makes position order the same as
// commit order — see pull.ts for the argument.
//
// STILL ONLY QR_MASTER IN PRACTICE. Both contracts can now be carried, but
// SUPABASE_PUSHABLE_AGGREGATES still lists carton identities alone, so the drain claims nothing
// else and production scans wait as PENDING rather than being refused into the dead-letter
// queue. Enabling them is a one-line decision, not unwritten work. Anything else that reaches
// `send` is refused as undeliverable, because it has no contract at all.
//
// WHAT IS NEVER LOGGED OR RETURNED. The publishable key and the access token go out in headers
// and come back in nothing. Failures carry the service's own message, scrubbed by redactSecrets.

import { SYNC_AGGREGATE, readProductionProducedPayload, readQrMasterPayload } from "@erp/data";
import type { SyncEnvelope } from "./contract.js";
import { HttpError, readServiceError, redactSecrets, requestJson } from "./httpJson.js";
import type { FailureKind } from "./outboxQueue.js";
import { asRow } from "./sqlPort.js";
import type { SupabaseDeviceAuth } from "./supabaseAuth.js";
import type { SyncAck, SyncChange, SyncPullTransport, SyncTransport } from "./transport.js";
import { SyncTransportError } from "./transport.js";

export interface SupabaseTransportOptions {
  readonly url: string;
  readonly anonKey: string;
  readonly auth: SupabaseDeviceAuth;
  readonly timeoutMs?: number;
}

/** What a successful claim hands back, and what every later write must present. */
interface ClaimHeld {
  readonly epoch: number;
  readonly holder: string;
}

export interface ClaimRequest {
  /** This installation's deviceId, from device-identity.json by way of the scan context. */
  readonly deviceId: string;
  readonly workstationId: string;
  readonly appVersion?: string;
}

export type ClaimOutcome = { readonly ok: true; readonly epoch: number; readonly holder: string } | {
  readonly ok: false;
  /** The server's own word: NOT_ENROLLED, REVOKED, BINDING_INCOMPLETE, DEVICE_MISMATCH, WORKSTATION_MISMATCH. */
  readonly reason: string;
};

/**
 * Refusals that are about the DEVICE rather than about an event. Migration 006 raises each of
 * these with errcode 42501, so they would otherwise be read as "the service refused this
 * carton" and park perfectly good work the moment a device was revoked.
 */
const CLAIM_REFUSALS = new Set([
  "NOT_ENROLLED",
  "REVOKED",
  "BINDING_INCOMPLETE",
  "NOT_CLAIMED",
  "CLAIM_SUPERSEDED",
]);

/**
 * The aggregate types this transport can actually send. The drain is told to claim only these.
 *
 * ORDER MATTERS HERE ONLY AS DOCUMENTATION -- leaseBatch sorts identities first and send() offers
 * cartons before scans. What this list controls is which rows are ever claimed at all.
 *
 * PRODUCTION_PRODUCED joined QR_MASTER once its three prerequisites were met, and not before:
 *
 *   1. leaseBatch claims carton identities ahead of scans, so a scan cannot be offered in a batch
 *      whose carton fell into the next one (outboxQueue.ts).
 *   2. QR_NOT_REGISTERED_YET is TRANSIENT, so an ordering miss makes a scan wait instead of
 *      spending its bounded refusal budget (matchResults below).
 *   3. The drain settles a thrown send by the transport's own classification rather than always
 *      TRANSIENT, so a refused CALL parks instead of retrying for ever (drain.ts).
 *
 * The other four types the outbox can hold -- PRODUCTION_EVENT, DISPATCH_EVENT, RETURN_EVENT,
 * PROJECTION -- stay off this list because they have no contract on either side. They are never
 * claimed, so they wait as PENDING rather than being refused and parked.
 */
export const SUPABASE_PUSHABLE_AGGREGATES: readonly string[] = [
  SYNC_AGGREGATE.QR_MASTER,
  SYNC_AGGREGATE.PRODUCTION_PRODUCED,
];

/**
 * PostgreSQL error codes that mean "sending this again will fail in exactly the same way".
 *
 *   23503 foreign key violation -- the product variant is not in the cloud yet
 *   23514 check violation       -- a value the schema refuses
 *   42501 insufficient privilege -- Row Level Security said no, e.g. the device is not enrolled
 */
const PERMANENT_CODES = new Set(["23503", "23514", "42501"]);

export class SupabaseSyncTransport implements SyncTransport, SyncPullTransport {
  /** The claim this process holds. In memory only, and gone when the process is. */
  private held: ClaimHeld | null = null;

  constructor(private readonly options: SupabaseTransportOptions) {}

  // ─── The claim ────────────────────────────────────────────────────────────

  /**
   * Claims this computer's device identity, and holds the epoch every later write must present.
   *
   * Migration 006 bumps the epoch under a row lock and hands back a fresh holder, so two
   * computers presenting one enrolment evict each other: the loser's next write is refused with
   * CLAIM_SUPERSEDED. Nothing may be sent before this succeeds, and `send` refuses to try.
   *
   * A refusal is an answer about the DEVICE, never about a queued event. The caller stops the
   * pass; it must not let the queue spend attempts on it.
   */
  async claimDevice(request: ClaimRequest): Promise<ClaimOutcome> {
    let response;
    try {
      response = await this.authedRequest((headers) => ({
        url: `${this.base()}/rest/v1/rpc/claim_device`,
        method: "POST",
        headers,
        body: JSON.stringify({
          p_device_id: request.deviceId,
          p_workstation_id: request.workstationId,
          p_app_version: request.appVersion ?? null,
        }),
        timeoutMs: this.options.timeoutMs,
      }));
    } catch (error) {
      throw asTransportError(error);
    }

    if (response.status < 200 || response.status >= 300) {
      throw asTransportError(readServiceError(response.status, response.text));
    }

    const answer = parseJsonObject(response.text, "the claim answer was not readable");
    if (answer.ok !== true) {
      const reason = typeof answer.reason === "string" ? answer.reason : "CLAIM_REFUSED";
      this.held = null;
      return { ok: false, reason };
    }

    const epoch = Number(answer.epoch);
    const holder = typeof answer.holder === "string" ? answer.holder : "";
    if (!Number.isFinite(epoch) || holder === "") {
      throw new SyncTransportError("the claim answer carried no epoch");
    }
    this.held = { epoch, holder };
    return { ok: true, epoch, holder };
  }

  /** True once this computer holds a claim in this process. */
  get claimed(): boolean {
    return this.held !== null;
  }

  // ─── Push ─────────────────────────────────────────────────────────────────

  /**
   * Offers a batch, and answers each event separately.
   *
   * ONE CALL, ONE ANSWER PER ROW. Migration 006's RPCs report INSERTED, DUPLICATE or REFUSED
   * for every row they were given, so the old fast-path/slow-path dance — one batch insert,
   * then a row at a time to find which one PostgREST had refused — is gone. A refusal no longer
   * costs the rest of the batch anything.
   *
   * AN EVENT WITHOUT AN ANSWER IS NOT ACKNOWLEDGED. Nothing is invented for a row the service
   * did not mention: the drain treats a missing ack as undeliverable and offers it again, which
   * is the only safe reading of silence.
   */
  async send(envelopes: readonly SyncEnvelope[]): Promise<SyncAck[]> {
    if (envelopes.length === 0) return [];

    // Structural, not a courtesy: without a claim the server refuses every write anyway, and
    // trying would spend the queue's patience on a question only the claim can answer.
    const held = this.held;
    if (held === null) {
      throw new SyncTransportError("this computer has not claimed its device identity");
    }

    const acks: SyncAck[] = [];
    const cartons: SyncEnvelope[] = [];
    const scans: SyncEnvelope[] = [];

    for (const envelope of envelopes) {
      if (envelope.aggregateType === SYNC_AGGREGATE.QR_MASTER) {
        cartons.push(envelope);
      } else if (envelope.aggregateType === SYNC_AGGREGATE.PRODUCTION_PRODUCED) {
        scans.push(envelope);
      } else {
        acks.push({
          dedupeKey: envelope.dedupeKey,
          accepted: false,
          reason: `NOT_SENDABLE_YET:${envelope.aggregateType}`,
          // The event is fine; this transport cannot carry it yet. Treated as undeliverable so
          // it waits rather than being parked. The drain is told not to claim it at all, so
          // this is a guard rather than a path anything normally takes.
          failure: "TRANSIENT",
        });
      }
    }

    if (cartons.length > 0) acks.push(...(await this.pushCartons(held, cartons)));
    if (scans.length > 0) acks.push(...(await this.pushScans(held, scans)));
    return acks;
  }

  /**
   * Carton identities, through push_qr_master.
   *
   * Only the three fields the contract carries are sent. The opening state is NOT among them:
   * migration 006 writes PRODUCED / FACTORY itself, so there is no argument through which a
   * client could ask for another, and no factory is sent at all — carton identities are global
   * by the decision recorded in migration 005.
   */
  private async pushCartons(held: ClaimHeld, envelopes: readonly SyncEnvelope[]): Promise<SyncAck[]> {
    const rows: Array<Record<string, unknown>> = [];
    const byAggregate = new Map<string, SyncEnvelope>();

    for (const envelope of envelopes) {
      const identity = readQrMasterPayload(envelope.payload);
      if (identity === null) {
        byAggregate.set(`!payload:${envelope.dedupeKey}`, envelope);
        continue;
      }
      byAggregate.set(identity.qrId, envelope);
      rows.push({
        qr_id: identity.qrId,
        product_variant_id: identity.productVariantId,
        created_at: identity.createdAt,
      });
    }

    const acks = envelopesWithUnreadablePayloads(byAggregate);
    if (rows.length === 0) return acks;

    const results = await this.callPush("push_qr_master", held, rows);
    return [...acks, ...matchResults(results, byAggregate, "qr_id")];
  }

  /**
   * Production scans, through push_production_produced.
   *
   * The server checks the factory AND the workstation against this account's enrolment, and
   * writes event_type itself. The keys below are the column names migration 006 reads out of
   * the row object; the contract's own field names are camelCase and are mapped here, exactly
   * as the carton payload is.
   *
   * NOT CLAIMED BY THE DRAIN YET. SUPABASE_PUSHABLE_AGGREGATES still lists only QR_MASTER, so
   * nothing reaches this path in normal operation. It is here, and tested, so that enabling
   * production sync is a one-line decision rather than a piece of unwritten work.
   */
  private async pushScans(held: ClaimHeld, envelopes: readonly SyncEnvelope[]): Promise<SyncAck[]> {
    const rows: Array<Record<string, unknown>> = [];
    const byAggregate = new Map<string, SyncEnvelope>();

    for (const envelope of envelopes) {
      const scan = readProductionProducedPayload(envelope.payload);
      if (scan === null) {
        byAggregate.set(`!payload:${envelope.dedupeKey}`, envelope);
        continue;
      }
      byAggregate.set(scan.eventId, envelope);
      rows.push({
        id: scan.eventId,
        qr_id: scan.qrId,
        product_variant_id: scan.productVariantId,
        event_ts_local: scan.occurredAt,
        event_date: scan.eventDate,
        event_hour: scan.eventHour,
        factory_id: scan.factoryId,
        workstation_id: scan.workstationId,
        operator_id: scan.operatorId,
        device_id: scan.deviceId,
        article_snapshot: scan.article,
        color_snapshot: scan.color,
        size_snapshot: scan.size,
        serial_snapshot: scan.serial,
        metadata_json: scan.metadataJson,
        created_at: scan.createdAt,
        source_app: scan.sourceApp,
      });
    }

    const acks = envelopesWithUnreadablePayloads(byAggregate);
    if (rows.length === 0) return acks;

    const results = await this.callPush("push_production_produced", held, rows);
    return [...acks, ...matchResults(results, byAggregate, "id")];
  }

  /** One RPC call carrying the claim. Throws, so the drain gives the whole batch back. */
  private async callPush(
    rpc: string,
    held: ClaimHeld,
    rows: ReadonlyArray<Record<string, unknown>>
  ): Promise<Array<Record<string, unknown>>> {
    let response;
    try {
      response = await this.authedRequest((headers) => ({
        url: `${this.base()}/rest/v1/rpc/${rpc}`,
        method: "POST",
        headers,
        body: JSON.stringify({ p_epoch: held.epoch, p_holder: held.holder, p_rows: rows }),
        timeoutMs: this.options.timeoutMs,
      }));
    } catch (error) {
      throw asTransportError(error);
    }

    if (response.status < 200 || response.status >= 300) {
      const failure = readServiceError(response.status, response.text);
      // A superseded or revoked claim invalidates the PASS, not the events in it. Thrown so
      // the drain hands every claimed row back as undeliverable.
      const kind = classify(failure);
      if (kind === "TRANSIENT") throw asTransportError(failure);
      // A REFUSED CALL IS SAID OUT LOUD. The kind travels on the error, because the drain
      // settles every row in the batch from it: without this the refusal was invisible there
      // and a call the service will never accept was retried without limit. A bare HttpError
      // used to be thrown here, which the drain could only read as TRANSIENT.
      throw new SyncTransportError(redactSecrets(failure.message), kind);
    }

    const answer = parseJsonObject(response.text, "the push answer was not readable");
    const results = answer.results;
    if (!Array.isArray(results)) throw new SyncTransportError("the push answer carried no results");
    return results.map((entry) => {
      const row = asRow(entry);
      if (row === null) throw new SyncTransportError("a push result was not a row");
      return row;
    });
  }

  // ─── Pull ─────────────────────────────────────────────────────────────────

  async fetchChanges(afterSeq: number, limit: number): Promise<SyncChange[]> {
    const query = new URLSearchParams({
      select: "seq,dedupe_key,aggregate_type,aggregate_id,operation,payload,origin_device_id,logged_at",
      seq: `gt.${String(afterSeq)}`,
      order: "seq.asc",
      limit: String(limit),
    });

    let response;
    try {
      response = await this.authedRequest((headers) => ({
        url: `${this.base()}/rest/v1/sync_event_log?${query.toString()}`,
        method: "GET",
        headers,
        timeoutMs: this.options.timeoutMs,
      }));
    } catch (error) {
      throw asTransportError(error);
    }

    if (response.status < 200 || response.status >= 300) {
      throw asTransportError(readServiceError(response.status, response.text));
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.text);
    } catch {
      throw new SyncTransportError("the answer was not readable");
    }
    if (!Array.isArray(parsed)) throw new SyncTransportError("the answer was not a list of changes");

    return parsed.map((entry) => {
      const row = asRow(entry);
      if (row === null) throw new SyncTransportError("a change was not a row");
      const seq = Number(row.seq);
      if (!Number.isFinite(seq)) throw new SyncTransportError("a change had no position");
      const payload = asRow(row.payload);
      if (payload === null) throw new SyncTransportError("a change had no payload");

      const envelope: SyncEnvelope = {
        dedupeKey: String(row.dedupe_key ?? ""),
        aggregateType: String(row.aggregate_type ?? ""),
        aggregateId: String(row.aggregate_id ?? ""),
        operation: row.operation === "UPDATE" ? "UPDATE" : "INSERT",
        payload,
        // A carton identity carries no device: qr_master has no column for one. "cloud" names
        // where this copy came from, and nothing decides anything from it.
        originDeviceId: typeof row.origin_device_id === "string" && row.origin_device_id !== "" ? row.origin_device_id : "cloud",
        createdAt: String(row.logged_at ?? ""),
      };
      return { seq, envelope };
    });
  }

  // ─── Shared ───────────────────────────────────────────────────────────────

  private base(): string {
    return this.options.url.replace(/\/+$/, "");
  }

  private async headers(): Promise<Record<string, string>> {
    const token = await this.options.auth.accessToken();
    return {
      apikey: this.options.anonKey,
      authorization: `Bearer ${token}`,
    };
  }

  /**
   * One request, and — if the service rejects the token — one more with a fresh one.
   *
   * A cached token can be rejected while this side still believes it is valid: the device
   * account was revoked or disabled, or the clocks disagree. Without this, every retry presented
   * the same rejected token and the event could never go through however long it waited.
   *
   * Exactly one retry, driven by a flag rather than by calling itself, so a service answering
   * 401 to everything costs two requests and not a stack overflow. A second 401 is left as a
   * transient failure: the account may be re-enabled, and nothing is parked for it.
   */
  private async authedRequest(
    build: (headers: Record<string, string>) => Parameters<typeof requestJson>[0]
  ): Promise<{ status: number; text: string }> {
    let refreshed = false;
    for (;;) {
      const response = await requestJson(build(await this.headers()));
      if (response.status !== 401 || refreshed) return response;
      // Throw the token away and sign in again from the credentials.
      this.options.auth.signOut();
      refreshed = true;
    }
  }
}

/**
 * What kind of failure this was.
 *
 * ONLY A RECOGNISED POSTGRESQL ERROR CODE COUNTS AS A REFUSAL. Everything else is treated as
 * undeliverable, so it waits instead of being parked. That matters because an answer this code
 * cannot read is not evidence against the event: a mistyped URL, a captive portal, a proxy
 * returning an HTML 400, or a PostgREST version wording things differently would all otherwise
 * be read as "the service refused this carton" and park perfectly good work.
 *
 * The named codes are the ones that will say exactly the same thing next time:
 *   23503 foreign key violation   -- the product is not in the cloud yet
 *   23514 check violation         -- a value the schema refuses
 *   42501 insufficient privilege  -- Row Level Security said no, e.g. the device is not enrolled
 */
function classify(error: HttpError): FailureKind {
  // CHECKED BEFORE THE CODE, and the order is the whole point. Migration 006 raises these with
  // errcode 42501, which is in the list below -- so without this a revoked or superseded device
  // would spend the refusal budget of every carton it was holding and park the lot. None of
  // them says anything about the event: they say this computer may not write right now.
  if (CLAIM_REFUSALS.has(error.message.trim())) return "TRANSIENT";
  if (error.code !== undefined && PERMANENT_CODES.has(error.code)) return "REFUSED";
  return "TRANSIENT";
}

/** A JSON object body, or a transport error naming what was unreadable. */
function parseJsonObject(text: string, complaint: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SyncTransportError(complaint);
  }
  const row = asRow(parsed);
  if (row === null) throw new SyncTransportError(complaint);
  return row;
}

/** A payload this side could not read is the sender's fault, and saying so again will not help. */
function envelopesWithUnreadablePayloads(byAggregate: Map<string, SyncEnvelope>): SyncAck[] {
  const acks: SyncAck[] = [];
  for (const [key, envelope] of byAggregate) {
    if (!key.startsWith("!payload:")) continue;
    acks.push({ dedupeKey: envelope.dedupeKey, accepted: false, reason: "PAYLOAD_INCOMPLETE", failure: "REFUSED" });
  }
  return acks;
}

/**
 * One ack per row the server answered for, and NOTHING for a row it did not mention.
 *
 * DUPLICATE counts as accepted: the carton is in the cloud, which is the only thing the queue
 * was waiting to learn. REFUSED is bounded, exactly as a 23503 was before -- the service looked
 * at this event and said no for a reason an operator has to fix.
 */
function matchResults(
  results: ReadonlyArray<Record<string, unknown>>,
  byAggregate: Map<string, SyncEnvelope>,
  idKey: string
): SyncAck[] {
  const acks: SyncAck[] = [];
  for (const result of results) {
    const id = typeof result[idKey] === "string" ? (result[idKey] as string) : "";
    const envelope = byAggregate.get(id);
    if (envelope === undefined) continue;
    const outcome = String(result.outcome ?? "");
    if (outcome === "INSERTED" || outcome === "DUPLICATE") {
      acks.push({ dedupeKey: envelope.dedupeKey, accepted: true });
      continue;
    }
    const reason = typeof result.reason === "string" ? result.reason : outcome || "REFUSED";
    acks.push({
      dedupeKey: envelope.dedupeKey,
      accepted: false,
      reason,
      // WAITING IS NOT REFUSING. Every reason push_production_produced can give is a verdict on
      // the event -- wrong factory, wrong workstation, wrong device, an unknown product or
      // operator -- except one: QR_NOT_REGISTERED_YET says the carton has not arrived YET. That
      // is a prerequisite, not a fault, and it resolves itself the moment the identity lands.
      //
      // Bounded, it parked good scans after five passes: leaseBatch now sends identities first,
      // so this should not arise, but "should not" is not a guarantee at a batch boundary or
      // after an interrupted pass. TRANSIENT keeps such a scan waiting instead of losing it,
      // which is the same reading the pull side already takes (applyEnvelope returns
      // permanent: false for exactly this case).
      failure: TRANSIENT_PUSH_REASONS.has(reason) ? "TRANSIENT" : "REFUSED",
    });
  }
  return acks;
}

/**
 * Per-row refusals that mean "not yet", not "no".
 *
 * Deliberately a closed list. Anything the service invents later is REFUSED and bounded, because
 * an unrecognised reason must stop visibly in the dead-letter queue rather than retry for ever.
 */
const TRANSIENT_PUSH_REASONS = new Set(["QR_NOT_REGISTERED_YET"]);

const asTransportError = (error: unknown): SyncTransportError =>
  error instanceof SyncTransportError
    ? error
    : new SyncTransportError(redactSecrets(error instanceof Error ? error.message : "the cloud could not be reached"));
