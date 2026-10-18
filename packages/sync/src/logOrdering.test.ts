import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// CAN A RECEIVING COMPUTER PERMANENTLY MISS A COMMITTED EVENT?
//
// A log position is taken when a row is inserted. The row appears when its transaction commits.
// Those orders are not the same, and a reader walking `seq > cursor` is ruined by the
// difference: it can read past position 6 while position 5 is still in flight, and 5 is then
// never greater than the cursor again.
//
// There is no PostgreSQL available here, so this file does two things that do not need one:
//
//   1. It models the interleaving directly, and FIRST SHOWS THE LOSS HAPPENING. A regression
//      test that cannot fail proves nothing, so the model is checked against the broken design
//      before it is checked against the fixed one.
//   2. It pins the mechanism in the migration — the advisory lock, its key, and its position
//      before the insert — so the guarantee the reader depends on cannot be edited away quietly.
//
// WHAT THIS DOES NOT PROVE. The model is a model. It does not execute PostgreSQL, so it cannot
// show that pg_advisory_xact_lock behaves as documented, that the lock is really released on
// rollback, or that two real sessions serialise. Those need a real concurrency test against a
// real server, and that remains outstanding.

const MIGRATION = fs.readFileSync(
  path.resolve(import.meta.dirname, "../../../migrations/supabase/003_sync_event_log.up.sql"),
  "utf8"
);

// ─── A model of the log and the reader ──────────────────────────────────────

type Outcome = "COMMIT" | "ABORT";

interface Writer {
  readonly id: number;
  seq: number | null;
  settled: Outcome | null;
}

/**
 * The service's log, as the reader experiences it.
 *
 * `serialised` is the whole question: with it, a writer cannot take a position while another
 * writer is still between taking one and settling — which is what the advisory lock in
 * migration 003 enforces. Without it, positions are handed out freely.
 */
class LogModel {
  private next = 1;
  private holder: Writer | null = null;
  readonly writers: Writer[] = [];

  constructor(private readonly serialised: boolean) {}

  /** Returns false when the writer must wait, which only ever happens when serialised. */
  take(writer: Writer): boolean {
    if (this.serialised && this.holder !== null && this.holder !== writer) return false;
    if (writer.seq !== null) return true;
    writer.seq = this.next;
    this.next += 1;
    this.holder = writer;
    return true;
  }

  settle(writer: Writer, outcome: Outcome): void {
    if (writer.seq === null || writer.settled !== null) return;
    writer.settled = outcome;
    if (this.holder === writer) this.holder = null;
  }

  /** What a reader can see: committed rows only, oldest position first. */
  visible(afterSeq: number): number[] {
    return this.writers
      .filter((w) => w.settled === "COMMIT" && w.seq !== null && w.seq > afterSeq)
      .map((w) => w.seq as number)
      .sort((a, b) => a - b);
  }

  committedSeqs(): number[] {
    return this.writers
      .filter((w) => w.settled === "COMMIT" && w.seq !== null)
      .map((w) => w.seq as number)
      .sort((a, b) => a - b);
  }
}

/** The reader: fetch what is after the cursor, apply it, move the cursor to the last one read. */
class CursorReader {
  cursor = 0;
  readonly applied: number[] = [];

  poll(log: LogModel): void {
    for (const seq of log.visible(this.cursor)) {
      this.applied.push(seq);
      this.cursor = seq;
    }
  }
}

/** Everything that committed but the reader never applied. Must always be empty. */
const missed = (log: LogModel, reader: CursorReader): number[] =>
  log.committedSeqs().filter((seq) => !reader.applied.includes(seq));

// ─── 1. The loss is real ────────────────────────────────────────────────────

