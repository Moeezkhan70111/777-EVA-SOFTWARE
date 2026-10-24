// WHAT MUST NOT REPLICATE, in one place, so nothing has to remember it.
//
// docs/37 section 0.2 lists these in prose. Prose is not enforceable, and the cost of forgetting
// one of them is not a bug report -- it is two computers issuing the same document numbers, or
// the same carton serials, which looks exactly like data corruption and is discovered weeks
// later in a stock count.
//
// THIS LIST DOES DOUBLE DUTY. It is both:
//   1. the set of tables the replication engine must never push or apply, and
//   2. the scrub list for a snapshot backfill -- a restored snapshot that keeps app_settings
//      hands the new computer block 1, which is the one block it must never have.
//
// Keeping one list for both is deliberate: they are the same question asked twice, and two lists
// would drift.

/**
 * Tables that must never replicate, with the reason. The reason is part of the data because
 * "why is this excluded" is the question somebody will ask in a year, and an unexplained list
 * invites someone to prune it.
 */
export const REPLICATION_EXCLUSIONS: ReadonlyArray<{ readonly table: string; readonly why: string }> = [
  // ── The three that cause silent duplicate identifiers ────────────────────────────
  {
    table: "app_settings",
    why: "Holds numbering.block and device.id. Replicating it hands every computer the same block and the same identity, so they allocate colliding document numbers -- the exact failure the block scheme exists to prevent.",
  },
  {
    table: "qr_sequences",
    why: "Per-computer carton serial counters. Merging them makes two computers issue the same serials, and a carton serial is an identity, not a number.",
  },
  {
    table: "raw_material_qr_sequences",
    why: "The same, for packet labels.",
  },

  // ── Statements about one machine, not shared facts ───────────────────────────────
  {
    table: "sync_outbox",
    why: "This computer's queue of what it still has to send. Replicating a queue would have every computer try to send every other computer's work.",
  },
  {
    table: "sync_inbox_parked",
    why: "Events this computer pulled but cannot apply yet. A statement about this computer's own progress through one project's log, like sync_outbox -- never shared.",
  },
  {
    table: "user_sessions",
    why: "Live sign-ins on this machine, including login_date. A session is not transferable.",
  },
  {
    table: "schema_migrations",
    why: "Which migrations THIS database has applied. Replicating it would make a computer believe it had run migrations it has not.",
  },
  {
    table: "system_health_snapshots",
    why: "Measurements of one machine.",
  },
  {
    table: "backup_history",
    why: "Backups taken on one machine, at paths that exist only there.",
  },
  {
    table: "devices",
    why: "Device registry. A computer may learn about others, but its own row is written from its own device-identity.json and must not be overwritten by a peer.",
  },
  {
    table: "workstations",
    why: "Same: the row describing this workstation is local truth. See the note below on partial exclusion.",
  },

  // ── Logins ───────────────────────────────────────────────────────────────────────
  //
  // app_users NEVER replicates: it holds the hashes. That part is permanent, and the owner
  // re-affirmed it on 2026-10-23. What changed that day is how logins reach other PCs: docs/37
  // section U.2 makes accounts cloud-authoritative, replicating only non-secret facts. When that is
  // built, the three companion tables below may receive those facts through a contract of their
  // own. Until then all four stay excluded.
  {
    table: "app_users",
    why: "Holds password_hash and password_salt. Replicating puts every user's credential on every machine, including a stolen one. Under docs/37 section U.2 each PC caches a verifier only for people who logged in on it, and no hash ever replicates.",
  },
  {
    table: "user_role_assignments",
    why: "Follows app_users: a role assignment for a user that does not exist here is meaningless.",
  },
  {
    table: "user_additional_permissions",
    why: "Follows app_users.",
  },
  {
    table: "user_notifications",
    why: "Addressed to a user on one machine.",
  },
];

/** Just the table names, for a fast membership test. */
export const REPLICATION_EXCLUDED_TABLES: ReadonlySet<string> = new Set(
  REPLICATION_EXCLUSIONS.map((entry) => entry.table)
);

/**
 * Whether a table is excluded from replication.
 *
 * Use this rather than an inline list. Every call site that hard-codes its own copy is a place
 * the list can drift.
 */
export function isReplicationExcluded(table: string): boolean {
  return REPLICATION_EXCLUDED_TABLES.has(table.trim().toLowerCase());
}

/**
 * `workstations` IS PARTIALLY EXCLUDED, and this records which part.
 *
 * docs/37 says "the PC's own workstations row" joins the exclusion list -- not the whole table. A
 * computer legitimately needs to know about the other workstations in the factory, because a
 * production event names the workstation it happened at and an arriving event must resolve it.
 *
 * So the rule is: apply other computers' workstation rows, never let one overwrite the row whose
 * id matches this computer's own workstation. Listing the table above is the conservative
 * starting point -- nothing replicates until a contract says it does -- and whoever writes the
 * workstation contract must narrow it to this.
 */
export const PARTIALLY_EXCLUDED_TABLES: ReadonlyArray<{ readonly table: string; readonly rule: string }> = [
  {
    table: "workstations",
    rule: "Apply rows for other workstations. Never overwrite the row matching this computer's own workstation_id.",
  },
];
