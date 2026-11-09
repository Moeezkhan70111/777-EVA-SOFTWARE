// TEST SUPPORT ONLY -- never imported by the application, and not exported from @erp/data's index.
//
// Most carton tests model a factory after go-live, so their computers need Carton Cloud active. This activates through
// the REAL activation (stockProtection.ts), with the lease cache filled in just for that moment as a sync pass would
// leave it, and then puts the test's own lease cache back exactly as it was. Nothing about the cutoff is faked: a
// record made before this call is excluded, exactly as in production.

import { activateCartonCloud } from "../database/stockProtection.js";
import type { BuildHandle } from "../database/masterRecords.js";

type Row = Record<string, unknown>;

export function activateCartonCloudForTest(db: BuildHandle, projectKey = "https://test.supabase.co", nowIso = new Date().toISOString()): void {
  const read = (key: string): string | null =>
    ((db.prepare("SELECT setting_value AS v FROM app_settings WHERE setting_key = ?").all(key)[0] as Row | undefined)?.v as string | undefined) ?? null;
  const device = read("device.id");
  if (device === null) throw new Error("activateCartonCloudForTest: the database has no device.id yet");
  const upsert = db.prepare(
    `INSERT INTO app_settings (setting_key, setting_value, value_type, is_encrypted, updated_by, updated_at) VALUES (?, ?, 'string', 0, 'test', ?)
     ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value`
  );
  const project = read("sync.pull.project") ?? projectKey;
  upsert.run("sync.pull.project", project, nowIso);

  const saved = db.prepare("SELECT * FROM sync_domain_leases").all() as Row[];
  const lease = db.prepare(
    `INSERT OR REPLACE INTO sync_domain_leases (domain, holder_device_id, holder_label, epoch, barrier_seq, granted_at, project_key, fetched_at)
     VALUES (?, ?, 'test', 1, 0, ?, ?, ?)`
  );
  for (const domain of ["CARTON_STOCK", "SALES_DISPATCH", "ACCOUNTS"]) lease.run(domain, device, nowIso, project, nowIso);
  const outcome = activateCartonCloud(db, { nowIso, activatedBy: "test" });

  db.prepare("DELETE FROM sync_domain_leases").run();
  for (const row of saved) {
    const columns = Object.keys(row);
    db.prepare(`INSERT INTO sync_domain_leases (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(
      ...columns.map((column) => row[column] as string | number | null)
    );
  }
  if (!outcome.activated) throw new Error(`activateCartonCloudForTest: refused: ${outcome.problems.join("; ")}`);
}
