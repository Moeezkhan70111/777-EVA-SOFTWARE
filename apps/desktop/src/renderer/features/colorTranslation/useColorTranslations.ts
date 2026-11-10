import { useCallback, useEffect, useState } from "react";
import type { ColorTranslation } from "@erp/domain";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { useDataChanged } from "../../hooks/useDataChanged";
import { DATA_KIND } from "../../../shared/dataChange";
import { publishColorTranslations } from "./colorDictionaryStore";
import { parseColorListReply, parseColorWriteReply, type ColorWriteReply } from "./colorTranslationReply";

// Reads the colour list, keeps it current, and writes it.
//
// Every successful read is published to the shared dictionary (colorDictionaryStore.ts), so a label printed or a
// screen drawn after a change uses the new Urdu at once. The list re-reads itself when another computer's change
// arrives (DATA_KIND.COLORS) and after each write here.

const COLOR_CHANGES = [DATA_KIND.COLORS] as const;

export interface ColorTranslationsState {
  readonly translations: ColorTranslation[] | null;
  readonly loading: boolean;
  /** Why the last read failed, or null. */
  readonly error: string | null;
  readonly reload: () => Promise<void>;
  readonly create: (englishName: string, urduName: string) => Promise<ColorWriteReply>;
  readonly update: (id: string, englishName: string, urduName: string) => Promise<ColorWriteReply>;
  readonly remove: (id: string) => Promise<ColorWriteReply>;
}

/** A write that threw (a lease refusal, a lost bridge) as a refusal with its words. */
const thrown = (error: unknown): ColorWriteReply => ({ ok: false, reason: error instanceof Error ? error.message : undefined });

export const useColorTranslations = (failedText: string): ColorTranslationsState => {
  const api = useDesktopApi();
  const [translations, setTranslations] = useState<ColorTranslation[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const reply = parseColorListReply(await api.listColorTranslations());
      if (reply.ok) {
        setTranslations(reply.translations);
        setError(null);
        publishColorTranslations(reply.translations);
      } else {
        setError(reply.reason ?? failedText);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : failedText);
    } finally {
      setLoading(false);
    }
  }, [api, failedText]);

  useEffect(() => {
    void reload();
  }, [reload]);
  useDataChanged(COLOR_CHANGES, () => void reload());

  const write = useCallback(
    async (call: () => Promise<unknown>): Promise<ColorWriteReply> => {
      let reply: ColorWriteReply;
      try {
        reply = parseColorWriteReply(await call());
      } catch (caught) {
        return thrown(caught);
      }
      if (reply.ok) await reload();
      return reply;
    },
    [reload]
  );

  return {
    translations,
    loading,
    error,
    reload,
    create: (englishName, urduName) => write(() => api.createColorTranslation({ englishName, urduName })),
    update: (id, englishName, urduName) => write(() => api.updateColorTranslation(id, { englishName, urduName })),
    remove: (id) => write(() => api.deleteColorTranslation(id)),
  };
};
