import React, { useCallback, useEffect, useState } from "react";
import { Pager } from "../../components/shared/Pager";
import { StateView } from "../../components/shared/StateView";
import { copy } from "../../config/copy";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import type { GatepassListRow } from "../../types/desktopApi";
import { formatGatepassDate, formatGatepassDateTime } from "../../utils/gatepassPrint";
import { dozensText } from "./gatepassDraft";

// DELETED GATEPASSES (local migration 118): every cancelled gatepass deleted from the list, newest deletion first, with
// who deleted it, when and why. A row opens the gatepass read-only. Nothing here changes anything.

const PAGE_SIZE = 25;

export const DeletedGatepassLog: React.FC<{ token: string; onOpen: (gatepassId: string) => void }> = ({ token, onOpen }) => {
  const api = useDesktopApi();
  const [rows, setRows] = useState<GatepassListRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.listGatepasses({ deleted: true, page, pageSize: PAGE_SIZE }, { token });
      setRows(result.rows ?? []);
      setTotal(result.total ?? 0);
    } catch {
      setError(copy.states.loadFailedBody);
    } finally {
      setLoading(false);
    }
  }, [api, token, page]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && rows.length === 0) return <StateView kind="loading" />;
  if (error) return <StateView kind="error" message={error} onRetry={() => void load()} />;
  if (rows.length === 0) return <StateView kind="empty" title={copy.gatepass.deletedLogEmpty} hint={copy.gatepass.deletedLogHint} />;

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return (
    <section className="card gp-card" data-testid="gatepass-deleted-log" aria-label={copy.gatepass.deletedLog}>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>GP No.</th>
              <th>{copy.columns.date}</th>
              <th>{copy.columns.party}</th>
              <th className="num">{copy.gatepass.inDozens(copy.columns.qty)}</th>
              <th>{copy.gatepass.deletedBy}</th>
              <th>{copy.gatepass.deletedAt}</th>
              <th>{copy.gatepass.deleteReasonColumn}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="gp-row" data-testid={`gatepass-deleted-${row.code}`}>
                <td className="gp-cell-code">
                  <button type="button" className="gp-link" onClick={() => onOpen(row.id)}>
                    {row.code}
                  </button>
                </td>
                <td>{formatGatepassDate(row.gatepassDate)}</td>
                <td>{row.partyName}</td>
                <td className="num">{dozensText(row.totalQuantity)}</td>
                <td>{row.deletedBy ?? "—"}</td>
                <td>{row.deletedAt ? formatGatepassDateTime(row.deletedAt) : "—"}</td>
                <td>{row.deleteReason ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pages > 1 ? <Pager page={page} pages={pages} onPage={setPage} /> : null}
    </section>
  );
};
