// ONE-TIME STORE RECONCILIATION — sorting what only the source holds into "bring" and "leave".
//
// Every source-only session, scan and stock movement lands in exactly one bucket, or the run is
// refused. Nothing is brought across because it merely looked unfamiliar, and nothing is dropped
// silently.

import type { DatabaseSync } from "node:sqlite";
import { STOCK_EVENT_NOTE } from "@erp/domain";
import {
  MOVEMENT,
  PACKET_ISSUED,
  SCAN,
  TABLE,
  all,
  nextFreeNumber,
  num,
  one,
  recipientOf,
  sourceOnly,
  text,
  textOrNull,
  withRecipient,
  type ReconciliationDecisions,
  type Row,
} from "./shared.js";

export interface RenumberedSession {
  readonly source: Row;
  readonly newNumber: number;
}

export interface SessionPlan {
  readonly receiving: readonly RenumberedSession[];
  readonly issue: readonly RenumberedSession[];
  readonly empty: readonly Row[];
}

export interface ScanPlan {
  readonly storeIns: readonly Row[];
  /** As written: the recipient already corrected. */
  readonly storeOuts: readonly Row[];
  /** Store-outs of packets the target already holds: left behind. */
  readonly duplicates: readonly Row[];
}

export interface MovementPlan {
  readonly brought: readonly Row[];
  readonly left: readonly Row[];
}

const numbersOf = (rows: readonly Row[]): number[] => rows.map((row) => num(row, "session_number")).sort((a, b) => a - b);
const sorted = (values: readonly number[]): string => [...values].sort((a, b) => a - b).join(",");
const sameSet = (a: readonly number[], b: readonly number[]): boolean => sorted(a) === sorted(b);

/** The source-only sessions, renumbered to the target's next free numbers, oldest first. */
export function planSessions(source: DatabaseSync, target: DatabaseSync, decisions: ReconciliationDecisions, refusals: string[]): SessionPlan {
  const receiving = sourceOnly(source, target, TABLE.RECEIVING).sort((a, b) => num(a, "session_number") - num(b, "session_number"));
  const issueRows = sourceOnly(source, target, TABLE.ISSUE).sort((a, b) => num(a, "session_number") - num(b, "session_number"));
  if (!sameSet(numbersOf(receiving), decisions.receivingSessions)) {
    refusals.push(`Store-in sessions only the source holds are [${numbersOf(receiving).join(", ")}], the plan expects [${decisions.receivingSessions.join(", ")}].`);
  }
  if (!sameSet(numbersOf(issueRows), [...decisions.issueSessions, ...decisions.emptyIssueSessions])) {
    refusals.push(`Store-out sessions only the source holds are [${numbersOf(issueRows).join(", ")}], the plan expects [${[...decisions.issueSessions, ...decisions.emptyIssueSessions].join(", ")}].`);
  }
  const empty = issueRows.filter((row) => decisions.emptyIssueSessions.includes(num(row, "session_number")));
  for (const row of empty) {
    const scans = num(one(source, "SELECT COUNT(*) AS n FROM raw_material_qr_events WHERE session_id = ?", text(row, "id")) ?? { n: 0 }, "n");
    if (scans !== 0) refusals.push(`Store-out session ${num(row, "session_number")} was to be left behind as empty, but holds ${scans} scans.`);
  }
  for (const row of receiving) {
    if (!one(target, "SELECT 1 AS x FROM parties WHERE id = ?", text(row, "party_id"))) refusals.push(`Store-in session ${num(row, "session_number")}'s supplier is not on the target.`);
  }
  const brought = issueRows.filter((row) => decisions.issueSessions.includes(num(row, "session_number")));
  return { receiving: renumber(receiving, nextFreeNumber(target, "rmReceivingSession")), issue: renumber(brought, nextFreeNumber(target, "rmIssueSession")), empty };
}

const renumber = (rows: readonly Row[], first: number): RenumberedSession[] => rows.map((source, i) => ({ source, newNumber: first + i }));

