// A RECEIVING SERVICE FOR TESTS ONLY. NOT A SERVICE TO DEPLOY.
//
// It exists so the prototype can be proved end-to-end over a real socket instead of a function
// call: a batch is serialised, crosses a connection, is applied, and the answer comes back. That
// is what makes the durability and retry tests mean something.
//
// What it deliberately does NOT have, and must have before anything like it carries real data:
//
//   * any authentication or authorisation — it applies whatever it is sent
//   * TLS — it speaks plain HTTP
//   * a persisted record of what it applied — exactly-once here rests entirely on the database's
//     primary key, which is sound for QR_MASTER and would not be for an event that is not
//     insert-only
//   * any pull side, ordering guarantee, or multi-tenant separation
//
// It binds to the loopback interface on an operating-system-assigned port, so it is reachable
// only from the machine running the test, and only while the test is running.

import http from "node:http";
import type { AddressInfo } from "node:net";
import { applyEnvelopes } from "./applyEnvelope.js";
import { isSyncEnvelope, type SyncEnvelope } from "./contract.js";
import type { SyncAck } from "./transport.js";
import { asRow, type SyncSqlHandle } from "./sqlPort.js";

/** How the service should misbehave, so the sender's handling of it can be tested. */
export type BackendFault =
  /** Answer normally. */
  | "NONE"
  /** Answer 500 without applying anything. */
  | "SERVER_ERROR"
  /** Apply the batch, then drop the connection so the sender never learns it succeeded. */
  | "APPLY_THEN_DROP"
  /** Accept the connection and never answer. */
  | "HANG";

export interface TestSyncBackend {
  readonly host: string;
  readonly port: number;
  /** Batches received, including ones that were not answered. */
  readonly received: SyncEnvelope[][];
  setFault(fault: BackendFault): void;
  close(): Promise<void>;
}

/**
 * Starts the service over `sql`, the shared store it keeps the business data in.
 *
 * Two endpoints, which together are what a second PC needs:
 *
 *   POST /sync      a batch of events, applied and acknowledged one by one
 *   GET  /changes   the events it holds after a given position, oldest first
 *
 * The log behind /changes is an append-only table the service creates for itself, keyed by an
 * autoincrementing position. Against Supabase this is a table with a bigserial and the position
 * is that sequence — the shape a computer's pull cursor points into.
 *
 * Everything that arrives is validated before it is applied (R25): a batch that is not a list of
 * envelopes is refused as a bad request, and an envelope that does not match the contract is
 * refused per event.
 */
export async function startTestSyncBackend(sql: SyncSqlHandle): Promise<TestSyncBackend> {
  const received: SyncEnvelope[][] = [];
  let fault: BackendFault = "NONE";

  // The ordered log. An event accepted once keeps its position for ever, and a repeat does not
  // get a second one, so every computer reading the log sees the same events in the same order.
  sql.exec(
    `CREATE TABLE IF NOT EXISTS hub_event_log (
       seq INTEGER PRIMARY KEY AUTOINCREMENT,
       dedupe_key TEXT NOT NULL UNIQUE,
       envelope_json TEXT NOT NULL
     )`
  );

  const appendToLog = (envelope: SyncEnvelope): void => {
    sql
      .prepare("INSERT INTO hub_event_log (dedupe_key, envelope_json) VALUES (?, ?) ON CONFLICT(dedupe_key) DO NOTHING")
      .run(envelope.dedupeKey, JSON.stringify(envelope));
  };

  const readLog = (afterSeq: number, limit: number): Array<{ seq: number; envelope: unknown }> =>
    (
      sql
        .prepare("SELECT seq, envelope_json FROM hub_event_log WHERE seq > ? ORDER BY seq ASC LIMIT ?")
        .all(afterSeq, limit) as Array<{ seq: number; envelope_json: string }>
    ).map((row) => ({ seq: Number(row.seq), envelope: JSON.parse(row.envelope_json) as unknown }));

  const server = http.createServer((request, response) => {
    const url = request.url ?? "/";

    if (request.method === "GET" && url.startsWith("/changes")) {
      if (fault === "HANG") return;
      if (fault === "SERVER_ERROR") {
        response.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "faulted" }));
        return;
      }
      const params = new URLSearchParams(url.slice(url.indexOf("?") + 1));
      const after = Number(params.get("after") ?? "0");
      const limit = Number(params.get("limit") ?? "200");
      const changes = readLog(
        Number.isFinite(after) && after >= 0 ? after : 0,
        Number.isFinite(limit) && limit > 0 ? Math.min(limit, 1000) : 200
      );
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ changes }));
      return;
    }

    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      if (fault === "HANG") return;
      if (fault === "SERVER_ERROR") {
        response.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "faulted" }));
        return;
      }

      const envelopes = readEnvelopes(body);
      if (envelopes === null) {
        response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "bad request" }));
        return;
      }
      received.push(envelopes);

      const outcomes = applyEnvelopes(sql, envelopes);
      const acks: SyncAck[] = outcomes.map((outcome) => ({
        dedupeKey: outcome.dedupeKey,
        accepted: outcome.status === "APPLIED" || outcome.status === "DUPLICATE",
        reason: outcome.reason,
        // A refusal the applier called permanent can never be accepted by anything. One it did
        // not is waiting on a prerequisite, which is a delivery problem rather than a verdict on
        // the event, so it is retried for ever rather than parked.
        failure:
          outcome.status === "REJECTED" ? (outcome.permanent === true ? "PERMANENT" : "TRANSIENT") : undefined,
      }));

      // Only what the service actually holds goes into the log, in the order it arrived, so a
      // computer reading the log never sees an event the service itself refused.
      envelopes.forEach((envelope, index) => {
        const outcome = outcomes[index];
        if (outcome && (outcome.status === "APPLIED" || outcome.status === "DUPLICATE")) appendToLog(envelope);
      });

      if (fault === "APPLY_THEN_DROP") {
        // The events are in. The sender will never hear so, which is the case exactly-once has to
        // survive: it will offer them again and the receiver will call them duplicates.
        request.socket.destroy();
        return;
      }

      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ acks }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  return {
    host: "127.0.0.1",
    port: address.port,
    received,
    setFault: (next: BackendFault) => {
      fault = next;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function readEnvelopes(body: string): SyncEnvelope[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const record = asRow(parsed);
  const list = record === null ? null : record.envelopes;
  if (!Array.isArray(list)) return null;
  const envelopes: SyncEnvelope[] = [];
  for (const entry of list) {
    if (!isSyncEnvelope(entry)) return null;
    envelopes.push(entry);
  }
  return envelopes;
}
