import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  DuplicateChecker,
  OutboxRepository,
  ProductCatalogRepository,
  ProductionEventsRepository,
  QrMasterRepository,
  StockProjectionRepository,
  TransactionContext,
  TransactionManager,
} from "@erp/application";
import type { MutableTransactionContext } from "./database/shared.js";
import { productionMethods, type ProductionMethods } from "./database/production.js";
import { productsMethods, type ProductsMethods } from "./database/products.js";
import { qrCodesMethods, type QrCodesMethods } from "./database/qrCodes.js";
import { rawMaterialQrMethods, type RawMaterialQrMethods } from "./database/rawMaterialQr.js";
import { dispatchMethods, type DispatchMethods } from "./database/dispatch.js";
import { storeMethods, type StoreMethods } from "./database/store.js";
import { gatepassMethods, type GatepassMethods } from "./database/gatepass.js";
import { usersMethods, type UsersMethods } from "./database/users.js";
import { rawMaterialsMethods, type RawMaterialsMethods } from "./database/rawMaterials.js";
import { machineProgramsMethods, type MachineProgramsMethods } from "./database/machinePrograms.js";
import { machineProgramStockMethods, type MachineProgramStockMethods } from "./database/machineProgramStock.js";
import { machineProgramWritesMethods, type MachineProgramWritesMethods } from "./database/machineProgramWrites.js";
import { machineProgramStoreOutMethods, type MachineProgramStoreOutMethods } from "./database/machineProgramStoreOut.js";
import { machineProgramCartonsMethods, type MachineProgramCartonsMethods } from "./database/machineProgramCartons.js";
import { machineProgramReconciliationMethods, type MachineProgramReconciliationMethods } from "./database/machineProgramReconciliation.js";
import { machineProgramDanaMethods, type MachineProgramDanaMethods } from "./database/machineProgramDana.js";
import { productClassificationMethods, type ProductClassificationMethods } from "./database/productClassification.js";
import { machineProgramRatesMethods, type MachineProgramRatesMethods } from "./database/machineProgramRates.js";
import { stockCorrectionsMethods, type StockCorrectionsMethods } from "./database/stockCorrections.js";
import { removalRequestsMethods, type RemovalRequestsMethods } from "./database/removalRequests.js";
import { inventoryMovesMethods, type InventoryMovesMethods } from "./database/inventoryMoves.js";
import { itemUnitLadderMethods, type ItemUnitLadderMethods } from "./database/itemUnitLadder.js";
import { rawMaterialHandMoveMethods, type RawMaterialHandMoveMethods } from "./database/rawMaterialHandMove.js";
import { inventoryImportMethods, type InventoryImportMethods } from "./database/inventoryImport.js";
import { partiesMethods, type PartiesMethods } from "./database/parties.js";
import { salesMethods, type SalesMethods } from "./database/sales.js";
import { saleReturnsMethods, type SaleReturnsMethods } from "./database/saleReturns.js";
import { cashMethods, type CashMethods } from "./database/cash.js";
import { purchasesMethods, type PurchasesMethods } from "./database/purchases.js";
import { contractorLedgerMethods, type ContractorLedgerMethods } from "./database/contractorLedger.js";
import { storeDailyReportMethods, type StoreDailyReportMethods } from "./database/storeDailyReport.js";
import { numberRangeMethods, type NumberRangeMethods } from "./database/numberRange.js";
import { productVariantSeedMethods, type ProductVariantSeedMethods } from "./database/productVariantSeed.js";
import { machineProgramUpperReconciliationMethods, type MachineProgramUpperReconciliationMethods } from "./database/machineProgramUpperReconciliation.js";
import { partyClaimsMethods, type PartyClaimsMethods } from "./database/partyClaims.js";
import { cartonProgramMethods, type CartonProgramMethods } from "./database/cartonProgram.js";
import { productionReceiptsMethods, type ProductionReceiptsMethods } from "./database/productionReceipts.js";
import { upperMoveOutMethods, type UpperMoveOutMethods } from "./database/upperMoveOut.js";
import { productionReconciliationMethods, type ProductionReconciliationMethods } from "./database/productionReconciliation.js";
import { manualProductionMethods, type ManualProductionMethods } from "./database/manualProduction.js";
import type { BackupRecord, HealthSnapshot, MoneyDriftSummary, MoneyDriftViolation, SqliteDatabaseOptions } from "./database/types.js";

// The data layer's public record shapes and constants live in ./database/types.ts and are
// re-exported here so `@erp/data` keeps one import surface.
export * from "./database/types.js";
export { orderBy } from "./database/shared.js";
export type { MutableTransactionContext } from "./database/shared.js";
export type { ContractorLedgerAccount, ContractorLedgerReport } from "./database/contractorLedger.js";
export {
  NumberRangeError,
  NUMBER_SITES,
  NUMBER_BLOCK_SETTING_KEY,
  NUMBER_BLOCK_CONFIRMED_KEY,
  NUMBER_BLOCK_SIZE,
  MAX_ASSIGNABLE_BLOCK,
  rangeForBlock,
  isAssignableBlock,
  EXISTING_DATA_BLOCK,
  PROTECTED_NUMBER_SETTING_KEYS,
  checkExistingDataAdoption,
} from "./database/numberRange.js";
export type { NumberRange, NumberSiteKey, NumberBlockStatus, AdoptionCheck, AdoptRefusal } from "./database/numberRange.js";
export {
  SYNC_AGGREGATE,
  QR_MASTER_OPENING_STATE,
  qrMasterDedupeKey,
  productionProducedDedupeKey,
  readQrMasterPayload,
  readProductionProducedPayload,
  enqueueSyncEvent,
  enqueueQrMaster,
  enqueueProductionProduced,
} from "./database/syncEvents.js";
export type { SyncAggregateType, QrMasterPayload, ProductionProducedPayload } from "./database/syncEvents.js";
export {
  PRODUCT_VARIANT_SEED_FORMAT,
  PRODUCT_VARIANT_SEED_VERSION,
  SEED_TABLES,
  readSeedFile,
} from "./database/productVariantSeed.js";
export type {
  ProductVariantSeedFile,
  SeedExportResult,
  SeedImportResult,
  SeedVerdict,
  SeedOutcome,
  SeedRow,
} from "./database/productVariantSeed.js";

/**
 * The migration number a file name or a recorded version starts with: both
 * "076_line_carton_labels.up.sql" and "076_line_carton_labels" are 76.
 *
 * Numeric, not lexicographic, so the comparison keeps working past 999, and anything that does
 * not begin with digits counts as 0 rather than throwing — a database may carry a version string
 * this build has never seen, and that on its own is not a reason to refuse it.
 */
