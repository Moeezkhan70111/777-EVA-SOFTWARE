import type { DatabaseSync } from "node:sqlite";

// EVERY HR ARTICLE IN THE EIGHT COLOURS (owner, 27 Nov 2026: "make sure every Article that has HR on its name like HR-1
// HR-2 etc. has these 8 colors", and "THE 8 COLORS ... SHOULD BE SHOWN EVERYWHERE": Enter Orders, Manual Production,
// Stock Adjustment, every page that reads an article's colours from Product Master).
//
// ONCE, on the computer that writes Product Master (the MASTER_DATA lease, PC1), after the capture triggers are in
// place: each colour goes through addColorToArticle, the same call as "+ New colour", so it lands on every active size,
// a colour the article already holds under another spacing ("BLACKGREY") is not added twice, and every changed size
// travels to the cloud and the other computers like any colour added by hand. Elsewhere it does nothing and waits:
// the colours arrive from PC1. Until this computer is known to hold MASTER_DATA it is tried again at the next start.

export const HR_ARTICLE_COLOURS = ["BLACK", "SKIN", "GREY", "BLACK GREY", "WHITE", "COMMANDO", "BROWN MUSTARD", "BLACK MUSTARD"] as const;

/** HR-1, HR 2, HR10: the name starts with HR and no other letter follows. */
export const isHrArticle = (article: string): boolean => /^HR(?![A-Z])/i.test(article.trim());

const DONE_KEY = "data.hr_article_colours_added";

interface ColourAdder {
  readonly db: DatabaseSync;
  addColorToArticle(input: { article: string; color: string }): { added: number };
}

const holdsProductMaster = (db: DatabaseSync): boolean =>
  db
    .prepare(
      `SELECT 1 AS here FROM sync_domain_leases
        WHERE domain = 'MASTER_DATA' AND epoch > 0
          AND holder_device_id = (SELECT setting_value FROM app_settings WHERE setting_key = 'device.id')`
    )
    .get() !== undefined;

const hrArticles = (db: DatabaseSync): string[] =>
  (db.prepare("SELECT DISTINCT article FROM article_sizes WHERE status = 'ACTIVE' AND deleted_at IS NULL ORDER BY article").all() as Array<{ article: string }>)
    .map((row) => row.article)
    .filter(isHrArticle);

/** Adds what is missing and records that it ran. Returns how many sizes gained a colour, or null when not run here. */
export function addHrArticleColoursOnce(database: ColourAdder, now: string): number | null {
  const { db } = database;
  if (db.prepare("SELECT 1 AS here FROM app_settings WHERE setting_key = ?").get(DONE_KEY) !== undefined) return null;
  if (!holdsProductMaster(db)) return null;
  let added = 0;
  for (const article of hrArticles(db)) {
    for (const color of HR_ARTICLE_COLOURS) added += database.addColorToArticle({ article, color }).added;
  }
  db.prepare("INSERT INTO app_settings (setting_key, setting_value, updated_at) VALUES (?, ?, ?)").run(DONE_KEY, String(added), now);
  return added;
}
