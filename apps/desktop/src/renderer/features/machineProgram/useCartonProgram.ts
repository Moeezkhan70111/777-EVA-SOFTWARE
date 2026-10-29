import { useCallback, useEffect, useState } from "react";
import { CONTRACTOR_PARTY_TYPE } from "@erp/domain";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import type { CartonProgramBatch, CartonProgramLine, MachineDayProgram, MachineRecord, OpenMachineProgram } from "../../types/desktopApi";

// Reading the Machine Program and what it is made for. Every read here is side-effect free in the
// main process — a program is opened only by a QR run — so loading on every visit, on Refresh, on a
// day change or a tab switch can never add a carton or open a program.

/** The four states every async screen shows (R12). */
export interface LoadState<T> {
  rows: T[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

type Reply<T> = { accepted: boolean; rows: T[]; reason?: string };

/** One read, with its loading and error states; re-run whenever `read` changes. */
function useRows<T>(read: () => Promise<Reply<T>>, failed: string): LoadState<T> {
  const [rows, setRows] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const reply = await read();
      if (reply.accepted) setRows(reply.rows);
      else setError(reply.reason ?? failed);
    } catch {
      setError(failed);
    } finally {
      setLoading(false);
    }
  }, [read, failed]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { rows, loading, error, reload };
}

/** Every machine's program for one business date (YYYY-MM-DD). */
export const useDayPrograms = (programDate: string, failed: string): LoadState<MachineDayProgram> => {
  const api = useDesktopApi();
  const read = useCallback(() => api.listMachineDayPrograms(programDate), [api, programDate]);
  return useRows(read, failed);
};

/** Every program still open, whatever its date: what an administrator can still delete (0.3.8). */
export const useOpenPrograms = (failed: string): LoadState<OpenMachineProgram> => {
  const api = useDesktopApi();
  const read = useCallback(() => api.listOpenMachinePrograms(), [api]);
  return useRows(read, failed);
};

/** The runs behind one line of a program, read when the line is opened. */
export const useProgramRuns = (programId: string, line: CartonProgramLine, failed: string): LoadState<CartonProgramBatch> => {
  const api = useDesktopApi();
  const { articleSizeId, color, grade } = line;
  const read = useCallback(
    () => api.listCartonProgramBatches({ programId, articleSizeId, color, grade }),
    [api, programId, articleSizeId, color, grade]
  );
  return useRows(read, failed);
};

/** The active machines, each with its two contractors. */
export const useMachines = (failed: string): LoadState<MachineRecord> => {
  const api = useDesktopApi();
  const read = useCallback(async () => ({ accepted: true, rows: await api.listMachines(false) }), [api]);
  return useRows(read, failed);
};

/** A contractor a machine can be given: an active Contractor party from the Party Master. */
export interface ContractorOption {
  id: string;
  name: string;
  city: string;
}

export const useContractors = (failed: string): LoadState<ContractorOption> => {
  const api = useDesktopApi();
  const read = useCallback(async () => {
    const result = await api.listParties({ pageSize: 500, status: "ACTIVE", partyType: CONTRACTOR_PARTY_TYPE });
    const rows = result.rows
      .filter((party) => party.partyType === CONTRACTOR_PARTY_TYPE && party.status === "ACTIVE")
      .map((party) => ({ id: party.id, name: party.partyName, city: party.city ?? "" }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { accepted: true, rows };
  }, [api]);
  return useRows(read, failed);
};

/** Whether a machine can have cartons generated for it: both contractors set. */
export const machineIsReady = (machine: MachineRecord): boolean =>
  Boolean(machine.contractorPartyId && machine.packingContractorPartyId);
