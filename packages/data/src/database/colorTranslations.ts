// The colour list: English colour -> what the factory floor calls it in Urdu (local migration 106, docs/45).
//
// Master data. Every write here is this computer's own change, so the capture trigger marks the record and the
// builder sends it under the MASTER_DATA lease (masterCapture.ts); the IPC write path checks the lease first.
//
// The rules are @erp/domain's (validateColorTranslation, normalizeColorKey): checked again here because the data
// layer is the last word, whoever calls it. One English key is one colour -- the UNIQUE index says so too, and a
// duplicate is refused with its own code rather than a constraint message.
//
// Nothing else changes when a mapping does: colours stay stored in English everywhere they are.

import crypto from "node:crypto";
import {
  COLOR_TRANSLATION_ERROR,
  normalizeColorKey,
  validateColorTranslation,
  type ColorTranslation,
  type ColorTranslationError,
} from "@erp/domain";
import type { SqliteDatabase } from "../sqliteDatabase.js";

/** A refusal with a code the screen turns into words (copy.colorTranslation.errors). */
export class ColorTranslationRefusedError extends Error {
  constructor(readonly code: ColorTranslationError) {
    super(`Colour translation refused: ${code}`);
    this.name = "ColorTranslationRefusedError";
  }
}

export interface ColorTranslationInput {
  readonly englishName: string;
  readonly urduName: string;
}

type Row = { id: string; english_name: string; urdu_name: string };

const toTranslation = (row: Row): ColorTranslation => ({ id: row.id, englishName: row.english_name, urduName: row.urdu_name });

/** The entry, trimmed and checked, with its key. Throws the first thing wrong with it. */
function checked(input: ColorTranslationInput): { english: string; urdu: string; key: string } {
  const english = String(input.englishName ?? "").trim().replace(/\s+/g, " ");
  const urdu = String(input.urduName ?? "").trim();
  const problem = validateColorTranslation(english, urdu);
  if (problem !== null) throw new ColorTranslationRefusedError(problem);
  return { english, urdu, key: normalizeColorKey(english) };
}

function refuseDuplicate(db: SqliteDatabase, key: string, exceptId: string | null): void {
  const holder = db.db.prepare("SELECT id FROM color_translations WHERE english_key = ? LIMIT 1").get(key) as { id: string } | undefined;
  if (holder !== undefined && holder.id !== exceptId) throw new ColorTranslationRefusedError(COLOR_TRANSLATION_ERROR.DUPLICATE_ENGLISH);
}

export const colorTranslationsMethods = {
  /** Every mapping, in English alphabetical order. A short list (tens of rows), so it is read whole. */
  listColorTranslations(this: SqliteDatabase): ColorTranslation[] {
    const rows = this.db.prepare("SELECT id, english_name, urdu_name FROM color_translations ORDER BY english_key").all() as Row[];
    return rows.map(toTranslation);
  },

  createColorTranslation(this: SqliteDatabase, input: ColorTranslationInput): ColorTranslation {
    const { english, urdu, key } = checked(input);
    refuseDuplicate(this, key, null);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare("INSERT INTO color_translations (id, english_key, english_name, urdu_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, key, english, urdu, now, now);
    return { id, englishName: english, urduName: urdu };
  },

  updateColorTranslation(this: SqliteDatabase, id: string, input: ColorTranslationInput): ColorTranslation {
    const { english, urdu, key } = checked(input);
    refuseDuplicate(this, key, id);
    const result = this.db
      .prepare("UPDATE color_translations SET english_key = ?, english_name = ?, urdu_name = ?, updated_at = ? WHERE id = ?")
      .run(key, english, urdu, new Date().toISOString(), id);
    if (Number(result.changes) === 0) throw new ColorTranslationRefusedError(COLOR_TRANSLATION_ERROR.NOT_FOUND);
    return { id, englishName: english, urduName: urdu };
  },

  /** Removes one mapping. That colour then shows in English on screens, and spelled out on labels, until it is added again. */
  deleteColorTranslation(this: SqliteDatabase, id: string): void {
    const result = this.db.prepare("DELETE FROM color_translations WHERE id = ?").run(id);
    if (Number(result.changes) === 0) throw new ColorTranslationRefusedError(COLOR_TRANSLATION_ERROR.NOT_FOUND);
  },
};

export type ColorTranslationsMethods = typeof colorTranslationsMethods;