test("without serialisation a committed event is skipped for ever -- the defect, reproduced", () => {
  const log = new LogModel(false);
  const slow: Writer = { id: 1, seq: null, settled: null };
  const quick: Writer = { id: 2, seq: null, settled: null };
  log.writers.push(slow, quick);
  const reader = new CursorReader();

  log.take(slow); // position 1, then a long pause before committing
  log.take(quick); // position 2
  log.settle(quick, "COMMIT");
  reader.poll(log); // reads 2, cursor is now 2
  log.settle(slow, "COMMIT"); // position 1 appears, behind the cursor
  reader.poll(log);

  assert.deepEqual(reader.applied, [2]);
  assert.deepEqual(missed(log, reader), [1], "the slow writer's event is lost, exactly as described");
});

test("the snapshot watermark does not fix it: a higher transaction id can hold a lower position", () => {
  // The suggested fix reads only rows whose inserting transaction has finished, by comparing
  // xmin against the lowest still-running transaction id. It fails because a transaction takes
  // its id at its FIRST write and its log position whenever it reaches the trigger, so the two
  // orders can disagree.
  interface Tx {
    readonly xid: number;
    seq: number;
    settled: Outcome | null;
  }
  // A took its id first (earlier write elsewhere) but reached the log later, so it holds 6.
  const a: Tx = { xid: 100, seq: 6, settled: null };
  // B took its id second but reached the log at once, so it holds 5 -- and is slow.
  const b: Tx = { xid: 101, seq: 5, settled: null };

  a.settled = "COMMIT";
  const running = [a, b].filter((tx) => tx.settled === null).map((tx) => tx.xid);
  const watermark = Math.min(...running); // 101, because only B is still running

  const readable = [a, b]
    .filter((tx) => tx.settled === "COMMIT" && tx.xid < watermark)
    .map((tx) => tx.seq);
  assert.deepEqual(readable, [6], "the watermark lets position 6 through while 5 is still in flight");

  const cursor = Math.max(...readable);
  b.settled = "COMMIT";
  assert.equal(b.seq > cursor, false, "and position 5, now committed, is behind the cursor for ever");
});

// ─── 2. Serialising the writers fixes it ────────────────────────────────────

test("with serialisation the same interleaving cannot happen", () => {
  const log = new LogModel(true);
  const slow: Writer = { id: 1, seq: null, settled: null };
  const quick: Writer = { id: 2, seq: null, settled: null };
  log.writers.push(slow, quick);
  const reader = new CursorReader();

  assert.equal(log.take(slow), true);
  assert.equal(log.take(quick), false, "the second writer cannot take a position yet");
  reader.poll(log);
  assert.deepEqual(reader.applied, [], "and there is nothing to read while the first is in flight");

  log.settle(slow, "COMMIT");
  assert.equal(log.take(quick), true);
  log.settle(quick, "COMMIT");
  reader.poll(log);

  assert.deepEqual(reader.applied, [1, 2]);
  assert.deepEqual(missed(log, reader), []);
});