const highestMigrationNumber = (names: readonly string[]): number =>
  names.reduce((highest, name) => {
    const digits = /^(\d+)/.exec(name.trim());
    return digits ? Math.max(highest, Number(digits[1])) : highest;
  }, 0);

/**
 * The copy of the database taken before a migration run, as the desktop app reports it.
 *
 * `recorded` says whether the row in backup_history was written. The FILE is what protects the
 * data, so a false here means the backup exists and its bookkeeping does not — worth saying out
 * loud, and not a reason to have refused the upgrade.
 */
export interface PreMigrationBackup {
  readonly backupPath: string;
  /** Migration ceiling the database was on beforehand. 0 for one that predates versioning. */
  readonly fromVersion: number;
  /** Highest migration this run applied. */
  readonly toVersion: number;
  /** How many migration files were pending. */
  readonly pending: number;
  readonly recorded: boolean;
  readonly recordError?: string;
}

/** What started a sync pass. Mirrors the CHECK on sync_runs.trigger. */
export type SyncRunTrigger = "STARTUP" | "TIMER" | "RECONNECT" | "MANUAL";

/** How a sync pass ended. Mirrors the CHECK on sync_runs.outcome. */
export type SyncRunOutcome = "OK" | "REFUSED" | "TRANSPORT_ERROR" | "FAILED";

/**
 * One recorded sync attempt.
 *
 * Counts are null when the pass never got far enough to have any — a refused claim has no push
 * or pull figures, and "none" is a different fact from "zero".
 */
export interface SyncRunRecord {
  readonly id: string;
  readonly startedAt: string;
  /** Null while a pass is running, or forever if the process died mid-pass. */
  readonly finishedAt: string | null;
  readonly trigger: SyncRunTrigger;
  readonly outcome: SyncRunOutcome | null;
  readonly pushed: number | null;
  readonly fetched: number | null;
  readonly applied: number | null;
  readonly duplicates: number | null;
  readonly refused: number | null;
  readonly reason: string | null;
}

const COUNTABLE_TABLES = new Set([
  "qr_master",
  "production_events",
  "sync_outbox",
  "stock_projection_by_variant",
  "product_variants",
]);

/**
 * Every monetary REAL column that still has a `*_paisa` sibling, for checkMoneyDrift below.
 *
 * migrations/sqlite/029_money_paisa_columns added a `*_paisa` sibling to every monetary REAL
 * column additively, and migrations/sqlite/030_retire_real_money_columns has since dropped the
 * REAL side everywhere it was actively dual-written — INTEGER paisa is now the sole
 * authoritative representation for those columns (see local-schema.sql's header comment).
 * `report_daily_summary` is the sole exception: its REAL/paisa pair has no reader or writer
 * anywhere in the codebase, so it was left in place rather than folded into that migration, and
 * it remains here only so a drift check keeps covering it if it's ever wired up.
 *
 * The third element is the SQL expression identifying a row for the violation report;
 * `report_daily_summary`'s primary key is the composite (report_date, factory_id).
 */
const MONEY_PAISA_COLUMNS: ReadonlyArray<readonly [string, string, string]> = [
  ["report_daily_summary", "inventory_value_cost", "report_date || ':' || factory_id"],
  ["report_daily_summary", "inventory_value_sales", "report_date || ':' || factory_id"],
];

/**
 * The local SQLite database — the ERP's operational store and the implementation of every
 * repository port in @erp/application.
 *
 * This file holds only the connection, boot/migrations, transactions, settings, backups and
 * health. The business methods live in ./database/<feature>.ts (products, qrCodes,
 * dispatch, store, gatepass, users, rawMaterials, parties, sales, cash, purchases,
 * production) and are merged onto this class at the bottom of the file, so callers still
 * see one `SqliteDatabase` with the same API. To find a method, open the feature file.
 */
