import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteDatabase } from "./sqliteDatabase.js";

// EVERY STORED event_hour IS THE HOUR ON THE FACTORY'S OWN CLOCK.
//
// The defect: seven writers each derived the hour with `new Date(t).getHours()`, the HOST
// computer's hour. A pilot machine on UTC-7 stored hour 12 for a 19:00Z scan while the machine
// on UTC+5 stored 0 for the same instant, and because a pulled event is replicated verbatim,
// both computers then showed the same wrong hourly breakdown.
//
// event_date is NOT part of this. It is deliberately the UTC date: the day reports narrow on it
// as a UTC range and get their precision from event_ts_local (see productionReceipts.ts,
// storeDailyReport.ts, upperMoveOut.ts). These tests pin that pairing so a future fix to the
// hour cannot quietly "tidy" the date too.

const KARACHI_MIDNIGHT = "2026-10-19T19:00:13.479Z"; // 00:00:13 on the 20th in Karachi
const MINUTE_BEFORE = "2026-10-19T18:59:59.000Z"; // 23:59:59 on the 19th in Karachi

function createDbFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "erp-event-hour-"));
  const db = new SqliteDatabase({
    dbPath: path.join(tempDir, "hours.db"),
    schemaPath: path.resolve(process.cwd(), "src/local-schema.sql"),
  });
  db.setNumberBlock(1, "test");
  db.ensureOperationalContext({
    factoryId: "factory-1",
    factoryCode: "F001",
    factoryName: "Factory",
    workstationId: "workstation-1",
    workstationCode: "WS001",
    workstationName: "WS",
    deviceId: "device-1",
    deviceName: "Device",
    appVersion: "1.0.0",
  });
  return {
    db,
    cleanup: () => {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

/** Records one PRODUCED event at an exact instant, through the real writer. */
const produce = async (db: SqliteDatabase, occurredAt: string, serial: string): Promise<string> => {
  const qrId = `HRTEST_RED_7/10_${serial}`;
  const eventId = crypto.randomUUID();
  await db.runInTransaction(async (tx) => {
    const variant = await db.getOrCreateVariant({ qrId, article: "HRTEST", color: "RED", size: "7/10", serial }, tx);
    await db.insertProduced({ qrId, productVariantId: variant.id, createdAt: occurredAt }, tx);
    await db.appendProducedEvent(
      {
        eventId,
        qrId,
        productVariantId: variant.id,
        article: "HRTEST",
        color: "RED",
        size: "7/10",
        serial,
        occurredAt,
        parserVersion: "v1",
        factoryId: "factory-1",
        workstationId: "workstation-1",
        deviceId: "device-1",
      },
      tx
    );
  });
  return eventId;
};

const storedRow = (db: SqliteDatabase, eventId: string): { event_hour: number; event_date: string } =>
  db.db.prepare("SELECT event_hour, event_date FROM production_events WHERE id = ?").get(eventId) as {
    event_hour: number;
    event_date: string;
  };

test("a PRODUCED event stores the Karachi hour, and keeps the UTC event_date", async () => {
  const fixture = createDbFixture();
  try {
    fixture.db.createProduct({ article: "HRTEST", size: "7/10", color: "RED" });

    const atMidnight = await produce(fixture.db, KARACHI_MIDNIGHT, "000001");
    const before = await produce(fixture.db, MINUTE_BEFORE, "000002");

    const midnightRow = storedRow(fixture.db, atMidnight);
    assert.equal(midnightRow.event_hour, 0, "19:00Z is midnight in Karachi, so the hour is 0, never 12 or 24");
    assert.equal(midnightRow.event_date, "2026-10-19", "event_date stays the UTC date, deliberately");

    const beforeRow = storedRow(fixture.db, before);
    assert.equal(beforeRow.event_hour, 23);
    assert.equal(beforeRow.event_date, "2026-10-19");
  } finally {
    fixture.cleanup();
  }
});

test("every stored hour is an integer from 0 to 23, across a whole UTC day", async () => {
  const fixture = createDbFixture();
  try {
    fixture.db.createProduct({ article: "HRTEST", size: "7/10", color: "RED" });
    for (let hour = 0; hour < 24; hour += 1) {
      const iso = `2026-10-19T${String(hour).padStart(2, "0")}:30:00.000Z`;
      const id = await produce(fixture.db, iso, String(100 + hour).padStart(6, "0"));
      const row = storedRow(fixture.db, id);
      assert.ok(Number.isInteger(row.event_hour), `${iso} stored a non-integer hour`);
      assert.ok(row.event_hour >= 0 && row.event_hour <= 23, `${iso} stored ${row.event_hour}`);
      assert.equal(row.event_hour, (hour + 5) % 24, `${iso} is not the Karachi hour`);
    }
  } finally {
    fixture.cleanup();
  }
});

test("the hourly breakdown buckets by the stored business hour", async () => {
  const fixture = createDbFixture();
  try {
    fixture.db.createProduct({ article: "HRTEST", size: "7/10", color: "RED" });
    // Two scans in the same Karachi hour, and one an hour later, so a wrong hour would split
    // or merge the buckets visibly. 07:00Z and 07:30Z are 12:00 and 12:30 in Karachi; 08:00Z
    // is 13:00.
    //
    // The instants are chosen to sit inside getReport's CUSTOM window as it compares TODAY:
    // operationalDayBounds yields local-time strings ("2026-10-19T06:00:00") which are string-
    // compared against event_ts_local, and the scan path stores a UTC "...Z" instant there. The
    // two are five hours apart for Karachi, so a 01:00Z scan sorts BEFORE the 06:00 bound and
    // drops out of the day entirely. That mismatch is a separate, pre-existing issue about
    // event_ts_local semantics -- not about event_hour -- and this test deliberately does not
    // depend on it either way, so fixing it later cannot silently break this assertion.
    await produce(fixture.db, "2026-10-19T07:00:00.000Z", "000201");
    await produce(fixture.db, "2026-10-19T07:30:00.000Z", "000202");
    await produce(fixture.db, "2026-10-19T08:00:00.000Z", "000203");

    const report = fixture.db.getReport("CUSTOM", "2026-10-19", "2026-10-19");
    const byHour = new Map(report.byHour.map((row) => [row.key, row.quantity]));
    assert.equal(byHour.get("12"), 2, "07:00Z and 07:30Z are both 12:xx in Karachi");
    assert.equal(byHour.get("13"), 1, "08:00Z is 13:00 in Karachi");
  } finally {
    fixture.cleanup();
  }
});

// A GUARD, NOT A BEHAVIOUR TEST. Seven writers shared the defect because the two-line derivation
// was copy-pasted; driving all seven through fixtures costs far more than it proves, so this pins
// the one thing that matters: no writer of production_events derives the hour from the host clock.
test("no production_events writer derives event_hour from the host clock", () => {
  const WRITERS = ["production.ts", "dispatch.ts", "store.ts", "qrCodes.ts"];
  const here = path.resolve(process.cwd(), "src/database");
  let businessHourCalls = 0;

  for (const file of WRITERS) {
    const source = fs.readFileSync(path.join(here, file), "utf-8");
    const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

    // The exact shapes the defect took, all of them host-local.
    for (const pattern of [/getHours\(\)\s*,/g, /const eventHour\s*=\s*new Date\(/g]) {
      const found = stripped.match(pattern) ?? [];
      assert.equal(found.length, 0, `${file} still derives an event hour with ${pattern}: ${found.join(", ")}`);
    }
    businessHourCalls += (stripped.match(/businessHourOf\(/g) ?? []).length;
  }

  // One per writer path: production 1, dispatch 3, store 2, qrCodes 1.
  assert.equal(businessHourCalls, 7, "expected all seven writer paths to call businessHourOf");
});