/** Every source-only scan: a store-in of a brought packet, a store-out of one, or a duplicate. */
export function classifyScans(
  source: DatabaseSync,
  target: DatabaseSync,
  decisions: ReconciliationDecisions,
  sessions: SessionPlan,
  packetIds: ReadonlySet<string>,
  refusals: string[]
): ScanPlan {
  const receivingIds = new Set(sessions.receiving.map((s) => text(s.source, "id")));
  const issueIds = new Set(sessions.issue.map((s) => text(s.source, "id")));
  const storeIns: Row[] = [];
  const storeOuts: Row[] = [];
  const duplicates: Row[] = [];
  const scans = sourceOnly(source, target, TABLE.PACKET_EVENTS).sort((a, b) => text(a, "event_ts_local").localeCompare(text(b, "event_ts_local")));
  for (const scan of scans) {
    const type = text(scan, "event_type");
    const sessionId = textOrNull(scan, "session_id") ?? "";
    const qrId = text(scan, "qr_id");
    if (type === SCAN.IN && receivingIds.has(sessionId) && packetIds.has(qrId)) storeIns.push(scan);
    else if (type === SCAN.OUT && issueIds.has(sessionId) && packetIds.has(qrId)) storeOuts.push(correctRecipient(scan, decisions, refusals));
    else if (type === SCAN.OUT && issueIds.has(sessionId) && one(target, "SELECT 1 AS x FROM raw_material_qrs WHERE id = ?", qrId)) duplicates.push(scan);
    else refusals.push(`Scan ${text(scan, "id")} (${type} of ${qrId}) fits nothing in the plan.`);
  }
  checkDuplicatesIssued(target, duplicates, decisions.recipient.actual, refusals);
  return { storeIns, storeOuts, duplicates };
}

/** A store-out as it should be written: to the actual recipient, whichever of the two it named. */
function correctRecipient(scan: Row, decisions: ReconciliationDecisions, refusals: string[]): Row {
  const metadata = textOrNull(scan, "metadata_json");
  const named = recipientOf(metadata);
  if (metadata === null || named === null) {
    refusals.push(`Store-out ${text(scan, "id")} names no recipient.`);
    return scan;
  }
  if (named === decisions.recipient.actual) return scan;
  if (named !== decisions.recipient.recorded) {
    refusals.push(`Store-out ${text(scan, "id")} names party ${named}, which is neither the recorded nor the actual recipient.`);
    return scan;
  }
  return { ...scan, metadata_json: withRecipient(metadata, decisions.recipient.actual) };
}

/**
 * The owner's premise for leaving the duplicates behind: the target already shows each of those
 * packets issued, to the actual recipient. If that is not so, leaving them would lose a store-out.
 */
function checkDuplicatesIssued(target: DatabaseSync, duplicates: readonly Row[], actual: string, refusals: string[]): void {
  for (const scan of duplicates) {
    const qrId = text(scan, "qr_id");
    const packet = one(target, "SELECT current_status FROM raw_material_qrs WHERE id = ?", qrId);
    const last = one(target, "SELECT metadata_json FROM raw_material_qr_events WHERE qr_id = ? AND event_type = ? ORDER BY event_ts_local DESC LIMIT 1", qrId, SCAN.OUT);
    if (packet?.current_status !== PACKET_ISSUED) refusals.push(`Duplicate store-out of ${qrId}: the target does not show it issued.`);
    else if (recipientOf(last ? textOrNull(last, "metadata_json") : null) !== actual) refusals.push(`Duplicate store-out of ${qrId}: the target shows it issued to another party.`);
  }
}

