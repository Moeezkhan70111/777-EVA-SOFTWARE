// This computer's view of the write leases, and the local gate built on it (docs/37 section W).
//
// THE CLOUD IS THE AUTHORITY. A leased push from a computer that does not hold the lease, under
// the epoch it was written under, is refused there (cloud migrations 011 and 012). This file is the
// LOCAL half: it stops this computer making a leased write the cloud would refuse, so the operator
// is told at the moment of the write instead of finding a dead letter days later.
//
// THE CACHE is the cloud's last answer to "who holds what" (migration 093), rewritten whole after
// every pass that could fetch it and tied to the project it came from. It is read offline: the
// holder keeps writing when the cloud is unreachable, exactly as docs/37 W.2 promises, and its
// writes are judged when they are pushed.
//
// THE DECISION, in order:
//
//   not set up for cloud sync  ALLOWED. A standalone computer is the only writer there is, and
//                              must keep working exactly as before replication existed.
//   the project has no leases  ALLOWED, with no epoch. A project without cloud migration 011 can
//                              neither enforce a lease nor receive leased work, so this is the world
//                              before leases. A missing migration must not lock the store. Work
//                              written here is queued unstamped and waits for the backfill.
//   no cached answer for the   NO_LEASE_INFO. A synced computer that has not yet heard from this
//   project it syncs with      project cannot know whether it holds the lease, so it does not write.
//   nobody holds the domain    NOT_HELD
//   another computer holds it  HELD_ELSEWHERE, naming the holder's label
//   this computer holds it,    CATCHING_UP. The previous holder's last write is at barrier_seq. Until
//   but has not caught up      this computer has read that far, and has no event of the domain from
//                              before it still parked, it would be editing a stale copy.
//   this computer holds it     ALLOWED, with the epoch every write must carry.

import { LEASED_AGGREGATE_DOMAIN, LEASE_DOMAIN, type LeaseDomain } from "@erp/data";
import { pullProjectKey, readPullCursor, readPullProject, readSyncSetting, writeSyncSetting } from "./pullCursor.js";
import type { SyncSqlHandle } from "./sqlPort.js";
import { asRow } from "./sqlPort.js";

/** One domain's lease, as the cloud reported it. */
export interface DomainLease {
  readonly domain: LeaseDomain;
  readonly holderDeviceId: string | null;
  readonly holderLabel: string | null;
  readonly epoch: number;
  readonly barrierSeq: number;
  readonly grantedAt: string | null;
}

export type LeaseRefusal = "NO_LEASE_INFO" | "NOT_HELD" | "HELD_ELSEWHERE" | "CATCHING_UP";

export type LeaseWriteDecision =
  | { readonly allowed: true; readonly domain: LeaseDomain; readonly epoch: number | null }
  | { readonly allowed: false; readonly domain: LeaseDomain; readonly reason: LeaseRefusal; readonly holderLabel: string | null };

const KNOWN_DOMAINS: ReadonlySet<string> = new Set(Object.values(LEASE_DOMAIN));

/** The project, as pullProjectKey spells it, that answered "no leases here" on its last pass. */
export const LEASES_UNSUPPORTED_SETTING_KEY = "sync.leases.unsupported";

/**
 * Records that `projectUrl` has no leases (its current_leases answered 404). A lease cached from
 * before is forgotten first: a project that has lost its leases cannot enforce the old ones.
 */
export function markLeasesUnsupported(sql: SyncSqlHandle, projectUrl: string): void {
  sql.prepare("DELETE FROM sync_domain_leases").run();
  writeSyncSetting(sql, LEASES_UNSUPPORTED_SETTING_KEY, pullProjectKey(projectUrl));
}

const isLeaseDomain = (value: unknown): value is LeaseDomain => typeof value === "string" && KNOWN_DOMAINS.has(value);

const optionalText = (value: unknown): { ok: boolean; value: string | null } =>
  value === null || value === undefined
    ? { ok: true, value: null }
    : typeof value === "string"
      ? { ok: true, value }
      : { ok: false, value: null };

const wholeNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** One row of current_leases(), validated. Null when it is not shaped like one. */
function readLeaseRow(value: unknown): DomainLease | null {
  const row = asRow(value);
  if (row === null || typeof row.domain !== "string") return null;
  const holder = optionalText(row.holder_device_id);
  const label = optionalText(row.holder_label);
  const grantedAt = optionalText(row.granted_at);
  const epoch = wholeNumber(row.epoch);
  const barrierSeq = wholeNumber(row.barrier_seq);
  if (!holder.ok || !label.ok || !grantedAt.ok || epoch === null || barrierSeq === null) return null;
  if (!isLeaseDomain(row.domain)) return null;
  return { domain: row.domain, holderDeviceId: holder.value, holderLabel: label.value, epoch, barrierSeq, grantedAt: grantedAt.value };
}

/**
 * The cloud's answer to current_leases(), validated at the boundary (R25).
 *
 * Null when the answer is not a list, or any row in it is malformed: a half-trusted answer about
 * who may write is worse than none, and the cache keeps its previous answer. A domain this version
 * does not know is skipped, not refused -- the cloud may grow a domain before this computer does,
 * and nothing here could write it anyway.
 */
