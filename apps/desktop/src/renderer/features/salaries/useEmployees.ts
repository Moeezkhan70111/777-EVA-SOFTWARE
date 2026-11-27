import { useCallback, useEffect, useRef, useState } from "react";
import { copy } from "../../config/copy";
import { useDataChanged } from "../../hooks/useDataChanged";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { DATA_KIND } from "../../../shared/dataChange";
import { parseEmployeesReply, type Employee } from "./employees";

// Every employee, read again when one is added here or arrives from the accounts computer. A refresh keeps the rows on
// screen; a failure says so and offers Retry (R12).

const SALARY_CHANGES = [DATA_KIND.SALARIES];

export interface EmployeesState {
  rows: Employee[] | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export const useEmployees = (): EmployeesState => {
  const api = useDesktopApi();
  const [rows, setRows] = useState<Employee[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);

  const reload = useCallback(() => {
    const ticket = ++latest.current;
    setLoading(true);
    void api.listEmployees()
      .then((reply) => {
        if (ticket !== latest.current) return;
        const parsed = parseEmployeesReply(reply, copy.salaries.failed);
        if (parsed.ok) { setRows(parsed.value); setError(null); } else setError(parsed.reason);
      })
      .catch(() => { if (ticket === latest.current) setError(copy.salaries.failed); })
      .finally(() => { if (ticket === latest.current) setLoading(false); });
  }, [api]);

  useEffect(reload, [reload]);
  useDataChanged(SALARY_CHANGES, reload);
  return { rows, loading, error, reload };
};
