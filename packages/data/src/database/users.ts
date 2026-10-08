// Users, sessions, roles, permissions, access requests, notifications and workspace.
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").
// `this` is the database instance; bodies are unchanged from the original class.

import type { SqliteDatabase } from "../sqliteDatabase.js";
import type { TransactionContext } from "@erp/application";
import type { MutableTransactionContext } from "./shared.js";
import type { UserNotificationRecord } from "./types.js";
import { pbkdf2Sync, randomBytes } from "node:crypto";

export const usersMethods = {
  hashPassword(this: SqliteDatabase, password: string): { hash: string; salt: string } {
    const salt = randomBytes(16);
    const hash = pbkdf2Sync(password, salt, 120000, 64, "sha512").toString("hex");
    return { hash, salt: salt.toString("hex") };
  },

  verifyPassword(this: SqliteDatabase, password: string, passwordHash: string, saltHex: string): boolean {
    const salt = Buffer.from(saltHex, "hex");
    const candidate = pbkdf2Sync(password, salt, 120000, 64, "sha512").toString("hex");
    return candidate === passwordHash;
  },

  /** True once any ADMIN account exists — used to decide whether first-run setup is required. */
  hasAnyAdmin(this: SqliteDatabase): boolean {
    const row = this.db.prepare("SELECT 1 as ok FROM app_users WHERE role = 'ADMIN' LIMIT 1").get() as { ok?: number } | undefined;
    return Boolean(row);
  },

  /**
   * Creates the very first ADMIN account directly (no PENDING approval step — there is no
   * admin yet to approve one). The "no ADMIN exists" check and the insert happen inside the
   * same transaction, so no sequence of calls can ever produce two bootstrapped admins: the
   * first to reach the check inside the transaction wins, every later call (concurrent or not)
   * finds an ADMIN already there and is rejected. This is now the only way to create an ADMIN
   * without an existing admin approving the request — the legacy hard-coded bootstrap credential
   * that used to serve this purpose has been removed.
   */
  bootstrapFirstAdmin(this: SqliteDatabase, username: string, password: string): { id: string; username: string } {
    const normalized = username.trim();
    if (!normalized) {
      throw new Error("Username is required");
    }
    if (normalized.length < 3) {
      throw new Error("Username must be at least 3 characters");
    }
    if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
      throw new Error("Password must be at least 8 characters and include a number");
    }

    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      const existingAdmin = this.db.prepare("SELECT 1 as ok FROM app_users WHERE role = 'ADMIN' LIMIT 1").get() as { ok?: number } | undefined;
      if (existingAdmin) {
        throw new Error("An administrator account already exists");
      }

      const existingUsername = this.db.prepare("SELECT id FROM app_users WHERE LOWER(username) = LOWER(?)").get(normalized) as { id?: string } | undefined;
      if (existingUsername) {
        throw new Error("Username already exists");
      }

      const now = new Date().toISOString();
      const userId = crypto.randomUUID();
      const { hash, salt } = this.hashPassword(password);
      this.db
        .prepare(
          `INSERT INTO app_users (id, username, password_hash, password_salt, role, access_status, permissions_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'ADMIN', 'APPROVED', '[]', ?, ?)`
        )
        .run(userId, normalized, hash, salt, now, now);

      this.db.exec("COMMIT");
      this.persistEffectivePermissions(userId);
      return { id: userId, username: normalized };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  },

  normalizePermissionCode(this: SqliteDatabase, raw: string): string {
    const aliasMap: Record<string, string> = {
      "dashboard": "dashboard",
      "workspace": "workspace",
      "live production": "live-production",
      "daily production": "daily-production",
      "live dispatch": "live-dispatch",
      "dispatch history": "dispatch-history",
      "return scan": "live-return",
      "return history": "return-history",
      "store scanning": "store-scanning",
      "store receiving": "store-scanning",
      "gatepass": "gatepass",
      "gate pass": "gatepass",
      "cancel gatepass": "gatepass-cancel",
      "current stock": "stock",
      "stock history": "production-history",
      "party list": "party-list",
      "add / edit party": "party-form",
      "product list": "product-list",
      "add / edit product": "product-form",
      "discount policy": "discount-policy",
      // The QR Generator was called the Barcode Generator until the carton label became a QR
      // code. migrations/sqlite/045_qr_registry_rename rewrites the stored grants, but a code
      // cached anywhere it did not reach must still open the page rather than silently fail.
      "barcode-generator": "qr-generator",
      "qr generator": "qr-generator",
      "customer ledger": "customer-ledger",
      "customer balance": "customer-balance",
      "sale vouchers": "sale-voucher-form",
      "voucher list": "sale-voucher-list",
      "cash voucher": "cash-voucher-form",
      "cash voucher list": "cash-voucher-list",
      "settings": "settings",
      "health": "health",
      "logs": "logs",
      "inventory": "stock",
      "masters": "product-list",
      "billing": "sale-voucher-form",
      "scanning": "live-production",
    };

    const normalized = String(raw ?? "").trim();
    if (!normalized) return "";
    const direct = aliasMap[normalized.toLowerCase()];
    if (direct) return direct;
    return normalized.toLowerCase().replace(/\s+/g, "-");
  },

  recalculateEffectivePermissions(this: SqliteDatabase, userId: string): string[] {
    const userRow = this.db.prepare("SELECT role, permissions_json FROM app_users WHERE id = ?").get(userId) as { role?: string; permissions_json?: string } | undefined;
    const directPermissions = new Set<string>();

    const roleRows = this.db
      .prepare(
        `SELECT rp.permission_code
         FROM user_role_assignments ura
         JOIN role_permissions rp ON rp.role_code = ura.role_code
         WHERE ura.user_id = ?`
      )
      .all(userId) as Array<{ permission_code: string }>;

    for (const row of roleRows) {
      const permission = this.normalizePermissionCode(row.permission_code);
      if (permission) directPermissions.add(permission);
    }

    const extraRows = this.db.prepare("SELECT permission_code FROM user_additional_permissions WHERE user_id = ?").all(userId) as Array<{ permission_code: string }>;
    for (const row of extraRows) {
      const permission = this.normalizePermissionCode(row.permission_code);
      if (permission) directPermissions.add(permission);
    }

    // permissions_json is where this method's own result is cached (persistEffectivePermissions).
    // Folding it back in for a user who has a role would make every permission permanent:
    // unchecking one on the role would be re-added from the cache on the very next recalculation.
    // So it is read only for accounts that predate roles and have no role assignment — for
    // everyone else the role plus the additional grants are the whole answer.
    const hasRole = this.db.prepare("SELECT 1 FROM user_role_assignments WHERE user_id = ? LIMIT 1").get(userId) !== undefined;
    try {
      const legacyPermissions = hasRole ? [] : (JSON.parse(userRow?.permissions_json ?? "[]") as string[]);
      for (const permission of legacyPermissions) {
        const normalized = this.normalizePermissionCode(permission);
        if (normalized) directPermissions.add(normalized);
      }
    } catch {
      // Ignore invalid legacy JSON.
    }

    if (userRow?.role === "ADMIN") {
      [
        "dashboard",
        "workspace",
        "live-production",
        "daily-production",
        "live-dispatch",
        "dispatch-history",
        "live-return",
        "return-history",
        "store-scanning",
        "gatepass",
        "gatepass-cancel",
        "stock",
        "production-history",
        "party-list",
        "party-form",
        "product-list",
        "product-form",
        "discount-policy",
        "qr-generator",
        "customer-ledger",
        "customer-balance",
        "sale-voucher-form",
        "sale-voucher-list",
        "cash-voucher-form",
        "cash-voucher-list",
        "settings",
        "health",
        "logs",
      ].forEach((permission) => directPermissions.add(permission));
    }

    return Array.from(directPermissions);
  },

  persistEffectivePermissions(this: SqliteDatabase, userId: string): void {
    const permissions = this.recalculateEffectivePermissions(userId);
    this.db.prepare("UPDATE app_users SET permissions_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(permissions), new Date().toISOString(), userId);
  },

  createRole(this: SqliteDatabase, input: { name: string; description?: string; permissions?: string[]; loginPolicy?: "ALWAYS_LOGGED_IN" | "DAILY_LOGIN" }): { code: string; name: string; description: string | null; permissions: string[]; loginPolicy: "ALWAYS_LOGGED_IN" | "DAILY_LOGIN" } {
    const name = input.name?.trim();
    if (!name) throw new Error("Role name is required");

    const code = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || `role-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const loginPolicy = input.loginPolicy === "DAILY_LOGIN" ? "DAILY_LOGIN" : "ALWAYS_LOGGED_IN";
    this.db.prepare(
      "INSERT INTO roles (role_code, role_name, description, login_policy, is_system_role, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)"
    ).run(code, name, input.description?.trim() || null, loginPolicy, now, now);

    const permissions = Array.from(new Set((input.permissions ?? []).map((permission) => this.normalizePermissionCode(permission)).filter(Boolean)));
    for (const permission of permissions) {
      this.db.prepare("INSERT OR IGNORE INTO role_permissions (role_code, permission_code, created_at) VALUES (?, ?, ?)").run(code, permission, now);
    }

    return { code, name, description: input.description?.trim() || null, permissions, loginPolicy };
  },

  listRoles(this: SqliteDatabase): Array<{ code: string; name: string; description: string | null; permissions: string[]; memberCount: number; loginPolicy: "ALWAYS_LOGGED_IN" | "DAILY_LOGIN" }> {
    const rows = this.db.prepare("SELECT role_code, role_name, description, COALESCE(login_policy, 'ALWAYS_LOGGED_IN') as login_policy FROM roles ORDER BY role_name COLLATE NOCASE").all() as Array<{ role_code: string; role_name: string; description: string | null; login_policy: string }>;
    return rows.map((row) => {
      const permissions = (this.db.prepare("SELECT permission_code FROM role_permissions WHERE role_code = ? ORDER BY permission_code COLLATE NOCASE").all(row.role_code) as Array<{ permission_code: string }>).map((entry) => entry.permission_code);
      const memberCountRow = this.db.prepare("SELECT COUNT(*) as count FROM user_role_assignments WHERE role_code = ?").get(row.role_code) as { count: number } | undefined;
      const memberCount = Number(memberCountRow?.count ?? 0);
      const loginPolicy = row.login_policy === "DAILY_LOGIN" ? "DAILY_LOGIN" : "ALWAYS_LOGGED_IN";
      return { code: row.role_code, name: row.role_name, description: row.description, permissions, memberCount, loginPolicy };
    });
  },

  updateRole(this: SqliteDatabase, roleCode: string, updates: { name?: string; description?: string; permissions?: string[]; loginPolicy?: "ALWAYS_LOGGED_IN" | "DAILY_LOGIN" }): { code: string; name: string; description: string | null; permissions: string[]; loginPolicy: "ALWAYS_LOGGED_IN" | "DAILY_LOGIN" } {
    const existing = this.db.prepare("SELECT role_code, role_name, description, COALESCE(login_policy, 'ALWAYS_LOGGED_IN') as login_policy FROM roles WHERE role_code = ?").get(roleCode) as { role_code?: string; role_name?: string; description?: string | null; login_policy?: string } | undefined;
    if (!existing) throw new Error("Role not found");

    const name = typeof updates.name === "string" ? updates.name.trim() : existing.role_name;
    if (!name) throw new Error("Role name is required");

    const description = updates.description === undefined ? existing.description ?? null : updates.description.trim() || null;
    const loginPolicy = updates.loginPolicy !== undefined ? (updates.loginPolicy === "DAILY_LOGIN" ? "DAILY_LOGIN" : "ALWAYS_LOGGED_IN") : (existing.login_policy === "DAILY_LOGIN" ? "DAILY_LOGIN" : "ALWAYS_LOGGED_IN");
    const now = new Date().toISOString();

    this.db.prepare("UPDATE roles SET role_name = ?, description = ?, login_policy = ?, updated_at = ? WHERE role_code = ?").run(name, description, loginPolicy, now, roleCode);

    if (updates.permissions !== undefined) {
      this.updateRolePermissions(roleCode, updates.permissions);
    }

    const updated = this.listRoles().find((role) => role.code === roleCode);
    if (!updated) throw new Error("Role not found after update");
    return updated;
  },

  updateRolePermissions(this: SqliteDatabase, roleCode: string, permissions: string[]): void {
    const role = this.db.prepare("SELECT role_code FROM roles WHERE role_code = ?").get(roleCode) as { role_code?: string } | undefined;
    if (!role) throw new Error("Role not found");

    const normalized = Array.from(new Set((permissions ?? []).map((permission) => this.normalizePermissionCode(permission)).filter(Boolean)));
    const now = new Date().toISOString();
    this.db.prepare("DELETE FROM role_permissions WHERE role_code = ?").run(roleCode);
    for (const permission of normalized) {
      this.db.prepare("INSERT INTO role_permissions (role_code, permission_code, created_at) VALUES (?, ?, ?)").run(roleCode, permission, now);
    }
    this.db.prepare("UPDATE roles SET updated_at = ? WHERE role_code = ?").run(now, roleCode);

    const assignedUsers = this.db.prepare("SELECT user_id FROM user_role_assignments WHERE role_code = ?").all(roleCode) as Array<{ user_id: string }>;
    for (const user of assignedUsers) {
      this.persistEffectivePermissions(user.user_id);
    }
  },

  deleteRole(this: SqliteDatabase, roleCode: string): void {
    const existing = this.db.prepare("SELECT 1 as ok FROM user_role_assignments WHERE role_code = ? LIMIT 1").get(roleCode) as { ok?: number } | undefined;
    if (existing) throw new Error("Role is in use and cannot be deleted");
    this.db.prepare("DELETE FROM role_permissions WHERE role_code = ?").run(roleCode);
    this.db.prepare("DELETE FROM roles WHERE role_code = ?").run(roleCode);
  },

  assignUserRole(this: SqliteDatabase, userId: string, roleCode: string, assignedBy?: string): void {
    const user = this.db.prepare("SELECT id FROM app_users WHERE id = ?").get(userId) as { id?: string } | undefined;
    if (!user) throw new Error("User not found");
    const role = this.db.prepare("SELECT role_code FROM roles WHERE role_code = ?").get(roleCode) as { role_code?: string } | undefined;
    if (!role) throw new Error("Role not found");

    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO user_role_assignments (user_id, role_code, assigned_by, assigned_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET role_code = excluded.role_code, assigned_by = excluded.assigned_by, assigned_at = excluded.assigned_at, updated_at = excluded.updated_at`
    ).run(userId, roleCode, assignedBy ?? null, now, now);
    this.persistEffectivePermissions(userId);
  },

  setUserAdditionalPermissions(this: SqliteDatabase, userId: string, permissions: string[]): void {
    const user = this.db.prepare("SELECT id FROM app_users WHERE id = ?").get(userId) as { id?: string } | undefined;
    if (!user) throw new Error("User not found");

    const normalized = Array.from(new Set((permissions ?? []).map((permission) => this.normalizePermissionCode(permission)).filter(Boolean)));
    const now = new Date().toISOString();
    this.db.prepare("DELETE FROM user_additional_permissions WHERE user_id = ?").run(userId);
    for (const permission of normalized) {
      this.db.prepare("INSERT INTO user_additional_permissions (user_id, permission_code, granted_at) VALUES (?, ?, ?)").run(userId, permission, now);
    }
    this.persistEffectivePermissions(userId);
  },

  createUserAccount(this: SqliteDatabase, username: string, password: string): { id: string; username: string; role: "USER" | "ADMIN"; accessStatus: "PENDING" | "APPROVED" | "REJECTED" } {
    const normalized = username.trim();
    if (!normalized) {
      throw new Error("Username is required");
    }

    if (normalized.length < 3) {
      throw new Error("Username must be at least 3 characters");
    }

    if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
      throw new Error("Password must be at least 8 characters and include a number");
    }

    const existing = this.db
      .prepare("SELECT id FROM app_users WHERE LOWER(username) = LOWER(?)")
      .get(normalized) as { id?: string } | undefined;

    if (existing) {
      throw new Error("Username already exists");
    }

    const now = new Date().toISOString();
    const userId = crypto.randomUUID();
    const { hash, salt } = this.hashPassword(password);

    // Every self-registered account starts as a pending USER — the only way to become ADMIN
    // without an existing admin's approval is the first-run bootstrapFirstAdmin() path.
    this.db
      .prepare(
        `INSERT INTO app_users (id, username, password_hash, password_salt, role, access_status, permissions_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'USER', 'PENDING', '[]', ?, ?)`
      )
      .run(userId, normalized, hash, salt, now, now);

    return { id: userId, username: normalized, role: "USER", accessStatus: "PENDING" };
  },

  authenticateUser(this: SqliteDatabase, username: string, password: string): { id: string; username: string; role: "USER" | "ADMIN"; accessStatus: "PENDING" | "APPROVED" | "REJECTED" } | null {
    const normalized = username.trim();
    if (!normalized) return null;

    const row = this.db
      .prepare(
        `SELECT id, username, password_hash, password_salt, role, access_status
         FROM app_users
         WHERE LOWER(username) = LOWER(?)`
      )
      .get(normalized) as { id: string; username: string; password_hash: string; password_salt: string; role: "USER" | "ADMIN"; access_status: "PENDING" | "APPROVED" | "REJECTED" } | undefined;

    if (!row) return null;
    if (!this.verifyPassword(password, row.password_hash, row.password_salt)) return null;

    const now = new Date().toISOString();
    this.db.prepare("UPDATE app_users SET last_login_at = ?, updated_at = ? WHERE id = ?").run(now, now, row.id);

    return { id: row.id, username: row.username, role: row.role, accessStatus: row.access_status };
  },

  createUserSession(this: SqliteDatabase, userId: string): string {
    const token = crypto.randomUUID();
    const now = new Date().toISOString();
    const sessionId = crypto.randomUUID();

    this.db
      .prepare(
          `INSERT INTO user_sessions (id, user_id, token, created_at, last_seen_at, revoked_at, expires_at, login_date)
          VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`
      )
        .run(sessionId, userId, token, now, now, now.slice(0, 10));

    return token;
  },

  getUserBySessionToken(this: SqliteDatabase, token: string): { id: string; username: string; role: "USER" | "ADMIN"; accessStatus: "PENDING" | "APPROVED" | "REJECTED"; permissions: string[]; lastLoginAt: string | null; roleNotification: string | null } | null {
    const row = this.db
      .prepare(
        `SELECT u.id, u.username, u.role, u.access_status, u.permissions_json, u.last_login_at, u.role_notification,
                r.login_policy, s.login_date
         FROM user_sessions s
         JOIN app_users u ON u.id = s.user_id
         LEFT JOIN user_role_assignments ura ON ura.user_id = u.id
         LEFT JOIN roles r ON r.role_code = ura.role_code
         WHERE s.token = ? AND s.revoked_at IS NULL`
      )
      .get(token) as {
        id: string;
        username: string;
        role: "USER" | "ADMIN";
        access_status: "PENDING" | "APPROVED" | "REJECTED";
        permissions_json: string;
        last_login_at: string | null;
        role_notification: string | null;
        login_policy?: string | null;
        login_date?: string | null;
      } | undefined;

    if (!row) return null;

    const today = new Date().toISOString().slice(0, 10);
    const requiresDailyLogin = row.role !== "ADMIN" && row.login_policy === "DAILY_LOGIN";
    if (requiresDailyLogin && row.login_date && row.login_date !== today) {
      return null;
    }

    this.db
      .prepare("UPDATE user_sessions SET last_seen_at = ? WHERE token = ?")
      .run(new Date().toISOString(), token);

    this.persistEffectivePermissions(row.id);
    const permissions = this.recalculateEffectivePermissions(row.id);
    this.db.prepare("UPDATE app_users SET role_notification = NULL WHERE id = ?").run(row.id);
    return { id: row.id, username: row.username, role: row.role, accessStatus: row.access_status, permissions, lastLoginAt: row.last_login_at, roleNotification: row.role_notification };
  },

  createAccessRequest(this: SqliteDatabase, userId: string): { status: "PENDING" | "APPROVED" | "REJECTED" } {
    const user = this.db.prepare("SELECT access_status FROM app_users WHERE id = ?").get(userId) as { access_status?: string } | undefined;
    if (!user) throw new Error("User not found");
    if (user.access_status === "APPROVED") return { status: "APPROVED" };

    const existing = this.db.prepare("SELECT status FROM access_requests WHERE user_id = ?").get(userId) as { status?: "PENDING" | "APPROVED" | "REJECTED" } | undefined;
    if (existing?.status === "PENDING") return { status: "PENDING" };

    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO access_requests (id, user_id, status, requested_at) VALUES (?, ?, 'PENDING', ?)
      ON CONFLICT(user_id) DO UPDATE SET status = 'PENDING', requested_at = excluded.requested_at, reviewed_at = NULL, reviewed_by = NULL`)
      .run(crypto.randomUUID(), userId, now);
    this.db.prepare("UPDATE app_users SET access_status = 'PENDING', updated_at = ? WHERE id = ?").run(now, userId);
    return { status: "PENDING" };
  },

  getAccessRequestForUser(this: SqliteDatabase, userId: string): { status: "PENDING" | "APPROVED" | "REJECTED" } | null {
    const row = this.db.prepare("SELECT status FROM access_requests WHERE user_id = ?").get(userId) as { status?: "PENDING" | "APPROVED" | "REJECTED" } | undefined;
    return row?.status ? { status: row.status } : null;
  },

  getAccessRequests(this: SqliteDatabase): Array<{ id: string; username: string; status: "PENDING" | "APPROVED" | "REJECTED"; requestedAt: string; reviewedAt: string | null }> {
    const rows = this.db.prepare(`SELECT r.id, u.username, r.status, r.requested_at, r.reviewed_at
      FROM access_requests r JOIN app_users u ON u.id = r.user_id ORDER BY r.requested_at DESC`).all() as Array<{ id: string; username: string; status: "PENDING" | "APPROVED" | "REJECTED"; requested_at: string; reviewed_at: string | null }>;
    return rows.map((row) => ({ id: row.id, username: row.username, status: row.status, requestedAt: row.requested_at, reviewedAt: row.reviewed_at }));
  },

  reviewAccessRequest(this: SqliteDatabase, requestId: string, reviewerId: string, decision: "APPROVED" | "REJECTED", permissions: string[] = [], roleCode?: string): void {
    const admin = this.db.prepare("SELECT role FROM app_users WHERE id = ?").get(reviewerId) as { role?: string } | undefined;
    if (admin?.role !== "ADMIN") throw new Error("Administrator access required");
    const request = this.db.prepare("SELECT user_id FROM access_requests WHERE id = ?").get(requestId) as { user_id?: string } | undefined;
    if (!request?.user_id) throw new Error("Access request not found");
    const now = new Date().toISOString();

    if (decision === "APPROVED") {
      if (typeof roleCode === "string" && roleCode.trim()) {
        this.assignUserRole(request.user_id, roleCode.trim(), reviewerId);
      }

      const normalizedPermissions = Array.from(new Set((permissions ?? []).map((permission) => this.normalizePermissionCode(permission)).filter(Boolean)));
      if (normalizedPermissions.length > 0) {
        this.setUserAdditionalPermissions(request.user_id, normalizedPermissions);
      }
    } else {
      this.setUserAdditionalPermissions(request.user_id, []);
    }

    this.db.prepare("UPDATE access_requests SET status = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ?").run(decision, now, reviewerId, requestId);
    this.db.prepare("UPDATE app_users SET access_status = ?, updated_at = ? WHERE id = ?").run(decision, now, request.user_id);
  },

  listMembers(this: SqliteDatabase): Array<{ id: string; username: string; role: "USER" | "ADMIN"; jobRole: string; authorityLevel: number; accessStatus: "PENDING" | "APPROVED" | "REJECTED"; permissions: string[]; lastLoginAt: string | null; accessRequestId: string | null; roleCode: string | null; roleName: string | null; additionalPermissions: string[] }> {
    const rows = this.db.prepare("SELECT u.id, u.username, u.role, u.job_role, u.authority_level, u.access_status, u.permissions_json, u.last_login_at, r.id AS access_request_id, ura.role_code FROM app_users u LEFT JOIN access_requests r ON r.user_id = u.id LEFT JOIN user_role_assignments ura ON ura.user_id = u.id ORDER BY u.username COLLATE NOCASE").all() as Array<{ id: string; username: string; role: "USER" | "ADMIN"; job_role: string; authority_level: number; access_status: "PENDING" | "APPROVED" | "REJECTED"; permissions_json: string; last_login_at: string | null; access_request_id: string | null; role_code: string | null }>;
    return rows.map((row) => {
      const roleRow = row.role_code ? this.db.prepare("SELECT role_name FROM roles WHERE role_code = ?").get(row.role_code) as { role_name?: string } | undefined : undefined;
      const roleName = roleRow?.role_name ?? null;
      const displayJobRole = roleName ?? row.job_role;
      const effectivePermissions = this.recalculateEffectivePermissions(row.id);
      const additionalPermissions = this.getUserAdditionalPermissions(row.id);
      return { id: row.id, username: row.username, role: row.role, jobRole: displayJobRole, authorityLevel: row.role === "ADMIN" ? 100 : row.authority_level, accessStatus: row.access_status, permissions: effectivePermissions, lastLoginAt: row.last_login_at, accessRequestId: row.access_request_id, roleCode: row.role_code, roleName, additionalPermissions };
    });
  },

  getUserAdditionalPermissions(this: SqliteDatabase, userId: string): string[] {
    const rows = this.db.prepare("SELECT permission_code FROM user_additional_permissions WHERE user_id = ? ORDER BY permission_code").all(userId) as Array<{ permission_code: string }>;
    return rows.map((row) => row.permission_code);
  },

  createPermissionRequest(this: SqliteDatabase, userId: string, permissionCode: string, reason?: string): { id: string; permissionCode: string; status: "PENDING" | "APPROVED" | "REJECTED" } {
    const user = this.db.prepare("SELECT id, access_status FROM app_users WHERE id = ?").get(userId) as { id?: string; access_status?: string } | undefined;
    if (!user) throw new Error("User not found");
    if (user.access_status !== "APPROVED") throw new Error("Only approved users may request additional permissions");
    const normalized = this.normalizePermissionCode(permissionCode);
    if (!normalized) throw new Error("A valid permission is required");
    const existing = this.db.prepare("SELECT id, status FROM permission_requests WHERE user_id = ? AND permission_code = ? AND status = 'PENDING'").get(userId, normalized) as { id?: string; status?: string } | undefined;
    if (existing) return { id: existing.id!, permissionCode: normalized, status: "PENDING" };
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    this.db.prepare("INSERT INTO permission_requests (id, user_id, permission_code, reason, status, requested_at) VALUES (?, ?, ?, ?, 'PENDING', ?)").run(id, userId, normalized, typeof reason === "string" ? reason.trim() || null : null, now);
    const adminId = this.getAdministratorId();
    if (adminId) {
      this.db.prepare("INSERT INTO user_notifications (id, user_id, title, message, created_at) VALUES (?, ?, ?, ?, ?)").run(crypto.randomUUID(), adminId, "Permission request", `${userId} requested permission "${normalized}"`, now);
    }
    return { id, permissionCode: normalized, status: "PENDING" };
  },

  getPermissionRequests(this: SqliteDatabase): Array<{ id: string; userId: string; username: string; permissionCode: string; reason: string | null; status: "PENDING" | "APPROVED" | "REJECTED"; createdAt: string; requestedAt: string; reviewedAt: string | null; reviewedBy: string | null; reviewNotes: string | null }> {
    const rows = this.db.prepare(`SELECT p.id, p.user_id, u.username, p.permission_code, p.reason, p.status, p.requested_at, p.reviewed_at, p.reviewed_by, p.review_notes
      FROM permission_requests p JOIN app_users u ON u.id = p.user_id ORDER BY p.status = 'PENDING' DESC, p.requested_at DESC`).all() as Array<{ id: string; user_id: string; username: string; permission_code: string; reason: string | null; status: "PENDING" | "APPROVED" | "REJECTED"; requested_at: string; reviewed_at: string | null; reviewed_by: string | null; review_notes: string | null }>;
    return rows.map((row) => ({ id: row.id, userId: row.user_id, username: row.username, permissionCode: row.permission_code, reason: row.reason, status: row.status, createdAt: row.requested_at, requestedAt: row.requested_at, reviewedAt: row.reviewed_at, reviewedBy: row.reviewed_by, reviewNotes: row.review_notes }));
  },

  getMyPermissionRequests(this: SqliteDatabase, userId: string): Array<{ id: string; permissionCode: string; reason: string | null; status: "PENDING" | "APPROVED" | "REJECTED"; createdAt: string; requestedAt: string; reviewedAt: string | null; reviewNotes: string | null }> {
    const rows = this.db.prepare("SELECT id, permission_code, reason, status, requested_at, reviewed_at, review_notes FROM permission_requests WHERE user_id = ? ORDER BY requested_at DESC").all(userId) as Array<{ id: string; permission_code: string; reason: string | null; status: "PENDING" | "APPROVED" | "REJECTED"; requested_at: string; reviewed_at: string | null; review_notes: string | null }>;
    return rows.map((row) => ({ id: row.id, permissionCode: row.permission_code, reason: row.reason, status: row.status, createdAt: row.requested_at, requestedAt: row.requested_at, reviewedAt: row.reviewed_at, reviewNotes: row.review_notes }));
  },

  reviewPermissionRequest(this: SqliteDatabase, requestId: string, reviewerId: string, decision: "APPROVED" | "REJECTED", reviewNotes?: string): { permissionCode: string; userId: string; status: "APPROVED" | "REJECTED" } {
    const admin = this.db.prepare("SELECT role FROM app_users WHERE id = ?").get(reviewerId) as { role?: string } | undefined;
    if (admin?.role !== "ADMIN") throw new Error("Administrator access required");
    const request = this.db.prepare("SELECT id, user_id, permission_code, status FROM permission_requests WHERE id = ?").get(requestId) as { id?: string; user_id?: string; permission_code?: string; status?: string } | undefined;
    if (!request?.id || request.status !== "PENDING") throw new Error("Pending permission request not found");
    const userId = request.user_id!;
    const permissionCode = request.permission_code!;
    const now = new Date().toISOString();
    if (decision === "APPROVED") {
      const existing = this.db.prepare("SELECT permission_code FROM user_additional_permissions WHERE user_id = ? AND permission_code = ?").get(userId, permissionCode);
      if (!existing) {
        this.db.prepare("INSERT INTO user_additional_permissions (user_id, permission_code, granted_by, granted_at) VALUES (?, ?, ?, ?)").run(userId, permissionCode, reviewerId, now);
      }
      this.persistEffectivePermissions(userId);
    }
    this.db.prepare("UPDATE permission_requests SET status = ?, reviewed_at = ?, reviewed_by = ?, review_notes = ? WHERE id = ?").run(decision, now, reviewerId, typeof reviewNotes === "string" ? reviewNotes.trim() || null : null, requestId);
    const notifTitle = decision === "APPROVED" ? "Permission granted" : "Permission request declined";
    const notifMessage = decision === "APPROVED" ? `Your request for "${permissionCode}" was approved.` : `Your request for "${permissionCode}" was declined.`;
    this.db.prepare("INSERT INTO user_notifications (id, user_id, title, message, created_at) VALUES (?, ?, ?, ?, ?)").run(crypto.randomUUID(), userId, notifTitle, notifMessage, now);
    return { permissionCode, userId, status: decision };
  },

  updateMemberJobRole(this: SqliteDatabase, userId: string, reviewerId: string, jobRole: string): void {
    const admin = this.db.prepare("SELECT role FROM app_users WHERE id = ?").get(reviewerId) as { role?: string } | undefined;
    if (admin?.role !== "ADMIN") throw new Error("Administrator access required");
    const normalizedRole = jobRole.trim();
    const notification = normalizedRole ? `You are now ${normalizedRole}` : "Your member role has been cleared";
    const now = new Date().toISOString();
    this.db.prepare("UPDATE app_users SET job_role = ?, role_notification = ?, updated_at = ? WHERE id = ? AND role <> 'ADMIN'").run(normalizedRole, notification, now, userId);
    if (normalizedRole) this.db.prepare("INSERT OR IGNORE INTO job_role_options (name, created_at) VALUES (?, ?)").run(normalizedRole, now);
    this.db.prepare("INSERT INTO user_notifications (id, user_id, title, message, created_at) VALUES (?, ?, ?, ?, ?)").run(crypto.randomUUID(), userId, "Role updated", notification, now);
  },

  updateMemberAuthorityLevel(this: SqliteDatabase, userId: string, reviewerId: string, authorityLevel: number): void {
    const admin = this.db.prepare("SELECT role FROM app_users WHERE id = ?").get(reviewerId) as { role?: string } | undefined;
    if (admin?.role !== "ADMIN") throw new Error("Administrator access required");
    const level = Math.max(1, Math.min(99, Math.round(authorityLevel)));
    this.db.prepare("UPDATE app_users SET authority_level = ?, updated_at = ? WHERE id = ? AND role <> 'ADMIN'").run(level, new Date().toISOString(), userId);
  },

  getJobRoleOptions(this: SqliteDatabase): string[] {
    return (this.db.prepare("SELECT name FROM job_role_options ORDER BY name COLLATE NOCASE").all() as Array<{ name: string }>).map((row) => row.name);
  },

  listRoleOptions(this: SqliteDatabase): Array<{ code: string; name: string; description: string | null; permissions: string[]; memberCount: number }> {
    return this.listRoles();
  },

  getUserNotifications(this: SqliteDatabase, userId: string): UserNotificationRecord[] {
    const rows = this.db
      .prepare("SELECT id, title, message, created_at, read_at, kind, entity_id, severity FROM user_notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50")
      .all(userId) as Array<{ id: string; title: string; message: string; created_at: string; read_at: string | null; kind: string | null; entity_id: string | null; severity: string | null }>;
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      message: row.message,
      createdAt: row.created_at,
      readAt: row.read_at,
      kind: row.kind ? String(row.kind) : null,
      entityId: row.entity_id ? String(row.entity_id) : null,
      severity: row.severity === "CRITICAL" || row.severity === "WARNING" ? row.severity : "INFO",
    }));
  },

  /** Approved users whose effective permissions include `permissionCode`, plus every approved administrator. */
  listUserIdsWithPermission(this: SqliteDatabase, permissionCode: string): string[] {
    const wanted = this.normalizePermissionCode(permissionCode);
    const rows = this.db.prepare("SELECT id, role FROM app_users WHERE access_status = 'APPROVED'").all() as Array<{ id: string; role: string }>;
    return rows.filter((row) => row.role === "ADMIN" || this.recalculateEffectivePermissions(row.id).includes(wanted)).map((row) => row.id);
  },

  /**
   * One notification per user who holds the permission — written through the caller's
   * transaction when given, so a rolled-back document leaves no notice behind.
   */
  notifyUsersWithPermission(
    this: SqliteDatabase,
    permissionCode: string,
    notice: { kind: string; severity: string; entityId: string; title: string; message: string },
    tx?: TransactionContext
  ): number {
    const db = tx ? (tx as MutableTransactionContext).db : this.db;
    const now = tx?.nowIso ?? new Date().toISOString();
    const insert = db.prepare("INSERT INTO user_notifications (id, user_id, title, message, created_at, kind, entity_id, severity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    const recipients = this.listUserIdsWithPermission(permissionCode);
    for (const userId of recipients) insert.run(crypto.randomUUID(), userId, notice.title, notice.message, now, notice.kind, notice.entityId, notice.severity);
    return recipients.length;
  },

  markNotificationRead(this: SqliteDatabase, userId: string, notificationId: string): void {
    const result = this.db
      .prepare("UPDATE user_notifications SET read_at = ? WHERE id = ? AND user_id = ?")
      .run(new Date().toISOString(), notificationId, userId);

    if (Number(result.changes) === 0) {
      throw new Error("Notification not found");
    }
  },

  listWorkspaceUsers(this: SqliteDatabase): Array<{ id: string; username: string; jobRole: string; authorityLevel: number; isAdmin: boolean }> {
    const rows = this.db.prepare("SELECT id, username, job_role, authority_level, role FROM app_users WHERE access_status = 'APPROVED' ORDER BY username COLLATE NOCASE").all() as Array<{ id: string; username: string; job_role: string; authority_level: number; role: "USER" | "ADMIN" }>;
    return rows.map((row) => ({ id: row.id, username: row.username, jobRole: row.job_role, authorityLevel: row.role === "ADMIN" ? 100 : row.authority_level, isAdmin: row.role === "ADMIN" }));
  },

  listTaskAssignees(this: SqliteDatabase, userId: string): Array<{ id: string; username: string; jobRole: string }> {
    const actor = this.db.prepare("SELECT role, authority_level FROM app_users WHERE id = ? AND access_status = 'APPROVED'").get(userId) as { role?: string; authority_level?: number } | undefined;
    if (!actor || (actor.role !== "ADMIN" && Number(actor.authority_level ?? 0) <= 10)) return [];
    const level = actor.role === "ADMIN" ? 101 : Number(actor.authority_level ?? 0);
    return this.db.prepare("SELECT id, username, job_role AS jobRole FROM app_users WHERE access_status = 'APPROVED' AND role <> 'ADMIN' AND authority_level < ? ORDER BY username COLLATE NOCASE").all(level) as Array<{ id: string; username: string; jobRole: string }>;
  },

  getAdministratorId(this: SqliteDatabase): string | null {
    const row = this.db.prepare("SELECT id FROM app_users WHERE role = 'ADMIN' AND access_status = 'APPROVED' ORDER BY id LIMIT 1").get() as { id?: string } | undefined;
    return row?.id ?? null;
  },

  listWorkspaceTasks(this: SqliteDatabase, userId: string, assignedByMe = false): unknown[] {
    const column = assignedByMe ? "assigned_by" : "assigned_to";
    return this.db.prepare(`SELECT t.*, a.username AS assigned_to_name, b.username AS assigned_by_name FROM workspace_tasks t JOIN app_users a ON a.id=t.assigned_to JOIN app_users b ON b.id=t.assigned_by WHERE t.${column} = ? ORDER BY t.created_at DESC`).all(userId);
  },

  listWorkspaceRequests(this: SqliteDatabase, userId: string): unknown[] {
    return this.db.prepare("SELECT r.*, a.username AS assigned_to_name, b.username AS requested_by_name FROM workspace_requests r JOIN app_users a ON a.id=r.assigned_to JOIN app_users b ON b.id=r.requested_by WHERE r.assigned_to = ? OR r.requested_by = ? ORDER BY r.created_at DESC").all(userId, userId);
  },

  listWorkspaceActivity(this: SqliteDatabase): unknown[] {
    return this.db.prepare("SELECT x.*, u.username FROM workspace_activity x JOIN app_users u ON u.id=x.actor_id ORDER BY x.created_at DESC LIMIT 100").all();
  },

  createWorkspaceTask(this: SqliteDatabase, input: { title: string; description?: string; assignedTo: string; assignedBy: string; priority?: string; dueDate?: string; linkedEntityType?: string; linkedEntityId?: string }): string {
    const actor = this.db.prepare("SELECT role, authority_level FROM app_users WHERE id = ? AND access_status = 'APPROVED'").get(input.assignedBy) as { role?: string; authority_level?: number } | undefined;
    const target = this.db.prepare("SELECT role, authority_level FROM app_users WHERE id = ? AND access_status = 'APPROVED'").get(input.assignedTo) as { role?: string; authority_level?: number } | undefined;
    if (!actor || !target || (actor.role !== "ADMIN" && (actor.role !== "USER" || target.role === "ADMIN" || Number(target.authority_level ?? 0) >= Number(actor.authority_level ?? 0)))) throw new Error("You may assign tasks only to users below your authority");
    const id = crypto.randomUUID(); const now = new Date().toISOString();
    this.db.prepare("INSERT INTO workspace_tasks (id,title,description,assigned_to,assigned_by,priority,due_date,linked_entity_type,linked_entity_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(id, input.title.trim(), input.description?.trim() ?? "", input.assignedTo, input.assignedBy, input.priority ?? "NORMAL", input.dueDate ?? null, input.linkedEntityType ?? null, input.linkedEntityId ?? null, now, now);
    this.db.prepare("INSERT INTO user_notifications (id,user_id,title,message,created_at) VALUES (?,?,?,?,?)").run(crypto.randomUUID(), input.assignedTo, "New task assigned", input.title.trim(), now);
    this.db.prepare("INSERT INTO workspace_activity (id,actor_id,event_type,description,reference_type,reference_id,created_at) VALUES (?,?,?,?,?,?,?)").run(crypto.randomUUID(), input.assignedBy, "TASK_CREATED", `Assigned task: ${input.title.trim()}`, "TASK", id, now);
    return id;
  },

  createWorkspaceRequest(this: SqliteDatabase, input: { requestType: string; title: string; description?: string; requestedBy: string; assignedTo: string; priority?: string; dueDate?: string; linkedEntityType?: string; linkedEntityId?: string }): string {
    const id = crypto.randomUUID(); const now = new Date().toISOString();
    this.db.prepare("INSERT INTO workspace_requests (id,request_type,title,description,requested_by,assigned_to,priority,due_date,linked_entity_type,linked_entity_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(id, input.requestType, input.title.trim(), input.description?.trim() ?? "", input.requestedBy, input.assignedTo, input.priority ?? "NORMAL", input.dueDate ?? null, input.linkedEntityType ?? null, input.linkedEntityId ?? null, now, now);
    this.db.prepare("INSERT INTO user_notifications (id,user_id,title,message,created_at) VALUES (?,?,?,?,?)").run(crypto.randomUUID(), input.assignedTo, "New request", input.title.trim(), now);
    this.db.prepare("INSERT INTO workspace_activity (id,actor_id,event_type,description,reference_type,reference_id,created_at) VALUES (?,?,?,?,?,?,?)").run(crypto.randomUUID(), input.requestedBy, "REQUEST_CREATED", `Created request: ${input.title.trim()}`, "REQUEST", id, now);
    return id;
  },

  updateWorkspaceStatus(this: SqliteDatabase, kind: "TASK" | "REQUEST", id: string, userId: string, status: string): void {
    const table = kind === "TASK" ? "workspace_tasks" : "workspace_requests";
    const access = kind === "TASK" ? "assigned_to = ? OR assigned_by = ?" : "assigned_to = ? OR requested_by = ?";
    const result = this.db.prepare(`UPDATE ${table} SET status=?, updated_at=? WHERE id=? AND (${access})`).run(status, new Date().toISOString(), id, userId, userId);
    if (Number(result.changes) === 0) throw new Error("Workspace item not found or not authorized");
  },

  listWorkspaceMessages(this: SqliteDatabase, userId: string): unknown[] {
    return this.db.prepare("SELECT m.id, m.message, m.created_at, u.username AS sender_name FROM workspace_messages m JOIN workspace_conversation_members cm ON cm.conversation_id=m.conversation_id JOIN app_users u ON u.id=m.sender_id WHERE cm.user_id=? ORDER BY m.created_at DESC LIMIT 100").all(userId);
  },

  sendWorkspaceMessage(this: SqliteDatabase, senderId: string, recipientId: string, message: string): string {
    const now = new Date().toISOString(); const conversationId = crypto.randomUUID(); const messageId = crypto.randomUUID();
    this.db.prepare("INSERT INTO workspace_conversations (id,type,created_by,created_at,updated_at) VALUES (?,'DIRECT',?,?,?)").run(conversationId, senderId, now, now);
    this.db.prepare("INSERT INTO workspace_conversation_members (conversation_id,user_id,joined_at) VALUES (?,?,?), (?,?,?)").run(conversationId, senderId, now, conversationId, recipientId, now);
    this.db.prepare("INSERT INTO workspace_messages (id,conversation_id,sender_id,message,created_at) VALUES (?,?,?,?,?)").run(messageId, conversationId, senderId, message.trim(), now);
    this.db.prepare("INSERT INTO user_notifications (id,user_id,title,message,created_at) VALUES (?,?,?,?,?)").run(crypto.randomUUID(), recipientId, "New message", message.trim(), now);
    return messageId;
  },

  updateUserPermissions(this: SqliteDatabase, userId: string, reviewerId: string, permissions: string[]): void {
    const admin = this.db.prepare("SELECT role FROM app_users WHERE id = ?").get(reviewerId) as { role?: string } | undefined;
    if (admin?.role !== "ADMIN") throw new Error("Administrator access required");
    this.setUserAdditionalPermissions(userId, permissions);
  },

  revokeUserAccess(this: SqliteDatabase, userId: string, reviewerId: string): void {
    const admin = this.db.prepare("SELECT role FROM app_users WHERE id = ?").get(reviewerId) as { role?: string } | undefined;
    if (admin?.role !== "ADMIN") throw new Error("Administrator access required");
    this.db.prepare("UPDATE app_users SET access_status = 'REJECTED', updated_at = ? WHERE id = ? AND role <> 'ADMIN'").run(new Date().toISOString(), userId);
  },

  revokeSessionToken(this: SqliteDatabase, token: string): void {
    this.db
      .prepare("UPDATE user_sessions SET revoked_at = ? WHERE token = ?")
      .run(new Date().toISOString(), token);
  },

  changePasswordForUser(this: SqliteDatabase, userId: string, currentPassword: string, newPassword: string): void {
    const row = this.db
      .prepare("SELECT password_hash, password_salt FROM app_users WHERE id = ?")
      .get(userId) as { password_hash: string; password_salt: string } | undefined;

    if (!row || !this.verifyPassword(currentPassword, row.password_hash, row.password_salt)) {
      throw new Error("Current password is incorrect");
    }

    if (newPassword.length < 8 || !/[A-Za-z]/.test(newPassword) || !/\d/.test(newPassword)) {
      throw new Error("Password must be at least 8 characters and include a number");
    }

    const { hash, salt } = this.hashPassword(newPassword);
    this.db
      .prepare("UPDATE app_users SET password_hash = ?, password_salt = ?, updated_at = ? WHERE id = ?")
      .run(hash, salt, new Date().toISOString(), userId);
  },
};

export type UsersMethods = typeof usersMethods;
