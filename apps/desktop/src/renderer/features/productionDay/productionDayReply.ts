import type { ProductionDayMachine, ProductionDayMark, ProductionDayView } from "@erp/domain";
import { isArticle } from "../cartonStock/cartonMatrixReply";

// What the production-day channels answer, checked at the boundary (R25): the Manual Production page's Save and
// "Complete today's production", the status box on Carton Stock, and the Daily Production page. Anything malformed
// is a failure, said in the caller's words: never a figure the main process did not give.

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isText = (value: unknown): value is string => typeof value === "string";

export type Reply<T> = { ok: true; value: T } | { ok: false; reason: string };

/** A refusal in the main process's words, or `fallback`. */
const refused = <T>(reply: Record<string, unknown>, fallback: string): Reply<T> => ({ ok: false, reason: isText(reply.reason) && reply.reason ? reply.reason : fallback });

const isMark = (value: unknown): value is ProductionDayMark =>
  isRecord(value) && isText(value.date) && isText(value.completedAt) && isText(value.completedBy) && isNumber(value.cartons) && isNumber(value.entries);

const isMachine = (value: unknown): value is ProductionDayMachine =>
  isRecord(value) && isText(value.machineName) && isNumber(value.cartons) && isNumber(value.entries) && Array.isArray(value.articles) && value.articles.every(isArticle);

const isDay = (value: unknown): value is ProductionDayView =>
  isRecord(value) &&
  isText(value.date) &&
  (value.completed === null || isMark(value.completed)) &&
  isNumber(value.totalCartons) &&
  isNumber(value.entries) &&
  Array.isArray(value.machines) &&
  value.machines.every(isMachine) &&
  Array.isArray(value.articles) &&
  value.articles.every(isArticle);

/** The day's mark: null while the day is not complete. */
export const parseMarkReply = (reply: unknown, failed: string): Reply<ProductionDayMark | null> => {
  if (!isRecord(reply)) return { ok: false, reason: failed };
  if (reply.accepted !== true) return refused(reply, failed);
  if (reply.mark === null) return { ok: true, value: null };
  return isMark(reply.mark) ? { ok: true, value: reply.mark } : { ok: false, reason: failed };
};

export const parseDayReply = (reply: unknown, failed: string): Reply<ProductionDayView> => {
  if (!isRecord(reply)) return { ok: false, reason: failed };
  if (reply.accepted !== true) return refused(reply, failed);
  return isDay(reply.day) ? { ok: true, value: reply.day } : { ok: false, reason: failed };
};

export interface SaveAnswer {
  entries: number;
  cartons: number;
  duplicates: number;
}

export const parseSaveReply = (reply: unknown, failed: string): Reply<SaveAnswer> => {
  if (!isRecord(reply)) return { ok: false, reason: failed };
  if (reply.accepted !== true) return refused(reply, failed);
  const { entries, cartons, duplicates } = reply;
  return isNumber(entries) && isNumber(cartons) && isNumber(duplicates) ? { ok: true, value: { entries, cartons, duplicates } } : { ok: false, reason: failed };
};

export const parseCompleteReply = (reply: unknown, failed: string): Reply<ProductionDayMark> => {
  if (!isRecord(reply)) return { ok: false, reason: failed };
  if (reply.accepted !== true) return refused(reply, failed);
  return isMark(reply.mark) ? { ok: true, value: reply.mark } : { ok: false, reason: failed };
};
