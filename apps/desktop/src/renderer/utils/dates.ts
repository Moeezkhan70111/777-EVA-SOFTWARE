import { APP_TIMEZONE } from "@erp/domain";

// Central date/time formatting. Timestamps are stored and transported as ISO strings
// (UTC `…Z` for created_at/updated_at; zone-less local strings for event_ts_local) and are
// always displayed in the business timezone (Asia/Karachi). Components must not do their
// own timezone arithmetic or call toLocale*String directly.

const EM_DASH = "—";

/** Parses an ISO timestamp; returns null for anything that is not a real date. */
export const parseDate = (value: string | Date | null | undefined): Date | null => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

/**
 * Zone-less local timestamps (`2026-08-21T06:00:00.000`, as event_ts_local stores them) are
 * already in business-local time, so they are formatted with the machine's zone rather than
 * shifted into Asia/Karachi a second time.
 */
const isZoneless = (value: string | Date | null | undefined): boolean =>
  typeof value === "string" && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) && value.includes("T");

const formatWith = (
  value: string | Date | null | undefined,
  options: Intl.DateTimeFormatOptions,
  fallback: string,
  locale = "en-GB"
): string => {
  const date = parseDate(value);
  if (!date) return fallback;
  const timeZone = isZoneless(value) ? undefined : APP_TIMEZONE;
  return new Intl.DateTimeFormat(locale, { ...options, timeZone }).format(date);
};

/** `21 Aug 2026` */
export const formatDate = (value: string | Date | null | undefined, fallback = EM_DASH): string =>
  formatWith(value, { day: "2-digit", month: "short", year: "numeric" }, fallback);

/** `21/08/2026` — the way the paper books are dated. */
export const formatBookDate = (value: string | Date | null | undefined, fallback = ""): string =>
  formatWith(value, { day: "2-digit", month: "2-digit", year: "numeric" }, fallback);

/**
 * `6:47 PM` — the 12-hour clock the floor reads. The ERP shows times this way everywhere, so
 * this is the only place the choice is made; `en-US` is used purely because it writes AM/PM in
 * capitals, while the dates around it stay `en-GB` (day before month).
 */
export const formatTime = (value: string | Date | null | undefined, fallback = EM_DASH): string =>
  formatWith(value, { hour: "numeric", minute: "2-digit", hour12: true }, fallback, "en-US");

/** The same clock, under the name the printed vouchers already call it by. */
export const formatClockTime = formatTime;

/** `30-09-2026` — a printed voucher's date, dashed rather than slashed. */
export const formatDashedDate = (value: string | Date | null | undefined, fallback = EM_DASH): string => {
  const date = parseDate(value);
  if (!date) return fallback;
  const timeZone = isZoneless(value) ? undefined : APP_TIMEZONE;
  const parts = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "2-digit", year: "numeric", timeZone }).formatToParts(date);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("day")}-${pick("month")}-${pick("year")}`;
};

/** `21 Aug 2026 · 14:05` */
export const formatDateTime = (value: string | Date | null | undefined, fallback = EM_DASH): string => {
  const date = parseDate(value);
  if (!date) return fallback;
  return `${formatDate(value)} · ${formatTime(value)}`;
};

/** `21 Aug 2026 – 23 Aug 2026`; a single day when both ends match. */
export const formatDateRange = (from: string | Date | null | undefined, to: string | Date | null | undefined): string => {
  const start = formatDate(from, "");
  const end = formatDate(to, "");
  if (start && end && start !== end) return `${start} – ${end}`;
  return start || end || EM_DASH;
};

/** "just now", "5 min ago", "3 h ago", "2 days ago" — for activity feeds. */
export const formatRelative = (value: string | Date | null | undefined, now: Date = new Date()): string => {
  const date = parseDate(value);
  if (!date) return EM_DASH;
  const seconds = Math.round((now.getTime() - date.getTime()) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
};

/** "under a minute", "5 minutes", "3 hours", "2 days" — how long something has lasted. */
export const formatDuration = (ms: number): string => {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"}`;
};

/** `YYYY-MM-DD` of a date in the business timezone — for date inputs and daily reports. */
export const toIsoDate = (value: Date = new Date()): string => {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: APP_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
};

/** `YYYY-MM-DD` of today minus `days`, in the business timezone — for "last N days" filters. */
export const isoDateDaysAgo = (days: number, now: Date = new Date()): string =>
  toIsoDate(new Date(now.getTime() - days * 86_400_000));

/**
 * Shifts a plain `YYYY-MM-DD` by whole days (calendar arithmetic, no timezone involved).
 * Used to turn an inclusive "to" date into the exclusive upper bound a range query wants.
 */
export const shiftIsoDate = (ymd: string, days: number): string => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!match) return ymd;
  const shifted = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days));
  return shifted.toISOString().slice(0, 10);
};

/** `Sep 2026` from a `YYYY-MM` key — for month group headings in ledgers. */
export const formatMonth = (yearMonth: string, fallback = EM_DASH): string => {
  const match = /^(\d{4})-(\d{2})$/.exec(yearMonth);
  if (!match) return fallback;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
  return new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric", timeZone: "UTC" }).format(date);
};

/** `Thu, 18 Sep 2026` — the station header date. */
export const formatDateWithWeekday = (value: string | Date | null | undefined, fallback = EM_DASH): string =>
  formatWith(value, { weekday: "short", day: "2-digit", month: "short", year: "numeric" }, fallback);

/**
 * A plain `YYYY-MM-DD` calendar day (a program date, a report day) as a Date at UTC midnight.
 * Formatted with timeZone UTC so the day can never be shifted by a zone — it is a day, not an
 * instant.
 */
const calendarDay = (ymd: string): Date | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd ?? ""));
  return match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
};

/** `Sunday, 4 October 2026` — a calendar day the way a person says it. */
export const formatLongDate = (ymd: string, fallback = EM_DASH): string => {
  const day = calendarDay(ymd);
  return day
    ? new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(day)
    : fallback;
};

/** `4 October` — a calendar day without its year, for a card that already says which year. */
export const formatDayMonth = (ymd: string, fallback = EM_DASH): string => {
  const day = calendarDay(ymd);
  return day ? new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", timeZone: "UTC" }).format(day) : fallback;
};

/** `October 2026` for the month a `YYYY-MM-DD` falls in — a calendar's heading. */
export const formatMonthYear = (ymd: string, fallback = EM_DASH): string => {
  const day = calendarDay(ymd);
  return day ? new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(day) : fallback;
};

/** 0 = Monday … 6 = Sunday, for a calendar grid that starts its week on Monday. */
export const mondayFirstWeekday = (ymd: string): number => {
  const day = calendarDay(ymd);
  return day ? (day.getUTCDay() + 6) % 7 : 0;
};
