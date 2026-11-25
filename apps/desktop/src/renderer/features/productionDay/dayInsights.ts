import type { ProductionDayView } from "@erp/domain";
import { shiftIsoDate } from "../../utils/dates";

// WHAT A DAY'S PRODUCTION SAYS, beyond its total (owner, 25 Nov 2026: the page was "too boring"): the week around it,
// how it compares with the day before, its top article, and each machine's share. Plain sums of the main process's
// own figures (productionDayView); nothing here decides a quantity.

export const WEEK_DAYS = 7;

/** The seven days ending on `endDate`, oldest first. */
export const weekDates = (endDate: string): string[] =>
  Array.from({ length: WEEK_DAYS }, (_, index) => shiftIsoDate(endDate, index - (WEEK_DAYS - 1)));

export interface WeekDay {
  readonly date: string;
  /** Null while it is read, or when it could not be. */
  readonly cartons: number | null;
  readonly complete: boolean;
}

/** Each day's bar as a share of the week's best day, 0–100. A week with nothing gives every bar 0. */
export const barHeights = (week: readonly WeekDay[]): number[] => {
  const most = Math.max(0, ...week.map((day) => day.cartons ?? 0));
  return week.map((day) => (most === 0 ? 0 : Math.round(((day.cartons ?? 0) / most) * 100)));
};

/** Cartons more (positive) or fewer than the day before, or null when the day before is not known. */
export const changeFromDayBefore = (week: readonly WeekDay[], date: string): number | null => {
  const today = week.find((day) => day.date === date);
  const before = week.find((day) => day.date === shiftIsoDate(date, -1));
  if (!today || !before || today.cartons === null || before.cartons === null) return null;
  return today.cartons - before.cartons;
};

/** A whole percent of the day, never more than 100. */
export const shareOf = (part: number, whole: number): number => (whole <= 0 ? 0 : Math.min(100, Math.round((part / whole) * 100)));

/** The article with the most cartons in the day (the first in order on a tie), or null on an empty day. */
export const topArticle = (day: ProductionDayView): { article: string; cartons: number; share: number } | null => {
  const best = day.articles.reduce<ProductionDayView["articles"][number] | null>((top, article) => (!top || article.total > top.total ? article : top), null);
  return best ? { article: best.article, cartons: best.total, share: shareOf(best.total, day.totalCartons) } : null;
};
