import type { ColorTranslation } from "@erp/domain";

// What the main process answers about the colour list, checked at the boundary (R25). A malformed list is a
// failure, never an empty list: an empty list would quietly turn every Urdu colour back into English.

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isText = (value: unknown): value is string => typeof value === "string";

const isTranslation = (value: unknown): value is ColorTranslation =>
  isRecord(value) && isText(value.id) && value.id !== "" && isText(value.englishName) && isText(value.urduName);

export type ColorListReply = { readonly ok: true; readonly translations: ColorTranslation[] } | { readonly ok: false; readonly reason?: string };

export const parseColorListReply = (reply: unknown): ColorListReply => {
  if (!isRecord(reply) || reply.accepted !== true) return { ok: false, reason: isRecord(reply) && isText(reply.reason) ? reply.reason : undefined };
  const { translations } = reply;
  if (!Array.isArray(translations) || !translations.every(isTranslation)) return { ok: false };
  return { ok: true, translations: translations.map(({ id, englishName, urduName }) => ({ id, englishName, urduName })) };
};

/** A write's answer: accepted, or the refusal's code (a data-layer or authorisation code) for the screen to name. */
export type ColorWriteReply = { readonly ok: true } | { readonly ok: false; readonly code?: string; readonly reason?: string };

export const parseColorWriteReply = (reply: unknown): ColorWriteReply => {
  if (isRecord(reply) && reply.accepted === true) return { ok: true };
  if (!isRecord(reply)) return { ok: false };
  return { ok: false, code: isText(reply.code) ? reply.code : undefined, reason: isText(reply.reason) ? reply.reason : undefined };
};
