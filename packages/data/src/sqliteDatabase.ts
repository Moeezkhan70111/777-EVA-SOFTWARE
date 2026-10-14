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
import { machineProgramUpperReconciliationMethods, type MachineProgramUpperReconciliationMethods } from "./database/machineProgramUpperReconciliation.js";
import { partyClaimsMethods, type PartyClaimsMethods } from "./database/partyClaims.js";
import { cartonProgramMethods, type CartonProgramMethods } from "./database/cartonProgram.js";
import { productionReceiptsMethods, type ProductionReceiptsMethods } from "./database/productionReceipts.js";
import { upperMoveOutMethods, type UpperMoveOutMethods } from "./database/upperMoveOut.js";
import type { BackupRecord, HealthSnapshot, MoneyDriftSummary, MoneyDriftViolation, SqliteDatabaseOptions } from "./database/types.js";

// The data layer's public record shapes and constants live in ./database/types.ts and are
// re-exported here so `@erp/data` keeps one import surface.
export * from "./database/types.js";
export { orderBy } from "./database/shared.js";
export type { MutableTransactionContext } from "./database/shared.js";
export type { ContractorLedgerAccount, ContractorLedgerReport } from "./database/contractorLedger.js";

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

  constructor(private readonly options: SqliteDatabaseOptions) {
    this.dbPath = options.dbPath;
    this.schemaPath = options.schemaPath ?? path.resolve(process.cwd(), "packages/data/src/local-schema.sql");
    // Repository layout by default (migrations/ sits three levels above the schema); the desktop
    // app overrides both so a packaged installation reads them from its resources folder.
    this.migrationsDir = options.migrationsDir ?? path.resolve(path.dirname(this.schemaPath), "../../..", "migrations", "sqlite");
    this.db = new DatabaseSync(this.dbPath);
    try {
      this.bootConnection();
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

  private bootConnection(): void {
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(this.readSchema());
    this.runMigrations();
    this.ensureSchemaCompatibility();
    this.ensureDefaultRoles();
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

    const applied = new Set(
      (this.db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: string }>).map((row) => row.version)
    );
    const migrations = fs.readdirSync(migrationsDir)
      .filter((file) => file.endsWith(".up.sql"))
      .sort();

    const pending = migrations.filter((file) => !applied.has(file.replace(/\.up\.sql$/, "")));
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

  restoreBackup(backupPath: string): void {
    if (!fs.existsSync(backupPath)) {
      throw new Error("Backup file does not exist.");
    }

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
    MachineProgramUpperReconciliationMethods,
    PartyClaimsMethods,
    CartonProgramMethods,
    ProductionReceiptsMethods,
    UpperMoveOutMethods {}

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
  machineProgramUpperReconciliationMethods,
  partyClaimsMethods,
  cartonProgramMethods,
  productionReceiptsMethods,
  upperMoveOutMethods
);
