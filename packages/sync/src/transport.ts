// How a batch of events reaches the other side.
//
// An interface, so the drain can be tested against a transport that fails on purpose, plus one
// implementation over plain HTTP using node:http — no new dependency, and nothing cloud-specific.
//
// NO AUTHENTICATION. This transport sends a batch and reads the answer, and that is all. Working
// out who may send what is a real piece of design (see the note at the foot of this file) and
// putting a shared secret in the desktop application would be worse than having none, so none is
// invented here.

import http from "node:http";
import type { SyncEnvelope } from "./contract.js";
import type { FailureKind } from "./outboxQueue.js";
import { asRow } from "./sqlPort.js";

/** What the other side says about each event it was offered. */
export interface SyncAck {
  readonly dedupeKey: string;
  readonly accepted: boolean;
  readonly reason?: string;
  /**
   * Why it was not accepted, which decides whether it can ever be parked. Left out on a
   * refusal, it is read as REFUSED -- the bounded case -- never as PERMANENT, because guessing
   * "never" is how a good event stops being sent.
   */
  readonly failure?: FailureKind;
}

export interface SyncTransport {
  /** Resolves with one answer per envelope, or rejects when the batch did not get through. */
  send(envelopes: readonly SyncEnvelope[]): Promise<SyncAck[]>;
}

/** One event as the service hands it out, with the position that identifies it in the log. */
export interface SyncChange {
  readonly seq: number;
  readonly envelope: SyncEnvelope;
}

export interface SyncPullTransport {
  /**
   * Events after position `afterSeq`, oldest first. The order is the service's to guarantee: a
   * carton identity is pushed before the scan that references it, so it comes back first.
   */
  fetchChanges(afterSeq: number, limit: number): Promise<SyncChange[]>;
}

export class SyncTransportError extends Error {
  /**
   * Why the whole offer failed, when the transport knows.
   *
   * A thrown send hands the entire batch back, and the drain has to decide whether those rows
   * may ever be parked. Left out it is read as TRANSIENT -- the unbounded case -- because a
   * batch that may never have arrived says nothing about the events in it, and guessing
   * "refused" is how good work stops being sent. The opposite default to SyncAck.failure, and
   * for the opposite reason: there, a named refusal IS evidence about one event.
   */
  constructor(message: string, readonly failure?: FailureKind) {
    super(message);
    this.name = "SyncTransportError";
  }
}

export interface HttpSyncTransportOptions {
  /** Host and port of the receiving service. */
  readonly host: string;
  readonly port: number;
  readonly path?: string;
  readonly timeoutMs?: number;
}

export class HttpSyncTransport implements SyncTransport, SyncPullTransport {
  constructor(private readonly options: HttpSyncTransportOptions) {}

  /** Events the service holds after `afterSeq`. Anything unreadable is a transport failure. */
  async fetchChanges(afterSeq: number, limit: number): Promise<SyncChange[]> {
    const raw = await this.get(`/changes?after=${String(afterSeq)}&limit=${String(limit)}`);

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new SyncTransportError("the answer was not readable");
    }
    const record = asRow(parsed);
    const changes = record === null ? null : record.changes;
    if (!Array.isArray(changes)) throw new SyncTransportError("the answer did not contain changes");

    return changes.map((entry) => {
      const change = asRow(entry);
      const seq = Number(change?.seq);
      if (!Number.isFinite(seq)) throw new SyncTransportError("a change had no position");
      // The envelope itself is validated by the applier, which refuses what it cannot read.
      const envelope = asRow(change?.envelope);
      if (envelope === null) throw new SyncTransportError("a change had no event");
      return { seq, envelope: envelope as unknown as SyncEnvelope };
    });
  }

  async send(envelopes: readonly SyncEnvelope[]): Promise<SyncAck[]> {
    const body = JSON.stringify({ envelopes });
    const raw = await this.post(body);

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new SyncTransportError("the answer was not readable");
    }
    const record = asRow(parsed);
    const acks = record === null ? null : record.acks;
    if (!Array.isArray(acks)) throw new SyncTransportError("the answer did not contain acknowledgements");

    return acks.map((entry) => {
      const ack = asRow(entry);
      return {
        dedupeKey: String(ack?.dedupeKey ?? ""),
        accepted: ack?.accepted === true,
        reason: typeof ack?.reason === "string" ? ack.reason : undefined,
        // Only a kind the service actually named is honoured. Anything else is left undefined,
        // and the drain reads that as REFUSED -- bounded and visible -- never as PERMANENT.
        failure:
          ack?.failure === "TRANSIENT" || ack?.failure === "REFUSED" || ack?.failure === "PERMANENT"
            ? ack.failure
            : undefined,
      };
    });
  }

  private get(path: string): Promise<string> {
    return this.request({ method: "GET", path });
  }

  private post(body: string): Promise<string> {
    return this.request({ method: "POST", path: this.options.path ?? "/sync", body });
  }

  /** One request, one answer. A non-2xx status or a dropped connection is a transport failure. */
  private request(input: { method: "GET" | "POST"; path: string; body?: string }): Promise<string> {
    const { body } = input;
    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          host: this.options.host,
          port: this.options.port,
          path: input.path,
          method: input.method,
          headers:
            body === undefined
              ? { accept: "application/json" }
              : { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
          timeout: this.options.timeoutMs ?? 10_000,
        },
        (response) => {
          let text = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            text += chunk;
          });
          response.on("end", () => {
            const status = response.statusCode ?? 0;
            if (status < 200 || status >= 300) {
              reject(new SyncTransportError(`the service answered ${status}`));
              return;
            }
            resolve(text);
          });
        }
      );

      request.on("timeout", () => {
        request.destroy(new SyncTransportError("the service did not answer in time"));
      });
      request.on("error", (error: Error) => {
        reject(error instanceof SyncTransportError ? error : new SyncTransportError(error.message));
      });
      request.end(body);
    });
  }
}

// `path` only names the push endpoint. Changes are always read from /changes beside it.

// WHAT IS STILL MISSING BEFORE THIS COULD CARRY REAL DATA.
//
//   * Authentication and authorisation. Every computer would currently be trusted to send
//     anything. A device needs an identity it can prove, issued when it is enrolled, and the
//     service has to decide per device what it may write. That cannot be a secret compiled into
//     the desktop application, because every installation would then hold the same one.
//   * Transport security. This is plain HTTP, correct for a test on the loopback interface and
//     wrong for anything else.
//
// Pushing and pulling are both here now. Against Supabase the two would become one PostgREST
// call each — an insert with `Prefer: resolution=ignore-duplicates` and a select ordered by the
// log's sequence — carrying the signed-in device's access token, never a service-role key.