/** Every source-only stock movement belongs to exactly one brought or duplicate scan. */
export function classifyMovements(source: DatabaseSync, target: DatabaseSync, scans: ScanPlan, refusals: string[]): MovementPlan {
  const byKey = new Map<string, { scan: Row; bring: boolean }>();
  for (const scan of scans.storeIns) byKey.set(`${MOVEMENT.IN} ${STOCK_EVENT_NOTE.SCAN_IN} ${text(scan, "qr_id")}`, { scan, bring: true });
  for (const scan of scans.storeOuts) byKey.set(`${MOVEMENT.OUT} ${STOCK_EVENT_NOTE.SCAN_OUT} ${text(scan, "qr_id")}`, { scan, bring: true });
  for (const scan of scans.duplicates) byKey.set(`${MOVEMENT.OUT} ${STOCK_EVENT_NOTE.SCAN_OUT} ${text(scan, "qr_id")}`, { scan, bring: false });
  const brought: Row[] = [];
  const left: Row[] = [];
  const matched = new Set<string>();
  for (const movement of sourceOnly(source, target, TABLE.STOCK_EVENTS)) {
    const key = `${text(movement, "event_type")} ${textOrNull(movement, "note") ?? ""}`;
    const owner = byKey.get(key);
    if (!owner || matched.has(key)) {
      refusals.push(`Stock movement ${text(movement, "id")} (${key}) ${owner ? "is a second movement for one scan" : "belongs to no scan in the plan"}.`);
      continue;
    }
    matched.add(key);
    if (!sameMovement(movement, owner.scan)) refusals.push(`Stock movement ${text(movement, "id")} does not match its scan's material, quantity or unit.`);
    (owner.bring ? brought : left).push(movement);
  }
  for (const key of byKey.keys()) if (!matched.has(key)) refusals.push(`No stock movement found for the scan "${key}".`);
  return { brought: brought.sort((a, b) => text(a, "created_at").localeCompare(text(b, "created_at"))), left };
}

const sameMovement = (movement: Row, scan: Row): boolean =>
  movement.item_id === scan.item_id && movement.unit_id === scan.unit_id && Number(movement.quantity) === Number(scan.quantity);

/** When a brought store-out session closed: at its last brought scan. */
export function closedAt(storeOuts: readonly Row[], sessionId: string): string | null {
  const times = storeOuts.filter((scan) => scan.session_id === sessionId).map((scan) => text(scan, "event_ts_local")).sort();
  return times.at(-1) ?? null;
}

/** Target sessions still open that the source closed: closed as the source closed them. */
export function planStaleCloses(
  source: DatabaseSync,
  target: DatabaseSync,
  decisions: ReconciliationDecisions,
  refusals: string[]
): Array<{ table: string; id: string; number: number; closedAt: string }> {
  const wanted: Array<[string, readonly number[]]> = [[TABLE.RECEIVING, decisions.staleReceivingSessions], [TABLE.ISSUE, decisions.staleIssueSessions]];
  const closes: Array<{ table: string; id: string; number: number; closedAt: string }> = [];
  for (const [table, numbers] of wanted) {
    for (const number of numbers) {
      const theirs = one(source, `SELECT * FROM ${table} WHERE session_number = ?`, number);
      const ours = one(target, `SELECT * FROM ${table} WHERE session_number = ?`, number);
      const closed = theirs ? textOrNull(theirs, "closed_at") : null;
      if (!theirs || !ours || theirs.id !== ours.id) refusals.push(`Session ${number} in ${table} is not the same session on both computers.`);
      else if (ours.status !== "OPEN" || theirs.status !== "CLOSED" || closed === null) refusals.push(`Session ${number} in ${table} is not open on the target and closed on the source.`);
      else if (!sameScans(source, target, text(ours, "id"))) refusals.push(`Session ${number} in ${table} holds different scans on the two computers.`);
      else closes.push({ table, id: text(ours, "id"), number, closedAt: closed });
    }
  }
  return closes;
}

function sameScans(source: DatabaseSync, target: DatabaseSync, sessionId: string): boolean {
  const ids = (db: DatabaseSync): string => all(db, "SELECT id FROM raw_material_qr_events WHERE session_id = ? ORDER BY id", sessionId).map((row) => text(row, "id")).join(",");
  return ids(source) === ids(target);
}
