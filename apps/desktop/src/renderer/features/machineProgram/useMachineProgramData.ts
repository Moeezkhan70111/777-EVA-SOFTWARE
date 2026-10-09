import { useCallback, useEffect, useRef, useState } from "react";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { copy } from "../../config/copy";
import type {
  MachineProgramArticle,
  MachineProgramBoardRow,
  MachineProgramMaterial,
  MachineProgramRecord,
  SoleColourOption,
} from "../../types/desktopApi";

// The reads the Machine Program screens make. Every one goes through the desktop API to the data
// layer, and every one is re-read after a change rather than patched locally — so a figure on
// screen is always the database's, never what the screen thought a moment ago.

export interface Loaded<T> {
  value: T;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

type Answer = { accepted: boolean; reason?: string };

/**
 * Loads `read()` whenever `key` changes, keeping the four states a screen needs (R12). A null
 * `read` loads nothing. A slow answer for an old key never overwrites a newer one.
 */
export const useLoaded = <T, R extends Answer>(
  key: string,
  read: (() => Promise<R>) | null,
  pick: (answer: R) => T,
  initial: T
): Loaded<T> => {
  const [value, setValue] = useState<T>(initial);
  const [loading, setLoading] = useState(read !== null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(key);
  const readRef = useRef(read);
  const pickRef = useRef(pick);
  readRef.current = read;
  pickRef.current = pick;

  const reload = useCallback(async () => {
    const run = readRef.current;
    if (!run) return;
    const asked = key;
    latest.current = asked;
    setLoading(true);
    setError(null);
    try {
      const answer = await run();
      if (latest.current !== asked) return;
      if (!answer.accepted) throw new Error(answer.reason ?? copy.states.loadFailedBody);
      setValue(pickRef.current(answer));
    } catch (cause) {
      if (latest.current === asked) setError(cause instanceof Error ? cause.message : copy.states.loadFailedBody);
    } finally {
      if (latest.current === asked) setLoading(false);
    }
  }, [key]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { value, loading, error, reload };
};

export const useMachineBoard = (programDate: string): Loaded<MachineProgramBoardRow[]> => {
  const api = useDesktopApi();
  return useLoaded(`board:${programDate}`, () => api.listMachineProgramBoard(programDate), (answer) => answer.rows, []);
};

/** The machine's program for a date. With no machine chosen yet it reads nothing. */
export const useMachineProgram = (machineId: string | null, programDate: string): Loaded<MachineProgramRecord | null> => {
  const api = useDesktopApi();
  return useLoaded(
    `program:${machineId ?? ""}:${programDate}`,
    machineId ? () => api.getMachineProgramForDate(machineId, programDate) : null,
    (answer) => answer.program,
    null
  );
};

export const useSoleColours = (): Loaded<SoleColourOption[]> => {
  const api = useDesktopApi();
  return useLoaded("colours", () => api.listSoleColourOptions(), (answer) => answer.rows, []);
};

export const useArticles = (): Loaded<MachineProgramArticle[]> => {
  const api = useDesktopApi();
  return useLoaded("articles", () => api.listMachineProgramArticles(), (answer) => answer.rows, []);
};

/**
 * Every upper the store holds for one article + size, in every colour it holds it in.
 *
 * `stockVersion` (from useProgramWrites) changes on every save, which is what brings the figures
 * back from the data layer: a program reserves stock, so the moment one is changed what is free
 * of every upper has changed with it.
 */
export const useUppers = (machineId: string, articleSizeId: string | null, stockVersion: number): Loaded<MachineProgramMaterial[]> => {
  const api = useDesktopApi();
  return useLoaded(
    `uppers:${machineId}:${articleSizeId ?? ""}:${stockVersion}`,
    articleSizeId ? () => api.listMachineProgramUppers(machineId, articleSizeId) : null,
    (answer) => answer.rows,
    []
  );
};

const CONTRACTOR_PARTY_TYPE = "CONTRACTOR";

export interface ContractorOption {
  id: string;
  name: string;
  city: string;
}

/** Active parties of type Contractor, from the Party Master. */
export const useContractors = (): Loaded<ContractorOption[]> => {
  const api = useDesktopApi();
  return useLoaded(
    "contractors",
    async () => {
      const result = await api.listParties({ pageSize: 500, status: "ACTIVE", partyType: CONTRACTOR_PARTY_TYPE });
      return { accepted: true, rows: result.rows };
    },
    (answer) =>
      answer.rows
        .filter((party) => party.partyType === CONTRACTOR_PARTY_TYPE)
        .map((party) => ({ id: party.id, name: party.partyName, city: party.city ?? "" }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    []
  );
};