export function readDomainLeases(value: unknown): DomainLease[] | null {
  if (!Array.isArray(value)) return null;
  const leases: DomainLease[] = [];
  for (const item of value) {
    const row = asRow(item);
    if (row !== null && typeof row.domain === "string" && !KNOWN_DOMAINS.has(row.domain)) continue;
    const lease = readLeaseRow(item);
    if (lease === null) return null;
    leases.push(lease);
  }
  return leases;
}

/** Replaces the cache with the cloud's latest answer for `projectUrl`, in one transaction. */
export function replaceLeaseCache(sql: SyncSqlHandle, projectUrl: string, leases: readonly DomainLease[], nowIso: string): void {
  const project = pullProjectKey(projectUrl);
  sql.exec("BEGIN IMMEDIATE");
  try {
    sql.prepare("DELETE FROM sync_domain_leases").run();
    // It answered, so it has leases: forget any earlier "not supported".
    sql.prepare("DELETE FROM app_settings WHERE setting_key = ?").run(LEASES_UNSUPPORTED_SETTING_KEY);
    const insert = sql.prepare(
      `INSERT INTO sync_domain_leases
         (domain, holder_device_id, holder_label, epoch, barrier_seq, granted_at, project_key, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const lease of leases) {
      insert.run(lease.domain, lease.holderDeviceId, lease.holderLabel, lease.epoch, lease.barrierSeq, lease.grantedAt, project, nowIso);
    }
    sql.exec("COMMIT");
  } catch (error) {
    sql.exec("ROLLBACK");
    throw error;
  }
}

/** The cached lease for one domain, if it belongs to the project this computer now syncs with. */
export function cachedLease(sql: SyncSqlHandle, domain: LeaseDomain): DomainLease | null {
  const project = readPullProject(sql);
  if (project === null) return null;
  const row = asRow(
    sql
      .prepare(
        `SELECT domain, holder_device_id, holder_label, epoch, barrier_seq, granted_at
           FROM sync_domain_leases WHERE domain = ? AND project_key = ?`
      )
      .get(domain, project)
  );
  return row === null ? null : readLeaseRow(row);
}

/** The event types written under `domain`, so a parked one of them can hold the gate shut. */
const aggregateTypesOf = (domain: LeaseDomain): string[] =>
  Object.entries(LEASED_AGGREGATE_DOMAIN)
    .filter(([, owner]) => owner === domain)
    .map(([type]) => type);

/** Parked events of this domain at or before the barrier: written by the previous holder, not yet here. */
function parkedBeforeBarrier(sql: SyncSqlHandle, domain: LeaseDomain, barrierSeq: number): number {
  let total = 0;
  for (const type of aggregateTypesOf(domain)) {
    const row = asRow(
      sql
        .prepare("SELECT COUNT(*) AS n FROM sync_inbox_parked WHERE seq <= ? AND dedupe_key LIKE ?")
        .get(barrierSeq, `${type}:%`)
    );
    total += Number(row?.n ?? 0);
  }
  return total;
}

export interface LeaseDecisionInput {
  readonly domain: LeaseDomain;
  readonly syncConfigured: boolean;
  readonly deviceId: string;
  readonly lease: DomainLease | null;
  /** The project this computer syncs with answered that it has no leases at all. */
  readonly leasesUnsupported: boolean;
  /** How far this computer has read the log. */
  readonly pulledSeq: number;
  /** Events of this domain at or before the barrier that are parked here, not applied. */
  readonly parkedBeforeBarrier: number;
}

/** The decision itself, with nothing read: every input is a fact handed in. */
export function decideLeaseWrite(input: LeaseDecisionInput): LeaseWriteDecision {
  const { domain, lease } = input;
  if (!input.syncConfigured) return { allowed: true, domain, epoch: null };
  if (lease === null && input.leasesUnsupported) return { allowed: true, domain, epoch: null };
  if (lease === null) return { allowed: false, domain, reason: "NO_LEASE_INFO", holderLabel: null };
  if (lease.holderDeviceId === null) return { allowed: false, domain, reason: "NOT_HELD", holderLabel: null };
  if (lease.holderDeviceId !== input.deviceId) {
    return { allowed: false, domain, reason: "HELD_ELSEWHERE", holderLabel: lease.holderLabel };
  }
  if (input.pulledSeq < lease.barrierSeq || input.parkedBeforeBarrier > 0) {
    return { allowed: false, domain, reason: "CATCHING_UP", holderLabel: lease.holderLabel };
  }
  return { allowed: true, domain, epoch: lease.epoch };
}

/** May this computer write `domain` now? Reads the cache, the cursor and the parked events. */
export function leaseWriteDecision(
  sql: SyncSqlHandle,
  input: { readonly domain: LeaseDomain; readonly deviceId: string; readonly syncConfigured: boolean }
): LeaseWriteDecision {
  if (!input.syncConfigured) {
    return decideLeaseWrite({ ...input, lease: null, leasesUnsupported: false, pulledSeq: 0, parkedBeforeBarrier: 0 });
  }
  const lease = cachedLease(sql, input.domain);
  const project = readPullProject(sql);
  return decideLeaseWrite({
    ...input,
    lease,
    leasesUnsupported: project !== null && readSyncSetting(sql, LEASES_UNSUPPORTED_SETTING_KEY) === project,
    pulledSeq: readPullCursor(sql),
    parkedBeforeBarrier: lease === null ? 0 : parkedBeforeBarrier(sql, input.domain, lease.barrierSeq),
  });
}