export class SqliteDatabase
  implements
    TransactionManager,
    DuplicateChecker,
    ProductCatalogRepository,
    QrMasterRepository,
    ProductionEventsRepository,
    StockProjectionRepository,
    OutboxRepository
{
  /** @internal Shared connection; feature modules (database/*.ts) use it through `this`. */
  db: DatabaseSync;
  private readonly dbPath: string;
  private readonly schemaPath: string;
  private readonly migrationsDir: string;
  private readonly transactionRetries = 4;
  /**
   * The safety copy this boot took before migrating, or null when nothing was pending.
   *
   * Read by the desktop app at startup so the path reaches the log. This class has no logger of
   * its own and must not grow one — it is the data layer, and inventing a second logging path
   * here is exactly the kind of parallel mechanism CLAUDE.md §2 rules out.
   */
  preMigrationBackup: PreMigrationBackup | null = null;

  constructor(private readonly options: SqliteDatabaseOptions) {
    this.dbPath = options.dbPath;
    this.schemaPath = options.schemaPath ?? path.resolve(process.cwd(), "packages/data/src/local-schema.sql");
    // Repository layout by default (migrations/ sits three levels above the schema); the desktop
    // app overrides both so a packaged installation reads them from its resources folder.
    this.migrationsDir = options.migrationsDir ?? path.resolve(path.dirname(this.schemaPath), "../../..", "migrations", "sqlite");
    // ASKED BEFORE THE CONNECTION IS OPENED, because opening one creates the file. A database
    // that did not exist a moment ago holds nothing a migration could damage, and taking a
    // "safety copy" of an empty file would only bury the real backups under meaningless ones.
    const databaseExisted = fs.existsSync(this.dbPath);
    this.db = new DatabaseSync(this.dbPath);
    try {
      this.bootConnection(databaseExisted);
    } catch (error) {
      // Leave no open handle behind on a failed boot. The caller is about to report a fatal
      // startup error, and on Windows an open handle also keeps the file locked afterwards.
      try {
        this.db.close();
      } catch {
        // Already closed.
      }
      throw error;
    }
  }

  private bootConnection(databaseExisted = true): void {
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    // FIRST, before anything writes. The base schema below is CREATE ... IF NOT EXISTS, which
    // sounds harmless but is not on a newer database: a later migration may have deliberately
    // dropped an index or rebuilt a table this build's schema file still describes, and
    // re-running it would put them back. Nothing may touch a database this build cannot support.
    this.ensureDatabaseIsNotNewerThanThisBuild();

    // THE WAY BACK, copied before a single statement is executed against the live file.
    //
    // An upgrade runs migrations unattended, against the company's inventory and accounting
    // data, on a factory PC with nobody watching. The migration runner is transactional, so a
    // migration that THROWS rolls back — but a migration that succeeds and is wrong does not,
    // and `*.down.sql` files are never shipped or executed, so there is no rollback path in the
    // application at all. A file-level copy is the only thing that can undo it.
    //
    // Placed above readSchema() on purpose: the copy is of the database as this build found it,
    // before even the idempotent CREATE ... IF NOT EXISTS statements have run.
    const safetyCopy = databaseExisted ? this.copyDatabaseBeforeMigrating() : null;

    this.db.exec(this.readSchema());
    try {
      this.runMigrations();
    } catch (error) {
      // The copy is what makes this error recoverable, so the error has to say where it is.
      // Without this the operator sees a failed upgrade and no indication that a way back
      // exists — which is exactly the moment the path matters most.
      if (safetyCopy === null) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        [
          `The database could not be upgraded: ${reason}`,
          "",
          "Nothing was left half-migrated — the upgrade ran in one transaction and rolled back.",
          "A copy of the database as it was BEFORE this attempt is here:",
          "",
          `  ${safetyCopy.backupPath}`,
        ].join("\n"),
        { cause: error }
      );
    }
    // After the migrations, because this is the run that teaches backup_history the
    // 'PRE_MIGRATION' type (migration 084). Recorded here, the row is always allowed.
    if (safetyCopy !== null) this.recordSafetyCopy(safetyCopy);

    this.ensureSchemaCompatibility();
    this.ensureDefaultRoles();
  }

  /** Where the backups for this database live. One derivation, shared with seedDefaultSettings. */
  private backupFolder(): string {
    return path.join(path.dirname(this.dbPath), "backups");
  }

  /**
   * Copies the database before any migration runs, and returns where it went.
   *
   * Returns null when there is nothing pending: an ordinary launch is the common case by far,
   * and copying ~16 MB on every start would be both slow and useless.
   *
   * A FAILURE HERE STOPS THE APPLICATION, deliberately. The alternative is migrating the
   * company's data with no way back because the disk was full — and a refusal to start is
   * recoverable in a way a bad migration is not (CLAUDE.md §23: data integrity first).
   */
  private copyDatabaseBeforeMigrating(): { backupPath: string; fromVersion: number; toVersion: number; pending: number } | null {
    const pending = this.pendingMigrationFiles();
    if (pending.length === 0) return null;

    const fromVersion = this.appliedMigrationCeiling();
    const toVersion = highestMigrationNumber(pending);
    const folder = this.backupFolder();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(folder, `erp-premigration-${String(fromVersion)}-to-${String(toVersion)}-${stamp}.sqlite`);

    try {
      fs.mkdirSync(folder, { recursive: true });
      // Never overwrite a backup. The stamp carries milliseconds so this is all but impossible,
      // and if it ever happens the honest answer is to stop rather than destroy the older copy.
      if (fs.existsSync(backupPath)) {
        throw new Error(`a file is already there (${backupPath})`);
      }
      // WAL first: the checkpoint folds pending writes into the main file, so VACUUM INTO cannot
      // produce a copy that is missing the most recent committed work.
      this.db.exec("PRAGMA wal_checkpoint(FULL);");
      this.db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        [
          `777 ERP must upgrade its database, but could not first save a backup: ${reason}`,
          "",
          `  Backup folder   : ${folder}`,
          `  Database        : ${this.dbPath}`,
          `  Upgrading from  : ${String(fromVersion)} to ${String(toVersion)}`,
          "",
          "The database has NOT been changed. Free some disk space on this computer and start",
          "777 ERP again — it will take the backup and then upgrade.",
        ].join("\n"),
        { cause: error }
      );
    }

    return { backupPath, fromVersion, toVersion, pending: pending.length };
  }

  /**
   * Records the safety copy in backup_history, so it appears in Settings beside every other
   * backup rather than only in a log the operator would have to be told to read.
   *
   * NEVER FATAL. The file on disk is the thing that protects the data; its bookkeeping row is a
   * convenience. A failure is kept on `preMigrationBackup` for the desktop app to log, so it is
   * surfaced rather than swallowed (R12).
   */
  private recordSafetyCopy(copy: { backupPath: string; fromVersion: number; toVersion: number; pending: number }): void {
    try {
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO backup_history (
            id, backup_type, backup_path, checksum_sha256, size_bytes,
            verified, verification_at, status, created_at
          ) VALUES (?, 'PRE_MIGRATION', ?, ?, ?, 1, ?, 'VERIFIED', ?)`
        )
        .run(crypto.randomUUID(), copy.backupPath, this.fileSha256(copy.backupPath), fs.statSync(copy.backupPath).size, now, now);
      this.preMigrationBackup = { ...copy, recorded: true };
    } catch (error) {
      this.preMigrationBackup = {
        ...copy,
        recorded: false,
        recordError: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * The newest migration this build is able to apply: the highest number among the `.up.sql`
   * files it actually ships. Read from the folder rather than a constant, so it can never
   * disagree with the artifact — electron-builder copies `migrations/sqlite` into
   * resources/erp-resources, and runtimePaths points `migrationsDir` at it.
   */
  private shippedMigrationCeiling(): number {
    if (!fs.existsSync(this.migrationsDir)) return 0;
    return highestMigrationNumber(
      fs.readdirSync(this.migrationsDir).filter((file) => file.endsWith(".up.sql"))
    );
  }

  /**
   * The newest migration recorded as applied to this database. 0 for a fresh one.
   *
   * The table is absent on a brand-new file and on a database old enough to predate versioned
   * migrations — runMigrations creates it, and this runs before that. Either way there is no
   * recorded migration, so there is nothing this build could be behind.
   */
  private appliedMigrationCeiling(): number {
    return highestMigrationNumber([...this.appliedMigrationVersions()]);
  }

  /**
   * Every migration version recorded against this database, or an empty set when there is no
   * record to read.
   *
   * The table is absent on a brand-new file and on a database old enough to predate versioned
   * migrations — runMigrations creates it, and this may run before that.
   */
  private appliedMigrationVersions(): Set<string> {
    const tracked = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations' LIMIT 1")
      .get();
    if (!tracked) return new Set();
    const rows = this.db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: string }>;
    return new Set(rows.map((row) => row.version));
  }

  /**
   * The `*.up.sql` file names this build ships and this database has not applied, in order.
   *
   * ONE DEFINITION, used twice: the safety copy above decides whether to run from it, and
   * runMigrations applies exactly what it returns. Two separate notions of "pending" could
   * disagree, and the one that decides whether to take a backup is not the one to get wrong.
   */
  private pendingMigrationFiles(): string[] {
    if (!fs.existsSync(this.migrationsDir)) return [];
    const applied = this.appliedMigrationVersions();
    return fs
      .readdirSync(this.migrationsDir)
      .filter((file) => file.endsWith(".up.sql"))
      .sort()
      .filter((file) => !applied.has(file.replace(/\.up\.sql$/, "")));
  }

  /**
   * Refuses to open a database that has been migrated further than this build understands.
   *
   * The database lives in %LOCALAPPDATA%\777-erp, outside the installation, so it survives
   * install, upgrade and uninstall. Install an older build over a newer one and runMigrations
   * finds nothing pending — it only applies files it HAS — so without this check the older code
   * would read and write a schema it was never written for: tables it does not know about,
   * columns it does not expect, and CHECK constraints it cannot satisfy. Silent, and against
   * live inventory and accounting data.
   *
   * It refuses only. It never runs a `.down.sql` — electron-builder deliberately ships only
   * `*.up.sql`, because the application has no downgrade path — and it never deletes anything.
   * Going back means installing the build that matches, or restoring a backup from that schema.
   *
   * Thrown from the constructor, so apps/desktop/src/main.ts reports it through
   * reportFatalStartupError (stage "database"): one dialog naming startup.log, then exit.
   */
  private ensureDatabaseIsNotNewerThanThisBuild(): void {
    const supported = this.shippedMigrationCeiling();
    const applied = this.appliedMigrationCeiling();
    if (applied <= supported) return;

    throw new Error(
      [
        "This database was created by a newer version of 777 ERP than the one installed.",
        "",
        `  Database schema level : ${applied}`,
        `  This version supports : ${supported}`,
        `  Database              : ${this.dbPath}`,
        "",
        "Nothing has been changed. Install the newer version of 777 ERP to open this database.",
        "The database cannot be moved back to an older version — if you must use this older",
        "version, restore a backup taken before the upgrade, which will lose any work done since.",
      ].join("\n")
    );
  }

  /**
   * The base schema. A missing file means a broken or incomplete installation — far better to
   * refuse to start than to run the ERP on whatever tables happen to exist already.
   */
  private readSchema(): string {
    if (!fs.existsSync(this.schemaPath)) {
      throw new Error(`Database schema not found at ${this.schemaPath}. The installation is incomplete.`);
    }
    return fs.readFileSync(this.schemaPath, "utf-8");
  }

  private ensureSchemaCompatibility(): void {
    try { this.db.prepare("ALTER TABLE roles ADD COLUMN description TEXT").run(); } catch { /* ignore */ }
    try { this.db.prepare("ALTER TABLE roles ADD COLUMN is_system_role INTEGER NOT NULL DEFAULT 0").run(); } catch { /* ignore */ }
    try { this.db.prepare("ALTER TABLE roles ADD COLUMN login_policy TEXT NOT NULL DEFAULT 'ALWAYS_LOGGED_IN'").run(); } catch { /* ignore */ }
    try { this.db.prepare("ALTER TABLE article_sizes ADD COLUMN product_code TEXT").run(); } catch { /* ignore */ }
    try { this.db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_article_sizes_product_code ON article_sizes(product_code) WHERE product_code IS NOT NULL").run(); } catch { /* ignore */ }
    try {
      this.db.prepare(`CREATE TABLE IF NOT EXISTS permission_requests (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, permission_code TEXT NOT NULL, reason TEXT,
        status TEXT NOT NULL DEFAULT 'PENDING', requested_at TEXT NOT NULL, reviewed_at TEXT,
        reviewed_by TEXT, review_notes TEXT
      )`).run();
      this.db.prepare("CREATE INDEX IF NOT EXISTS idx_permission_requests_user ON permission_requests(user_id, requested_at DESC)").run();
      this.db.prepare("CREATE INDEX IF NOT EXISTS idx_permission_requests_status ON permission_requests(status)").run();
    } catch { /* ignore */ }
  }

  private ensureDefaultRoles(): void {
    const builtInRoles = [
      {
        name: "Billing Manager",
        permissions: ["sale-voucher-form", "sale-voucher-list", "customer-ledger", "customer-balance"],
      },
      {
        name: "Accounts Manager",
        permissions: ["cash-voucher-form", "cash-voucher-list", "customer-ledger", "customer-balance"],
      },
      {
        name: "Production Manager",
        permissions: ["live-production", "daily-production", "production-history"],
      },
      {
        name: "Dispatch Manager",
        permissions: ["live-dispatch", "daily-dispatch", "dispatch-history"],
      },
      {
        name: "Inventory Manager",
        permissions: ["stock", "product-list", "product-form", "discount-policy"],
      },
      {
        // Receives production cartons into the store and can look up store stock. No
        // Product Master, QR Generator, Settings or QR Management corrections.
        name: "Store Operator",
        permissions: ["store-scanning", "stock"],
      },
      {
        // Cuts store stock for a party on paper (Gatepass). Can look up store stock; cannot
        // scan, bill, or cancel a gatepass.
        name: "Gatepass Clerk",
        permissions: ["gatepass", "stock"],
      },
    ];

    for (const role of builtInRoles) {
      const existing = this.db.prepare("SELECT role_code FROM roles WHERE role_name = ?").get(role.name) as { role_code?: string } | undefined;
      if (!existing) {
        const created = this.createRole({ name: role.name, description: `${role.name} access profile`, permissions: role.permissions });
        if (created) {
          const now = new Date().toISOString();
          this.db.prepare("UPDATE roles SET is_system_role = 1, updated_at = ? WHERE role_code = ?").run(now, created.code);
        }
      }
    }

    this.migrateLegacyPermissionsToRoles();
  }

  private migrateLegacyPermissionsToRoles(): void {
    try {
      const roleRows = this.db.prepare("SELECT role_code, role_name FROM roles").all() as Array<{ role_code: string; role_name: string }>;
      const rolePermMap = new Map<string, Set<string>>();
      for (const r of roleRows) {
        const perms = this.db.prepare("SELECT permission_code FROM role_permissions WHERE role_code = ?").all(r.role_code) as Array<{ permission_code: string }>;
        rolePermMap.set(r.role_code, new Set(perms.map((p) => this.normalizePermissionCode(p.permission_code)).filter(Boolean)));
      }

      const legacyUsers = this.db.prepare(`
        SELECT u.id, u.permissions_json, u.role, u.access_status
        FROM app_users u
        LEFT JOIN user_role_assignments ura ON ura.user_id = u.id
        WHERE ura.user_id IS NULL
          AND u.role <> 'ADMIN'
          AND u.access_status = 'APPROVED'
          AND u.permissions_json IS NOT NULL
          AND u.permissions_json <> '[]'
      `).all() as Array<{ id: string; permissions_json: string; role: string; access_status: string }>;

      for (const user of legacyUsers) {
        let legacyPerms: string[] = [];
        try {
          legacyPerms = (JSON.parse(user.permissions_json || "[]") as string[])
            .map((p) => this.normalizePermissionCode(p))
            .filter(Boolean);
        } catch {
          continue;
        }
        if (legacyPerms.length === 0) continue;

        const hasAnyAdditional = (this.db.prepare("SELECT COUNT(*) AS c FROM user_additional_permissions WHERE user_id = ?").get(user.id) as { c: number })?.c ?? 0;
        if (hasAnyAdditional > 0) continue;

        const legacySet = new Set(legacyPerms);
        let matchedRoleCode: string | null = null;
        for (const [roleCode, rolePerms] of rolePermMap.entries()) {
          if (rolePerms.size === legacySet.size && [...rolePerms].every((p) => legacySet.has(p))) {
            matchedRoleCode = roleCode;
            break;
          }
        }

        const now = new Date().toISOString();
        if (matchedRoleCode) {
          try {
            this.db.prepare(`INSERT INTO user_role_assignments (user_id, role_code, assigned_at, assigned_by) VALUES (?, ?, ?, ?)`).run(user.id, matchedRoleCode, now, "migration");
          } catch {
            continue;
          }
        } else {
          for (const perm of legacyPerms) {
            try {
              this.db.prepare(`INSERT OR IGNORE INTO user_additional_permissions (user_id, permission_code, granted_at, granted_by) VALUES (?, ?, ?, ?)`).run(user.id, perm, now, "migration");
            } catch {
              continue;
            }
          }
        }

        this.persistEffectivePermissions(user.id);
      }
    } catch {
      // Ignore migration errors; legacy permissions_json still acts as fallback.
    }
  }

  private runMigrations(): void {
    const migrationsDir = this.migrationsDir;
    // Checked before anything is written. A missing folder used to be ignored, which let the app
    // boot happily on an older schema — the worst possible outcome, because it is invisible until
    // the data is already wrong. An incomplete installation must stop the application instead.
    if (!fs.existsSync(migrationsDir)) {
      throw new Error(
        `Migration folder not found at ${migrationsDir}. Refusing to start: the database would be left on an outdated schema.`
      );
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);

    const pending = this.pendingMigrationFiles();
    // Disable FK enforcement for the whole migration run so table-rebuild migrations
    // (drop/rename of a referenced table, e.g. parties) can run. PRAGMA foreign_keys is a
    // no-op inside a transaction, so it must wrap the outer transaction.
    if (pending.length > 0) {
      this.db.exec("PRAGMA foreign_keys = OFF;");
      this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    }
    try {
      for (const file of pending) {
        const version = file.replace(/\.up\.sql$/, "");
        const statements = fs.readFileSync(path.join(migrationsDir, file), "utf-8")
          .split(";")
          .map((statement) => statement.trim())
          .filter(Boolean);

        for (const statement of statements) {
          try {
            this.db.exec(statement);
          } catch (error) {
            const message = error instanceof Error ? error.message.toLowerCase() : "";
            if (!message.includes("duplicate column name")) throw error;
          }
        }
        this.db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(version, new Date().toISOString());
      }
      if (pending.length > 0) this.db.exec("COMMIT");
    } catch (error) {
      if (pending.length > 0) this.db.exec("ROLLBACK");
      throw error;
    } finally {
      if (pending.length > 0) this.db.exec("PRAGMA foreign_keys = ON;");
    }

    // Databases created before versioned migrations still need these historical fixes.
    // (parties.balance_limit's own fallback ADD COLUMN was removed here — it predated
    // migrations/sqlite/030_retire_real_money_columns and would otherwise silently re-add that
    // retired REAL column, empty, on every boot right after the migration drops it.)
    try {
      this.db.exec("ALTER TABLE roles ADD COLUMN description TEXT");
    } catch {
      // Column already exists.
    }
  }

  close(): void {
    this.db.close();
  }

  getDbPath(): string {
    return this.dbPath;
  }

  async runInTransaction<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt <= this.transactionRetries; attempt += 1) {
      const txContext: MutableTransactionContext = {
        nowIso: new Date().toISOString(),
        db: this.db,
      };

      try {
        this.db.exec("BEGIN IMMEDIATE TRANSACTION");
        const result = await work(txContext);
        this.db.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // Ignore missing transaction state.
        }

        const text = error instanceof Error ? error.message.toLowerCase() : "";
        if ((text.includes("locked") || text.includes("busy")) && attempt < this.transactionRetries) {
          await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
          continue;
        }

        throw error;
      }
    }

    throw new Error("Transaction failed after retries.");
  }

  ensureOperationalContext(context: {
    factoryId: string;
    factoryCode: string;
    factoryName: string;
    workstationId: string;
    workstationCode: string;
    workstationName: string;
    deviceId: string;
    deviceName: string;
    appVersion: string;
  }): void {
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO factories (id, code, name, timezone, is_active, created_at, updated_at, deleted_at, deleted_by, delete_reason)
         VALUES (?, ?, ?, 'Asia/Karachi', 1, ?, ?, NULL, NULL, NULL)
         ON CONFLICT(id) DO UPDATE SET code = excluded.code, name = excluded.name, updated_at = excluded.updated_at`
      )
      .run(context.factoryId, context.factoryCode, context.factoryName, now, now);

    this.db
      .prepare(
        `INSERT INTO workstations (
          id, factory_id, workstation_code, device_id, name, is_active,
          created_at, updated_at, deleted_at, deleted_by, delete_reason
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, NULL, NULL, NULL)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          device_id = excluded.device_id,
          updated_at = excluded.updated_at`
      )
      .run(context.workstationId, context.factoryId, context.workstationCode, context.deviceId, context.workstationName, now, now);

    this.db
      .prepare(
        `INSERT INTO devices (
          id, device_name, factory_id, workstation_id, os_name, app_version,
          is_active, last_seen_at, last_sync_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, NULL, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          device_name = excluded.device_name,
          factory_id = excluded.factory_id,
          workstation_id = excluded.workstation_id,
          app_version = excluded.app_version,
          last_seen_at = excluded.last_seen_at,
          updated_at = excluded.updated_at`
      )
      .run(
        context.deviceId,
        context.deviceName,
        context.factoryId,
        context.workstationId,
        process.platform,
        context.appVersion,
        now,
        now,
        now
      );

    this.seedDefaultSettings({
      factoryId: context.factoryId,
      factoryName: context.factoryName,
      workstation: context.workstationName,
      deviceName: context.deviceName,
      dbPath: this.dbPath,
      backupFolder: path.join(path.dirname(this.dbPath), "backups"),
    });
  }

  /**
   * The workstation this database already belongs to, or null on a fresh database.
   *
   * Read-only, and used for one thing: an installation that predates per-machine identities
   * must keep the workstation its own history refers to. `production_events.workstation_id`
   * is a foreign key to `workstations(id)`, so inventing a new identity for an existing
   * database would split one physical machine across two workstation rows.
   *
   * Oldest row wins, so the answer cannot change once a second workstation exists.
   */
  findExistingWorkstation(): { workstationId: string; workstationCode: string; workstationName: string; deviceId: string } | null {
    const row = this.db
      .prepare(
        `SELECT id, workstation_code, name, device_id
         FROM workstations
         WHERE deleted_at IS NULL
         ORDER BY created_at ASC, id ASC
         LIMIT 1`
      )
      .get() as { id: string; workstation_code: string; name: string; device_id: string } | undefined;

    if (!row) return null;
    return {
      workstationId: String(row.id),
      workstationCode: String(row.workstation_code),
      workstationName: String(row.name),
      deviceId: String(row.device_id),
    };
  }

  updateDeviceHeartbeat(deviceId: string): void {
    this.db.prepare("UPDATE devices SET last_seen_at = ?, updated_at = ? WHERE id = ?").run(new Date().toISOString(), new Date().toISOString(), deviceId);
  }

  setSettings(entries: Record<string, string>, updatedBy = "system"): void {
    const now = new Date().toISOString();
    for (const [key, value] of Object.entries(entries)) {
      this.db
        .prepare(
          `INSERT INTO app_settings (setting_key, setting_value, value_type, is_encrypted, updated_by, updated_at)
           VALUES (?, ?, 'string', 0, ?, ?)
           ON CONFLICT(setting_key) DO UPDATE SET
             setting_value = excluded.setting_value,
             updated_by = excluded.updated_by,
             updated_at = excluded.updated_at`
        )
        .run(key, value, updatedBy, now);
    }
  }

  getSettings(): Record<string, string> {
    const rows = this.db.prepare("SELECT setting_key, setting_value FROM app_settings ORDER BY setting_key ASC").all() as Array<
      Record<string, unknown>
    >;
    const output: Record<string, string> = {};
    for (const row of rows) {
      output[String(row.setting_key)] = String(row.setting_value ?? "");
    }
    return output;
  }

  createBackup(backupFolder: string, backupType: "AUTO_DAILY" | "MANUAL" = "MANUAL"): BackupRecord {
    fs.mkdirSync(backupFolder, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(backupFolder, `erp-backup-${stamp}.sqlite`);

    this.db.exec("PRAGMA wal_checkpoint(FULL);");
    const escapedPath = backupPath.replace(/'/g, "''");
    this.db.exec(`VACUUM INTO '${escapedPath}'`);

    const fileBuffer = fs.readFileSync(backupPath);
    const checksum = createHash("sha256").update(fileBuffer).digest("hex");
    const sizeBytes = fileBuffer.byteLength;
    const now = new Date().toISOString();
    const id = crypto.randomUUID();

    this.db
      .prepare(
        `INSERT INTO backup_history (
          id, backup_type, backup_path, checksum_sha256, size_bytes,
          verified, verification_at, status, created_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, 'VERIFIED', ?)`
      )
      .run(id, backupType, backupPath, checksum, sizeBytes, now, now);

    return {
      id,
      backupType,
      backupPath,
      checksumSha256: checksum,
      sizeBytes,
      verified: true,
      verificationAt: now,
      status: "VERIFIED",
      createdAt: now,
    };
  }

  /**
   * Replaces the live database with a backup.
   *
   * THIS DOES NOT UNDO AN UPDATE, and the guard below exists because it looks as though it
   * should. Restoring re-runs bootConnection(), which migrates whatever was restored — so on a
   * newer build, a pre-upgrade backup is walked straight back up to the new schema. Pinned by
   * preMigrationBackup.test.ts. A version rollback has to replace the APPLICATION first; see
   * docs/36 §4.
   *
   * So the schema levels are compared before anything is copied:
   *
   *   equal        the ordinary data-recovery path — restore yesterday's data onto today's
   *                build. Proceeds without ceremony.
   *   backup older legitimate, but easy to attempt for the wrong reason. Refused unless the
   *                caller passes `confirmSchemaRollback`, having been told what it does and
   *                does not do.
   *   backup newer refused outright, and not confirmable. This build cannot run that schema —
   *                the same refusal ensureDatabaseIsNotNewerThanThisBuild makes at boot.
   *
   * There is deliberately no UI for this yet. When one is added it must be ADMIN-ONLY and must
   * put the warning below in front of the operator, not a generic "are you sure?".
   */
  restoreBackup(backupPath: string, options: { confirmSchemaRollback?: boolean } = {}): void {
    if (!fs.existsSync(backupPath)) {
      throw new Error("Backup file does not exist.");
    }

    this.assertBackupIsRestorable(backupPath, options.confirmSchemaRollback === true);

    this.close();
    fs.copyFileSync(backupPath, this.dbPath);
    this.db = new DatabaseSync(this.dbPath);
    this.bootConnection();

    this.db
      .prepare(
        `INSERT INTO backup_history (
          id, backup_type, backup_path, checksum_sha256, size_bytes,
          verified, verification_at, status, created_at
        ) VALUES (?, 'MANUAL', ?, ?, ?, 1, ?, 'RESTORED', ?)`
      )
      .run(
        crypto.randomUUID(),
        backupPath,
        this.fileSha256(backupPath),
        fs.statSync(backupPath).size,
        new Date().toISOString(),
        new Date().toISOString()
      );
  }

  /**
   * Checks a backup can be restored onto THIS build, and refuses with a usable explanation when
   * it cannot. Read-only: the candidate is opened read-only and the live database is not touched.
   */
  private assertBackupIsRestorable(backupPath: string, confirmed: boolean): void {
    const shipped = this.shippedMigrationCeiling();
    let inBackup: number;
    try {
      const candidate = new DatabaseSync(backupPath, { readOnly: true });
      try {
        // Refuse to copy an unusable file over the live database — the one outcome worse than
        // refusing to restore at all.
        const integrity = candidate.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
        const verdict = String(integrity?.integrity_check ?? "");
        if (verdict !== "ok") {
          throw new Error(`its integrity check reported "${verdict}" instead of "ok"`);
        }
        const tracked = candidate
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations' LIMIT 1")
          .get();
        const rows = tracked
          ? (candidate.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: string }>)
          : [];
        inBackup = highestMigrationNumber(rows.map((row) => row.version));
      } finally {
        candidate.close();
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `That backup cannot be read as a 777 ERP database (${reason}). Nothing has been changed.\n\n  ${backupPath}`
      );
    }

    if (inBackup === shipped) return;

    if (inBackup > shipped) {
      throw new Error(
        [
          "That backup was made by a NEWER version of 777 ERP than the one installed, so this",
          "version cannot open it. Nothing has been changed.",
          "",
          `  Backup schema level   : ${String(inBackup)}`,
          `  This version supports : ${String(shipped)}`,
          "",
          "Install that newer version of 777 ERP and restore the backup there.",
        ].join("\n")
      );
    }

    if (!confirmed) {
      throw new Error(
        [
          "THIS WILL NOT UNDO AN UPDATE.",
          "",
          `That backup is from schema level ${String(inBackup)} and this version is at ${String(shipped)}.`,
          "Restoring it does NOT take this computer back to the older version: 777 ERP will",
          "migrate the restored data forward to the current schema as soon as it reopens.",
          "",
          "What restoring it DOES do is replace everything in the database now with what was in",
          "the backup. That means losing every gatepass, bill, scan, production entry, voucher",
          "and stock movement recorded since the backup was taken. There is no way back from it",
          "except another backup.",
          "",
          "To go back to an older VERSION of 777 ERP, the application has to be replaced first.",
          "That procedure is in docs/36 section 4 and cannot be done from inside the application.",
          "",
          "If replacing the data is genuinely what is wanted, confirm it deliberately.",
        ].join("\n")
      );
    }
  }

  // ─── Cloud sync attempts ───────────────────────────────────────────────────
  //
  // Operational bookkeeping, beside backups and health rather than in a feature module: a sync
  // run is not a business record, it is this computer saying what it tried to do. See
  // migrations/sqlite/085_sync_runs.up.sql for why attempts are recorded instead of inferred
  // from sync_outbox side effects.

  /** Opens a run and returns its id. Call before the pass; finishSyncRun closes it. */
  startSyncRun(trigger: SyncRunTrigger): string {
    const id = crypto.randomUUID();
    this.db
      .prepare("INSERT INTO sync_runs (id, started_at, trigger) VALUES (?, ?, ?)")
      .run(id, new Date().toISOString(), trigger);
    return id;
  }

  /**
   * Closes a run with what happened.
   *
   * A run left open is a pass that never came back — the process was killed mid-sync — and that
   * is worth being able to see, so nothing here invents a finish for it.
   */
  finishSyncRun(
    id: string,
    outcome: SyncRunOutcome,
    counts: { pushed?: number; fetched?: number; applied?: number; duplicates?: number; refused?: number } = {},
    reason?: string
  ): void {
    this.db
      .prepare(
        `UPDATE sync_runs
            SET finished_at = ?, outcome = ?, pushed = ?, fetched = ?, applied = ?,
                duplicates = ?, refused = ?, reason = ?
          WHERE id = ?`
      )
      .run(
        new Date().toISOString(),
        outcome,
        counts.pushed ?? null,
        counts.fetched ?? null,
        counts.applied ?? null,
        counts.duplicates ?? null,
        counts.refused ?? null,
        reason ?? null,
        id
      );
  }

  /** The most recent attempt, and the most recent one that completed. Either may be null. */
  syncRunSummary(): { lastAttempt: SyncRunRecord | null; lastSuccess: SyncRunRecord | null } {
    const read = (sql: string): SyncRunRecord | null => {
      const row = this.db.prepare(sql).get() as Record<string, unknown> | undefined;
      if (!row) return null;
      return {
        id: String(row.id ?? ""),
        startedAt: String(row.started_at ?? ""),
        finishedAt: row.finished_at === null || row.finished_at === undefined ? null : String(row.finished_at),
        trigger: String(row.trigger ?? "") as SyncRunTrigger,
        outcome: row.outcome === null || row.outcome === undefined ? null : (String(row.outcome) as SyncRunOutcome),
        pushed: row.pushed === null || row.pushed === undefined ? null : Number(row.pushed),
        fetched: row.fetched === null || row.fetched === undefined ? null : Number(row.fetched),
        applied: row.applied === null || row.applied === undefined ? null : Number(row.applied),
        duplicates: row.duplicates === null || row.duplicates === undefined ? null : Number(row.duplicates),
        refused: row.refused === null || row.refused === undefined ? null : Number(row.refused),
        reason: row.reason === null || row.reason === undefined ? null : String(row.reason),
      };
    };
    return {
      lastAttempt: read("SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT 1"),
      lastSuccess: read("SELECT * FROM sync_runs WHERE outcome = 'OK' ORDER BY started_at DESC LIMIT 1"),
    };
  }

  listBackups(): BackupRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, backup_type, backup_path, checksum_sha256, size_bytes, verified, verification_at, status, created_at
         FROM backup_history
         ORDER BY created_at DESC`
      )
      .all() as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row.id ?? ""),
      backupType: String(row.backup_type ?? ""),
      backupPath: String(row.backup_path ?? ""),
      checksumSha256: String(row.checksum_sha256 ?? ""),
      sizeBytes: Number(row.size_bytes ?? 0),
      verified: Number(row.verified ?? 0) === 1,
      verificationAt: row.verification_at ? String(row.verification_at) : null,
      status: String(row.status ?? ""),
      createdAt: String(row.created_at ?? ""),
    }));
  }

  captureHealthSnapshot(input: {
    scannerConnected: boolean;
    appVersion: string;
    deviceId: string;
  }): HealthSnapshot {
    const stats = fs.statSync(this.dbPath);
    const pending = this.scalarCount("SELECT COUNT(1) as c FROM sync_outbox WHERE status IN ('PENDING','IN_FLIGHT')", []);
    const failed = this.scalarCount("SELECT COUNT(1) as c FROM sync_outbox WHERE status IN ('FAILED','DEAD_LETTER')", []);
    const latestBackup = this.db
      .prepare("SELECT status FROM backup_history ORDER BY created_at DESC LIMIT 1")
      .get() as { status: string } | undefined;

    // Runs only when Health is captured (manual refresh) — never on a timer, never on other
    // ERP operations. Reuses checkMoneyDrift() as-is; this is a summary of its result, not a
    // second drift calculation.
    const moneyDriftViolations = this.checkMoneyDrift();
    const moneyDrift: MoneyDriftSummary = {
      healthy: moneyDriftViolations.length === 0,
      pairsChecked: MONEY_PAISA_COLUMNS.length,
      violationCount: moneyDriftViolations.length,
      violations: moneyDriftViolations,
    };

    const snapshot: HealthSnapshot = {
      sqliteStatus: "OK",
      databaseSizeBytes: stats.size,
      pendingSyncQueue: pending,
      failedSyncQueue: failed,
      scannerConnected: input.scannerConnected,
      diskFreeBytes: os.freemem(),
      memoryUsageBytes: process.memoryUsage().rss,
      cpuLoadAverage: os.loadavg()[0] ?? 0,
      backupStatus: latestBackup?.status ?? "NONE",
      appVersion: input.appVersion,
      deviceId: input.deviceId,
      moneyDrift,
    };

    this.db
      .prepare(
        `INSERT INTO system_health_snapshots (
          id, captured_at, sqlite_ok, supabase_ok, scanner_connected,
          pending_sync_count, failed_sync_count, last_successful_sync_at,
          db_size_bytes, free_disk_bytes, backup_status, details_json
        ) VALUES (?, ?, 1, 0, ?, ?, ?, NULL, ?, ?, ?, ?)`
      )
      .run(
        crypto.randomUUID(),
        new Date().toISOString(),
        snapshot.scannerConnected ? 1 : 0,
        snapshot.pendingSyncQueue,
        snapshot.failedSyncQueue,
        snapshot.databaseSizeBytes,
        snapshot.diskFreeBytes,
        snapshot.backupStatus,
        JSON.stringify({ appVersion: snapshot.appVersion, deviceId: snapshot.deviceId, memoryUsageBytes: snapshot.memoryUsageBytes })
      );

    return snapshot;
  }

  getRowCount(tableName: string): number {
    if (!COUNTABLE_TABLES.has(tableName)) {
      throw new Error(`Table ${tableName} is not countable.`);
    }
    return this.scalarCount(`SELECT COUNT(1) as c FROM ${tableName}`, []);
  }

  /**
   * Proves every remaining REAL/`*_paisa` pair in MONEY_PAISA_COLUMNS hasn't drifted: the REAL
   * column must still equal its `*_paisa` sibling ÷ 100, for every row, on both sides (REAL set
   * but paisa NULL/wrong, or paisa set but REAL changed without updating it). Since
   * migrations/sqlite/030_retire_real_money_columns, only `report_daily_summary` still has a
   * REAL side to check — see the comment on MONEY_PAISA_COLUMNS. Returns every violation found —
   * empty means fully in sync.
   */
  checkMoneyDrift(): MoneyDriftViolation[] {
    const violations: MoneyDriftViolation[] = [];
    for (const [table, column, idExpression] of MONEY_PAISA_COLUMNS) {
      const paisaColumn = `${column}_paisa`;
      const rows = this.db
        .prepare(
          `SELECT ${idExpression} as id, ${column} as real_value, ${paisaColumn} as paisa_value
           FROM ${table}
           WHERE (${column} IS NULL) <> (${paisaColumn} IS NULL)
              OR (${column} IS NOT NULL AND ABS(CAST(ROUND(${column} * 100) AS INTEGER) - ${paisaColumn}) > 0)`
        )
        .all() as Array<{ id: string; real_value: number | null; paisa_value: number | null }>;
      for (const row of rows) {
        violations.push({
          table,
          column,
          id: row.id,
          realValue: row.real_value,
          paisaValue: row.paisa_value,
          expectedPaisa: row.real_value === null ? null : Math.round(row.real_value * 100),
        });
      }
    }
    return violations;
  }

  /** @internal */
  seedDefaultSettings(data: {
    factoryId: string;
    factoryName: string;
    workstation: string;
    deviceName: string;
    dbPath: string;
    backupFolder: string;
  }): void {
    const defaults: Record<string, string> = {
      "factory.name": data.factoryName,
      "factory.id": data.factoryId,
      "workstation.name": data.workstation,
      "device.name": data.deviceName,
      "database.path": data.dbPath,
      "backup.folder": data.backupFolder,
      "language": "en",
      "theme": "light",
      "sound.enabled": "true",
      "backup.auto.enabled": "true",
      "backup.auto.time": "02:00",
      "logging.level": "INFO",
      "sync.settings": "disabled-phase-2",
    };

    const now = new Date().toISOString();
    for (const [key, value] of Object.entries(defaults)) {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO app_settings (setting_key, setting_value, value_type, is_encrypted, updated_by, updated_at)
           VALUES (?, ?, 'string', 0, 'system', ?)`
        )
        .run(key, value, now);
    }
  }

  /** @internal */
  scalarCount(sql: string, args: Array<string | number>): number {
    const row = this.db.prepare(sql).get(...args) as { c: number };
    return Number(row?.c ?? 0);
  }


  /** @internal */
  scalarNumber(sql: string, args: Array<string | number>): number {
    const row = this.db.prepare(sql).get(...args) as Record<string, unknown>;
    const value = Object.values(row ?? {})[0];
    return Number(value ?? 0);
  }

  /** @internal */
  fileSha256(filePath: string): string {
    return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  }

}

