import { useDesktopApi } from "../../hooks/useDesktopApi";
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

export { useLoaded, type Loaded } from "../../hooks/useLoaded";
import { useLoaded, type Loaded } from "../../hooks/useLoaded";

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
