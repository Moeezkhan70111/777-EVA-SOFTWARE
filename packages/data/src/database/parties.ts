// Party master (customers / suppliers) and party groups.
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").
// `this` is the database instance; bodies are unchanged from the original class.

import type { SqliteDatabase } from "../sqliteDatabase.js";
import type { PagedResult, PartyListRow, PartyRecord } from "./types.js";
import { orderBy } from "./shared.js";
import { fromPaisaOrNull, toPaisaOrNull } from "@erp/domain";

export const partiesMethods = {
  createPartyGroup(this: SqliteDatabase, input: { groupName: string; description?: string }): string {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO party_groups (
          id, group_name, description, is_active, created_at, updated_at, deleted_at, deleted_by, delete_reason
        ) VALUES (?, ?, ?, 1, ?, ?, NULL, NULL, NULL)`
      )
      .run(id, input.groupName.trim(), input.description ?? null, now, now);

    return id;
  },

  listPartyGroups(this: SqliteDatabase): Array<{ id: string; groupName: string; description?: string; isActive: boolean }> {
    const rows = this.db
      .prepare(`SELECT id, group_name, description, is_active FROM party_groups WHERE deleted_at IS NULL ORDER BY group_name ASC`)
      .all() as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row.id ?? ""),
      groupName: String(row.group_name ?? ""),
      description: row.description ? String(row.description) : undefined,
      isActive: Number(row.is_active ?? 0) === 1,
    }));
  },

  getPartyGroupByName(this: SqliteDatabase, groupName: string): { id: string; groupName: string } | null {
    const row = this.db
      .prepare(`SELECT id, group_name FROM party_groups WHERE group_name = ? AND deleted_at IS NULL LIMIT 1`)
      .get(groupName.trim()) as { id: string; group_name: string } | undefined;

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      groupName: row.group_name,
    };
  },

  createParty(this: SqliteDatabase, input: {
    partyName: string;
    partyNameUrdu?: string;
    partyType?: string;
    contactPerson?: string;
    mobileNumber?: string;
    whatsAppNumber?: string;
    phoneNumber?: string;
    email?: string;
    address?: string;
    city?: string;
    partyGroupId?: string;
    remarks?: string;
    status?: string;
    balanceLimit?: number | null;
  }): string {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    // Allocating the party code and inserting the row are one transaction, so the code that is
    // read is the code that is written. party_code is UNIQUE, so without the write lock two
    // writers could read the same MAX and the second insert would fail.
    //
    // getNextPartyCode stays public and unchanged: the Party form calls it over IPC purely to
    // preview the code in a read-only field, and does not send that value back on save.
    //
    // Sole caller is apps/desktop/src/main/ipc/parties.ts, which opens no transaction, so this
    // cannot nest.
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
    const nextCode = this.getNextPartyCode();

    this.db
      .prepare(
        `INSERT INTO parties (
          id, party_code, party_name, party_name_urdu, party_type, contact_person, mobile_number, whatsapp_number, phone_number,
          email, address, city, party_group_id, remarks, status, is_active, balance_limit_paisa,
          created_at, updated_at, deleted_at, deleted_by, delete_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, NULL, NULL, NULL)`
      )
      .run(
        id,
        nextCode,
        input.partyName.trim(),
        input.partyNameUrdu?.trim() || null,
        input.partyType ?? "CUSTOMER",
        input.contactPerson ?? null,
        input.mobileNumber ?? null,
        input.whatsAppNumber ?? null,
        input.phoneNumber ?? null,
        input.email ?? null,
        input.address ?? null,
        input.city ?? null,
        input.partyGroupId ?? null,
        input.remarks ?? null,
        input.status ?? "ACTIVE",
        toPaisaOrNull(input.balanceLimit),
        now,
        now
      );

      this.db.exec("COMMIT");
      return id;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore missing transaction state */ }
      throw error;
    }
  },

  getNextPartyCode(this: SqliteDatabase): string {
    const row = this.db.prepare(
      `SELECT COALESCE(MAX(CAST(SUBSTR(party_code, 5) AS INTEGER)), 0) + 1 AS next_number FROM parties`
    ).get() as { next_number: number };
    return `PTY-${String(row.next_number).padStart(6, "0")}`;
  },

  getNextProductCode(this: SqliteDatabase): string {
    const row = this.db.prepare(
      `SELECT COALESCE(MAX(CAST(SUBSTR(product_code, 5) AS INTEGER)), 0) + 1 AS next_number FROM article_sizes WHERE product_code IS NOT NULL`
    ).get() as { next_number: number };
    return `PRD-${String(row.next_number).padStart(6, "0")}`;
  },

  updateParty(this: SqliteDatabase, 
    partyId: string,
    input: {
      partyName?: string;
      partyNameUrdu?: string;
      contactPerson?: string;
      mobileNumber?: string;
      whatsAppNumber?: string;
      phoneNumber?: string;
      email?: string;
      address?: string;
      city?: string;
      partyGroupId?: string;
      remarks?: string;
      status?: string;
      balanceLimit?: number | null;
    }
  ): void {
    const updates: string[] = [];
    const values: Array<string | number | null> = [];

    if (input.partyName !== undefined) {
      updates.push("party_name = ?");
      values.push(input.partyName.trim());
    }
    if (input.partyNameUrdu !== undefined) {
      updates.push("party_name_urdu = ?");
      values.push(input.partyNameUrdu.trim() || null);
    }
    if (input.contactPerson !== undefined) {
      updates.push("contact_person = ?");
      values.push(input.contactPerson || null);
    }
    if (input.mobileNumber !== undefined) {
      updates.push("mobile_number = ?");
      values.push(input.mobileNumber || null);
    }
    if (input.whatsAppNumber !== undefined) {
      updates.push("whatsapp_number = ?");
      values.push(input.whatsAppNumber || null);
    }
    if (input.phoneNumber !== undefined) {
      updates.push("phone_number = ?");
      values.push(input.phoneNumber || null);
    }
    if (input.email !== undefined) {
      updates.push("email = ?");
      values.push(input.email || null);
    }
    if (input.address !== undefined) {
      updates.push("address = ?");
      values.push(input.address || null);
    }
    if (input.city !== undefined) {
      updates.push("city = ?");
      values.push(input.city || null);
    }
    if (input.partyGroupId !== undefined) {
      updates.push("party_group_id = ?");
      values.push(input.partyGroupId || null);
    }
    if (input.remarks !== undefined) {
      updates.push("remarks = ?");
      values.push(input.remarks || null);
    }
    if (input.status !== undefined) {
      updates.push("status = ?");
      values.push(input.status);
    }
    if (input.balanceLimit !== undefined) {
      updates.push("balance_limit_paisa = ?");
      values.push(toPaisaOrNull(input.balanceLimit));
    }

    if (updates.length === 0) return;

    updates.push("updated_at = ?");
    values.push(new Date().toISOString());
    values.push(partyId);

    const sql = `UPDATE parties SET ${updates.join(", ")} WHERE id = ?`;
    this.db.prepare(sql).run(...values);
  },

  getParty(this: SqliteDatabase, partyId: string): PartyRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, party_code, party_name, party_name_urdu, party_type, contact_person, mobile_number, whatsapp_number, phone_number,
                email, address, city, party_group_id, remarks, status, balance_limit_paisa, created_at, updated_at
         FROM parties WHERE id = ? AND deleted_at IS NULL LIMIT 1`
      )
      .get(partyId) as Record<string, unknown> | undefined;

    if (!row) {
      return null;
    }

    return {
      id: String(row.id ?? ""),
      partyCode: String(row.party_code ?? ""),
      partyName: String(row.party_name ?? ""),
      partyNameUrdu: row.party_name_urdu ? String(row.party_name_urdu) : "",
      partyType: String(row.party_type ?? "CUSTOMER"),
      contactPerson: row.contact_person ? String(row.contact_person) : null,
      mobileNumber: row.mobile_number ? String(row.mobile_number) : null,
      whatsAppNumber: row.whatsapp_number ? String(row.whatsapp_number) : null,
      phoneNumber: row.phone_number ? String(row.phone_number) : null,
      email: row.email ? String(row.email) : null,
      address: row.address ? String(row.address) : null,
      city: row.city ? String(row.city) : null,
      partyGroupId: row.party_group_id ? String(row.party_group_id) : null,
      remarks: row.remarks ? String(row.remarks) : null,
      status: String(row.status ?? "ACTIVE"),
      balanceLimit: fromPaisaOrNull(row.balance_limit_paisa == null ? null : Number(row.balance_limit_paisa)),
      createdAt: String(row.created_at ?? ""),
      updatedAt: String(row.updated_at ?? ""),
    };
  },

  getPartyByName(this: SqliteDatabase, partyName: string): { id: string; partyName: string } | null {
    const row = this.db
      .prepare(`SELECT id, party_name FROM parties WHERE party_name = ? AND deleted_at IS NULL LIMIT 1`)
      .get(partyName.trim()) as { id: string; party_name: string } | undefined;

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      partyName: row.party_name,
    };
  },

  listParties(this: SqliteDatabase, query: {
    page?: number;
    pageSize?: number;
    search?: string;
    city?: string;
    groupId?: string;
    status?: string;
    partyType?: string;
    sortBy?: string;
    sortOrder?: string;
  } = {}): PagedResult<PartyListRow> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const offset = (page - 1) * pageSize;
    const orderClause = orderBy(
      query.sortBy,
      ["created_at", "party_code", "party_name", "party_type", "city", "status", "updated_at"],
      "created_at",
      query.sortOrder
    );

    const where: string[] = ["parties.deleted_at IS NULL"];
    const values: Array<string | number> = [];

    if (query.search?.trim()) {
      const needle = `%${query.search.trim()}%`;
      where.push(`(parties.party_code LIKE ? OR parties.party_name LIKE ? OR parties.party_name_urdu LIKE ? OR parties.city LIKE ? OR parties.mobile_number LIKE ? OR parties.email LIKE ? OR parties.contact_person LIKE ? OR party_groups.group_name LIKE ?)`);
      values.push(needle, needle, needle, needle, needle, needle, needle, needle);
    }

    if (query.city?.trim()) {
      where.push("parties.city = ?");
      values.push(query.city.trim());
    }

    if (query.groupId) {
      where.push("parties.party_group_id = ?");
      values.push(query.groupId);
    }

    if (query.status) {
      where.push("parties.status = ?");
      values.push(query.status);
    }

    if (query.partyType) {
      where.push("parties.party_type = ?");
      values.push(query.partyType);
    }

    const whereClause = where.join(" AND ");

    const totalRow = this.db
      .prepare(`SELECT COUNT(1) as c FROM parties LEFT JOIN party_groups ON party_groups.id = parties.party_group_id WHERE ${whereClause}`)
      .get(...values) as { c: number };

    const rows = this.db
      .prepare(
        `SELECT parties.id, parties.party_code, parties.party_name, parties.party_name_urdu, parties.party_type, parties.city, parties.party_group_id, parties.mobile_number, parties.status, parties.created_at,
                parties.balance_limit_paisa,
                party_groups.group_name
         FROM parties
         LEFT JOIN party_groups ON party_groups.id = parties.party_group_id
         WHERE ${whereClause}
         ORDER BY parties.${orderClause}
         LIMIT ? OFFSET ?`
      )
      .all(...values, pageSize, offset) as Array<Record<string, unknown>>;

    return {
      rows: rows.map((row) => ({
        id: String(row.id ?? ""),
        partyCode: String(row.party_code ?? ""),
        partyName: String(row.party_name ?? ""),
        partyNameUrdu: row.party_name_urdu ? String(row.party_name_urdu) : "",
        partyType: String(row.party_type ?? "CUSTOMER"),
        city: row.city ? String(row.city) : null,
        partyGroupId: row.party_group_id ? String(row.party_group_id) : null,
        groupName: row.group_name ? String(row.group_name) : null,
        mobileNumber: row.mobile_number ? String(row.mobile_number) : null,
        status: String(row.status ?? "ACTIVE"),
        balanceLimit: fromPaisaOrNull(row.balance_limit_paisa == null ? null : Number(row.balance_limit_paisa)),
        createdAt: String(row.created_at ?? ""),
      })),
      total: totalRow.c,
      page,
      pageSize,
    };
  },

  listCities(this: SqliteDatabase): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT city FROM parties WHERE city IS NOT NULL AND deleted_at IS NULL ORDER BY city ASC`)
      .all() as Array<{ city: string }>;

    return rows.map((row) => row.city);
  },

  deleteParty(this: SqliteDatabase, partyId: string, reason = "Deleted"): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE parties SET deleted_at = ?, delete_reason = ?, updated_at = ? WHERE id = ?`)
      .run(now, reason, now, partyId);
  },
};

export type PartiesMethods = typeof partiesMethods;