test("over ten thousand random schedules, serialised writers never lose a committed event", () => {
  // A small deterministic generator, so a failure is reproducible.
  let state = 20_261_015;
  const random = (): number => {
    state = (state * 1_103_515_245 + 12_345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  const pick = (n: number): number => Math.floor(random() * n);

  let lossesWithout = 0;
  let lossesWith = 0;

  for (let round = 0; round < 10_000; round += 1) {
    for (const serialised of [false, true]) {
      const log = new LogModel(serialised);
      const reader = new CursorReader();
      const writers: Writer[] = [];
      const count = 2 + pick(4);
      for (let i = 0; i < count; i += 1) writers.push({ id: i, seq: null, settled: null });
      log.writers.push(...writers);

      // Interleave: let writers take positions, settle, and the reader poll, in any order.
      for (let step = 0; step < count * 4; step += 1) {
        const action = pick(3);
        const writer = writers[pick(writers.length)] as Writer;
        if (action === 0) log.take(writer);
        else if (action === 1 && writer.seq !== null) log.settle(writer, pick(5) === 0 ? "ABORT" : "COMMIT");
        else reader.poll(log);
      }
      // Everything finishes, and the reader gets a last look.
      for (const writer of writers) {
        if (writer.seq === null) log.take(writer);
        if (writer.seq !== null) log.settle(writer, "COMMIT");
      }
      reader.poll(log);
      reader.poll(log);

      const lost = missed(log, reader).length;
      if (serialised) lossesWith += lost;
      else lossesWithout += lost;
    }
  }

  assert.ok(lossesWithout > 0, `the unserialised design must lose events, or this test proves nothing (lost ${lossesWithout})`);
  assert.equal(lossesWith, 0, "a serialised log must never lose a committed event");
});

test("a rolled-back writer leaves a permanent hole, and the reader steps over it", () => {
  const log = new LogModel(true);
  const first: Writer = { id: 1, seq: null, settled: null };
  const aborted: Writer = { id: 2, seq: null, settled: null };
  const third: Writer = { id: 3, seq: null, settled: null };
  log.writers.push(first, aborted, third);
  const reader = new CursorReader();

  log.take(first);
  log.settle(first, "COMMIT");
  log.take(aborted);
  log.settle(aborted, "ABORT"); // position 2 is burnt: sequences do not roll back
  log.take(third);
  log.settle(third, "COMMIT");

  reader.poll(log);

  assert.deepEqual(reader.applied, [1, 3], "the hole is stepped over, not waited for");
  assert.deepEqual(missed(log, reader), []);
  assert.equal(reader.cursor, 3);
  // And a later poll finds nothing, rather than stalling on the missing position.
  reader.poll(log);
  assert.deepEqual(reader.applied, [1, 3]);
});

test("a retried read applies nothing twice and leaves the cursor where it was", () => {
  const log = new LogModel(true);
  const writer: Writer = { id: 1, seq: null, settled: null };
  log.writers.push(writer);
  const reader = new CursorReader();

  log.take(writer);
  log.settle(writer, "COMMIT");
  reader.poll(log);
  const after = reader.cursor;
  reader.poll(log);
  reader.poll(log);

  assert.deepEqual(reader.applied, [1]);
  assert.equal(reader.cursor, after);
});

// ─── 3. The mechanism is actually in the migration ──────────────────────────

test("both triggers take the same transaction-level advisory lock before inserting", () => {
  const bodies = [...MIGRATION.matchAll(/create or replace function (?:public\.)?([\w.]+)\(\) returns trigger[\s\S]*?\n\$\$;/g)];
  const logging = bodies.filter((hit) => (hit[0] as string).includes("insert into public.sync_event_log"));
  assert.equal(logging.length, 2, "exactly two functions write to the log");

  for (const hit of logging) {
    const body = hit[0] as string;
    const name = hit[1] as string;
    const lockAt = body.indexOf("pg_advisory_xact_lock(777, 1)");
    const insertAt = body.indexOf("insert into public.sync_event_log");
    assert.ok(lockAt >= 0, `${name} must take the advisory lock`);
    assert.ok(lockAt < insertAt, `${name} must take the lock BEFORE the insert that calls nextval`);
  }
});

test("the lock is transaction-scoped, so a rollback cannot leave it held", () => {
  // pg_advisory_lock is session-scoped: a transaction that rolled back would keep it, and every
  // other computer would block for ever. Only the _xact_ form may be used here.
  assert.equal(
    /pg_advisory_lock\s*\(/.test(MIGRATION),
    false,
    "the session-scoped lock must never be used"
  );
  assert.equal(
    /pg_try_advisory/.test(MIGRATION),
    false,
    "a try-lock would let a writer take a position without waiting, which is the whole defect"
  );
  assert.equal((MIGRATION.match(/pg_advisory_xact_lock\(777, 1\)/g) ?? []).length, 2, "one lock, one key, both triggers");
});

test("the migration records why the snapshot watermark was rejected", () => {
  // The next person to read this will have the same idea. The reasoning has to survive with it.
  assert.match(MIGRATION, /pg_snapshot_xmin/, "the rejected approach is named");
  assert.match(MIGRATION, /wraparound/i, "including the 32-bit transaction id problem");
});
