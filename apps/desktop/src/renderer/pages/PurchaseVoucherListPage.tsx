import React, { useEffect, useState } from "react";
import type { AppRoute } from "../app/routes";
import { useDesktopApi } from "../hooks/useDesktopApi";
import type { PurchaseVoucherListRow } from "../types/desktopApi";
import { useNotifications } from "../state/NotificationsContext";
import { copy } from "../config/copy";
import { formatDate } from "../utils/dates";

interface PurchaseVoucherListPageProps {
  onNavigate: (route: AppRoute, voucherId?: string) => void;
}

export const PurchaseVoucherListPage: React.FC<PurchaseVoucherListPageProps> = ({ onNavigate }) => {
  const api = useDesktopApi();
  const { push } = useNotifications();

  const [vouchers, setVouchers] = useState<PurchaseVoucherListRow[]>([]);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("ALL");
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const pageSize = 20;

  useEffect(() => {
    void fetchVouchers();
  }, [search, status, page]);

  const fetchVouchers = async () => {
    setLoading(true);
    try {
      const results = await api.listPurchaseVouchers({
        search,
        status: status === "ALL" ? undefined : status,
        page,
        pageSize,
      });
      setVouchers(results.rows);
      setTotal(results.total);
    } catch (error) {
      console.error("Failed to fetch purchase vouchers:", error);
      push("error", copy.toast.loadFailed, "Could not load purchase vouchers");
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (voucherId: string, voucherNumber: string) => {
    if (!window.confirm(`Delete purchase bill ${voucherNumber}?`)) return;
    try {
      const result = await api.deletePurchaseVoucher(voucherId);
      if (result.accepted) {
        push("warning", "Bill Deleted", voucherNumber);
        await fetchVouchers();
      } else {
        push("error", copy.toast.deleteFailed, result.reason || "Could not delete bill");
      }
    } catch (error) {
      console.error("Failed to delete purchase voucher:", error);
      push("error", copy.toast.failed, "Could not delete bill");
    }
  };

  const totalPages = Math.ceil(total / pageSize);

  return (
    <div className="page sale-voucher-list-page">
      <div className="page-header">
        <h1>Purchase Bills</h1>
        <button type="button" className="btn btn-primary" onClick={() => onNavigate("purchase-voucher-form")}>
          New Bill
        </button>
      </div>

      <div className="toolbar">
        <input
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          placeholder="Search by bill #, supplier, or reference..."
          style={{ minWidth: 300 }}
        />
        <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="ALL">{copy.filters.allStatus}</option>
          <option value="DRAFT">Draft</option>
          <option value="FINALIZED">Finalized</option>
          <option value="CANCELLED">Cancelled</option>
        </select>
        <span className="flex-1" />
        <span className="text-muted text-small">
          {loading ? "Loading..." : `${vouchers.length} of ${total} bills`}
        </span>
      </div>

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Bill #</th>
              <th>{copy.columns.supplier}</th>
              <th>{copy.columns.date}</th>
              <th>{copy.columns.reference}</th>
              <th>{copy.columns.qty}</th>
              <th>Amount (PKR)</th>
              <th>{copy.columns.status}</th>
              <th>{copy.columns.actions}</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={8} className="empty-state">{copy.common.loading}</td></tr>
            ) : vouchers.length === 0 ? (
              <tr><td colSpan={8} className="empty-state">No purchase bills found</td></tr>
            ) : (
              vouchers.map((voucher) => (
                <tr key={voucher.id}>
                  <td><strong>{voucher.voucherNumber}</strong></td>
                  <td>{voucher.partyName}</td>
                  <td>{formatDate(voucher.voucherDate)}</td>
                  <td>{voucher.referenceNo || "-"}</td>
                  <td className="text-right">{voucher.totalQuantity}</td>
                  <td className="text-right">{voucher.totalAmount.toFixed(2)}</td>
                  <td>
                    <span className={`badge ${
                      voucher.status === "FINALIZED" ? "badge-ok" :
                      voucher.status === "CANCELLED" ? "badge-muted" :
                      "badge-warn"
                    }`}>
                      {voucher.status.toLowerCase()}
                    </span>
                  </td>
                  <td>
                    <div className="cell-actions">
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => onNavigate("purchase-voucher-form", voucher.id)}>{copy.actions.edit}</button>
                      <button type="button" className="btn btn-danger btn-sm" onClick={() => handleDelete(voucher.id, voucher.voucherNumber)}>{copy.actions.delete}</button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="pagination">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPage(Math.max(1, page - 1))} disabled={page === 1}>
            Previous
          </button>
          <span className="text-muted text-small">Page {page} of {totalPages}</span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPage(Math.min(totalPages, page + 1))} disabled={page === totalPages}>
            Next
          </button>
        </div>
      )}
    </div>
  );
};