// ─── Feature modules ─────────────────────────────────────────────────────────
// The database API is split by feature under ./database. Each module exports an object of
// methods written against `this: SqliteDatabase`; the interface merge below gives the class
// their signatures and Object.assign installs them on the prototype. Callers see one class
// with the same API as before — this is how a 7,600-line class became twelve readable files.
export interface SqliteDatabase
  extends ProductionMethods,
    ProductsMethods,
    QrCodesMethods,
    RawMaterialQrMethods,
    DispatchMethods,
    StoreMethods,
    GatepassMethods,
    UsersMethods,
    RawMaterialsMethods,
    MachineProgramsMethods,
    MachineProgramStockMethods,
    MachineProgramWritesMethods,
    MachineProgramStoreOutMethods,
    MachineProgramCartonsMethods,
    MachineProgramReconciliationMethods,
    MachineProgramDanaMethods,
    ProductClassificationMethods,
    MachineProgramRatesMethods,
    StockCorrectionsMethods,
    RemovalRequestsMethods,
    InventoryMovesMethods,
    ItemUnitLadderMethods,
    RawMaterialHandMoveMethods,
    InventoryImportMethods,
    PartiesMethods,
    SalesMethods,
    SaleReturnsMethods,
    CashMethods,
    PurchasesMethods,
    ContractorLedgerMethods,
    StoreDailyReportMethods,
    NumberRangeMethods,
    ProductVariantSeedMethods,
    MachineProgramUpperReconciliationMethods,
    PartyClaimsMethods,
    CartonProgramMethods,
    ProductionReceiptsMethods,
    UpperMoveOutMethods,
    ProductionReconciliationMethods,
    ManualProductionMethods {}

Object.assign(
  SqliteDatabase.prototype,
  productionMethods,
  productsMethods,
  qrCodesMethods,
  rawMaterialQrMethods,
  dispatchMethods,
  storeMethods,
  gatepassMethods,
  usersMethods,
  rawMaterialsMethods,
  machineProgramsMethods,
  machineProgramStockMethods,
  machineProgramWritesMethods,
  machineProgramStoreOutMethods,
  machineProgramCartonsMethods,
  machineProgramReconciliationMethods,
  machineProgramDanaMethods,
  productClassificationMethods,
  machineProgramRatesMethods,
  stockCorrectionsMethods,
  removalRequestsMethods,
  inventoryMovesMethods,
  itemUnitLadderMethods,
  rawMaterialHandMoveMethods,
  inventoryImportMethods,
  partiesMethods,
  salesMethods,
  saleReturnsMethods,
  cashMethods,
  purchasesMethods,
  contractorLedgerMethods,
  storeDailyReportMethods,
  numberRangeMethods,
  productVariantSeedMethods,
  machineProgramUpperReconciliationMethods,
  partyClaimsMethods,
  cartonProgramMethods,
  productionReceiptsMethods,
  upperMoveOutMethods,
  productionReconciliationMethods,
  manualProductionMethods
);
