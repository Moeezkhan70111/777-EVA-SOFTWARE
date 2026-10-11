// Contractor pricing on a machine program: reading and writing what each ARTICLE's work is
// paid at, per DOZEN, in integer paisa (migration 063).
//
//   "what is SK6 7/10 priced at on this program?"   getMachineProgramArticleRates
//   "is this article even on the program?"           machineProgramHasArticle
//   "price it"                                       upsertMachineProgramArticleRates
//   "every price on the program"                     readMachineProgramArticleRates
//
// These methods are merged onto SqliteDatabase (see sqliteDatabase.ts, "Feature modules").
// `this` is the database instance.
//
// No amount is stored or computed here. A rate times a quantity is the domain's arithmetic
// (@erp/domain contractorPricing.ts), so the program screen, the printed sheet and anything
// added later all read the same figures from one place.

import type { DatabaseSync } from "node:sqlite";
import type { SqliteDatabase } from "../sqliteDatabase.js";
import type { TransactionContext } from "@erp/application";
import type { ContractorRates } from "@erp/domain";
import type { MutableTransactionContext } from "./shared.js";
import type { MachineProgramArticleRateRecord } from "./types.js";

const text = (value: unknown): string => (value == null ? "" : String(value));
const dbOf = (tx: TransactionContext) => (tx as MutableTransactionContext).db;

const mapRates = (row: Record<string, unknown>): ContractorRates => ({
  machineRatePaisa: Number(row.machine_rate_paisa ?? 0),
  packingRatePaisa: Number(row.packing_rate_paisa ?? 0),
  printingRatePaisa: Number(row.printing_rate_paisa ?? 0),
});

export const machineProgramRatesMethods = {
  /** The program as a pricing write needs to judge it: does it exist, and is it still open. */
  async getMachineProgramForRates(
    this: SqliteDatabase,
    programId: string,
    tx: TransactionContext
  ): Promise<{ id: string; programNumber: number; status: string } | null> {
    const row = dbOf(tx)
      .prepare("SELECT id, program_number, status FROM machine_programs WHERE id = ? LIMIT 1")
      .get(text(programId).trim()) as Record<string, unknown> | undefined;
    return row ? { id: text(row.id), programNumber: Number(row.program_number ?? 0), status: text(row.status) } : null;
  },

  /**
   * Whether any run of the program is making this article.
   *
   * Pricing is per article, but an article is only on a program through its runs — so this is
   * the question that keeps a price from being stored for work the machine is not doing.
   */
  async machineProgramHasArticle(
    this: SqliteDatabase,
    input: { programId: string; articleSizeId: string },
    tx: TransactionContext
  ): Promise<boolean> {
    const row = dbOf(tx)
      .prepare("SELECT 1 AS found FROM machine_program_runs WHERE program_id = ? AND article_size_id = ? LIMIT 1")
      .get(text(input.programId).trim(), text(input.articleSizeId).trim()) as Record<string, unknown> | undefined;
    return Boolean(row);
  },

  async getMachineProgramArticleRates(
    this: SqliteDatabase,
    input: { programId: string; articleSizeId: string },
    tx: TransactionContext
  ): Promise<ContractorRates | null> {
    const row = dbOf(tx)
      .prepare(
        `SELECT machine_rate_paisa, packing_rate_paisa, printing_rate_paisa
         FROM machine_program_article_rates WHERE program_id = ? AND article_size_id = ? LIMIT 1`
      )
      .get(text(input.programId).trim(), text(input.articleSizeId).trim()) as Record<string, unknown> | undefined;
    return row ? mapRates(row) : null;
  },

  /**
   * Prices an article, or re-prices it.
   *
   * ON CONFLICT on the (program, article) index is what makes "price it again" a change rather
   * than a second price — the unique index in migration 063 is the rule, not a convention here.
   */
  async upsertMachineProgramArticleRates(
    this: SqliteDatabase,
    payload: {
      id: string; programId: string; articleSizeId: string;
      machineRatePaisa: number; packingRatePaisa: number; printingRatePaisa: number;
      actor: string; nowIso: string;
    },
    tx: TransactionContext
  ): Promise<void> {
    dbOf(tx)
      .prepare(
        `INSERT INTO machine_program_article_rates
           (id, program_id, article_size_id, machine_rate_paisa, packing_rate_paisa, printing_rate_paisa,
            created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(program_id, article_size_id) DO UPDATE SET
           machine_rate_paisa = excluded.machine_rate_paisa,
           packing_rate_paisa = excluded.packing_rate_paisa,
           printing_rate_paisa = excluded.printing_rate_paisa,
           updated_at = excluded.updated_at`
      )
      .run(
        payload.id,
        text(payload.programId).trim(),
        text(payload.articleSizeId).trim(),
        payload.machineRatePaisa,
        payload.packingRatePaisa,
        payload.printingRatePaisa,
        payload.actor,
        payload.nowIso,
        payload.nowIso
      );
  },

  /**
   * @internal Every article price on a program, for the program record.
   *
   * `db` is passed explicitly so a read inside a transaction uses that transaction's connection
   * — the same contract as readMachineProgramRuns.
   */
  readMachineProgramArticleRates(
    this: SqliteDatabase,
    programId: string,
    db: DatabaseSync
  ): MachineProgramArticleRateRecord[] {
    const rows = db
      .prepare(
        `SELECT article_size_id, machine_rate_paisa, packing_rate_paisa, printing_rate_paisa, updated_at
         FROM machine_program_article_rates WHERE program_id = ?`
      )
      .all(text(programId).trim()) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      articleSizeId: text(row.article_size_id),
      ...mapRates(row),
      updatedAt: text(row.updated_at),
    }));
  },
};

export type MachineProgramRatesMethods = typeof machineProgramRatesMethods;
