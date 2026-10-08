import React, { useEffect, useState } from "react";
import type { AppRoute } from "../app/routes";
import { useDesktopApi } from "../hooks/useDesktopApi";
import type { Party } from "../types/desktopApi";
import { useNotifications } from "../state/NotificationsContext";
import { copy } from "../config/copy";
import { toIsoDate } from "../utils/dates";
import { formatWholeMoney } from "../app/format";
import { SearchableCombobox as ItemCombobox } from "../components/shared/SearchableCombobox";

interface PurchaseVoucherFormPageProps {
  voucherId?: string;
  onNavigate: (route: AppRoute) => void;
}

type AnyRow = Record<string, unknown>;

const todayStr = () => toIsoDate();
const fmtNum   = formatWholeMoney;

interface PurchaseLine {
  key:       string;
  itemId:    string;
  unitCode:  string;
  costPrice: number | null;
  quantity:  string;
  unitPrice: string;
}

const emptyLine = (): PurchaseLine => ({
  key: crypto.randomUUID(), itemId: "", unitCode: "",
  costPrice: null, quantity: "", unitPrice: "",
});

// ─── Page ─────────────────────────────────────────────────────────────────────
export const PurchaseVoucherFormPage: React.FC<PurchaseVoucherFormPageProps> = ({
  voucherId,
  onNavigate,
}) => {
  const api        = useDesktopApi();
  const { push }   = useNotifications();

  const [suppliers,     setSuppliers]     = useState<Party[]>([]);
  const [items,         setItems]         = useState<AnyRow[]>([]);
  const [partyId,       setPartyId]       = useState("");
  const [voucherDate,   setVoucherDate]   = useState(todayStr());
  const [referenceNo,   setReferenceNo]   = useState("");
  const [bookNo,        setBookNo]        = useState("");
  const [remarks,       setRemarks]       = useState("");
  const [voucherNumber, setVoucherNumber] = useState("");
  const [lines,         setLines]         = useState<PurchaseLine[]>([emptyLine()]);
  const [loading,       setLoading]       = useState(false);
  const [submitted,     setSubmitted]     = useState(false);

  // ── load lookups ────────────────────────────────────────────────────────────
  useEffect(() => {
    void (async () => {
      try {
        const [partyResult, itemRows] = await Promise.all([
          api.listParties({ pageSize: 1000 }),
          api.listInventoryItems({}),
        ]);
        setSuppliers(partyResult.rows.filter((p) => p.partyType === "SUPPLIER"));
        setItems(itemRows);
        if (itemRows.length === 0) {
          push("info", "No Raw Materials", "Create raw materials first on the Add Raw Material page.");
        }
      } catch (err) {
        push("error", copy.toast.loadFailed, err instanceof Error ? err.message : "Could not load");
      }
    })();
  }, [api, push]);

  // ── new voucher number ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!voucherId) {
      void api.getNextPurchaseVoucherNumber()
        .then(setVoucherNumber)
        .catch(() => setVoucherNumber("1"));
    }
  }, [voucherId, api]);

  // ── load existing for edit ──────────────────────────────────────────────────
  useEffect(() => {
    if (!voucherId) return;
    setLoading(true);
    void api.getPurchaseVoucher(voucherId).then((v) => {
      if (!v) return;
      setVoucherNumber(v.voucherNumber);
      setPartyId(v.partyId);
      setVoucherDate(v.voucherDate);
      setReferenceNo(v.referenceNo ?? "");
      setBookNo(v.bookNo ?? "");
      setRemarks(v.remarks ?? "");
      setLines(
        v.lineItems.map((li) => ({
          key:       li.id,
          itemId:    li.itemId,
          unitCode:  li.unitCode ?? "",
          costPrice: li.costPrice ?? null,
          quantity:  String(li.quantity),
          unitPrice: String(li.unitPrice),
        })),
      );
    }).finally(() => setLoading(false));
  }, [voucherId, api]);

  // ── item options ────────────────────────────────────────────────────────────
  const itemOptions = items
    .filter((item) => item.id && item.display_name)
    .map((item) => ({
      value: String(item.id),
      label: [item.item_code, item.display_name].filter(Boolean).join(" — "),
    }));

  // ── line helpers ────────────────────────────────────────────────────────────
  const removeLine  = (key: string) =>
    setLines((prev) => prev.length === 1 ? [emptyLine()] : prev.filter((l) => l.key !== key));

  const updateLine  = (key: string, patch: Partial<PurchaseLine>) =>
    setLines((prev) => prev.map((l) => l.key === key ? { ...l, ...patch } : l));

  const selectItem  = (key: string, itemId: string) => {
    const item = items.find((i) => String(i.id) === itemId);
    if (!item) { updateLine(key, { itemId: "", unitCode: "" }); return; }
    updateLine(key, {
      itemId,
      unitCode:  String(item.unit_code ?? ""),
      costPrice: item.cost_price == null ? null : Number(item.cost_price),
      unitPrice: item.cost_price != null ? String(item.cost_price) : "",
    });
  };

  /** Append a blank row if the last line now has an item selected */
  const ensureTrailingBlank = () => {
    setLines((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.itemId !== "") return [...prev, emptyLine()];
      return prev;
    });
  };

  // ── totals ──────────────────────────────────────────────────────────────────
  const totalQuantity = lines.reduce((s, l) => s + (Number(l.quantity) || 0), 0);
  const totalAmount   = lines.reduce(
    (s, l) => s + (Number(l.quantity) || 0) * (Number(l.unitPrice) || 0), 0,
  );

  // ── save ────────────────────────────────────────────────────────────────────
  const save = async () => {
    setSubmitted(true);
    if (!partyId) { push("error", copy.toast.required, "Select a supplier"); return; }
    const validLines = lines.filter((l) => l.itemId && Number(l.quantity) > 0);
    if (validLines.length === 0) {
      push("error", copy.toast.required, "Add at least one item with quantity");
      return;
    }
    setLoading(true);
    try {
      const payload = {
        partyId, voucherDate, bookNo, referenceNo, remarks, voucherNumber,
        lines: validLines.map((l) => ({
          itemId:    l.itemId,
          quantity:  Number(l.quantity),
          unitPrice: Number(l.unitPrice) || 0,
        })),
      };
      const result = voucherId
        ? await api.updatePurchaseVoucher(voucherId, payload)
        : await api.createPurchaseVoucher(payload);
      if (!result.accepted) { push("error", copy.toast.failed, result.reason ?? "Could not save"); return; }
      push("success", voucherId ? "Updated" : "Saved", `Purchase bill #${voucherNumber} saved`);
      onNavigate("purchase-voucher-list");
    } finally {
      setLoading(false);
    }
  };

  if (loading && voucherId) return <div className="page loading">Loading voucher…</div>;

  // ── render ──────────────────────────────────────────────────────────────────
  return (
    <div className="page pv-page">

      {/* Header */}
      <div className="page-header">
        <div>
          <h1>{voucherId ? "Edit Purchase Bill" : "New Purchase Bill"}</h1>
          <p>Record a supplier bill for raw materials.</p>
        </div>
        <button type="button" className="party-back-link" onClick={() => onNavigate("purchase-voucher-list")}>
          <span aria-hidden="true">←</span> Back to List
        </button>
      </div>

      {/* Bill info card */}
      <div className="form-card pv-info-card">
        <div className="form-card-title">Bill Information</div>
        <div className="form-row">
          <div className="form-group">
            <label className="input-label">Bill #</label>
            <input className="form-input" value={voucherNumber} readOnly aria-readonly="true" />
          </div>

          <div className="form-group" style={{ minWidth: 220 }}>
            <label className="input-label">{copy.columns.supplier}<span className="required-mark">*</span></label>
            {/* Reuse the same fixed-dropdown combobox for supplier too */}
            <ItemCombobox
              value={partyId}
              options={suppliers.map((p) => ({ value: p.id, label: p.partyName }))}
              placeholder="Select supplier…"
              onChange={setPartyId}
            />
            {submitted && !partyId && <span className="error-message">Required</span>}
          </div>

          <div className="form-group">
            <label className="input-label">{copy.columns.date}</label>
            <input type="date" className="form-input" value={voucherDate}
              onChange={(e) => setVoucherDate(e.target.value)} />
          </div>

          <div className="form-group" style={{gridRowStart: 2}}>
            <label className="input-label">Reference / Invoice #</label>
            <input className="form-input" value={referenceNo}
              onChange={(e) => setReferenceNo(e.target.value)} placeholder="Supplier invoice no." />
          </div>

          <div className="form-group" style={{gridRowStart: 2}}>
            <label className="input-label">Bill No</label>
            <input className="form-input" value={bookNo}
              onChange={(e) => setBookNo(e.target.value)} placeholder="Optional" />
          </div>

          <div className="form-group" style={{gridRowStart: 2}}>
            <label className="input-label">{copy.columns.remarks}</label>
            <input className="form-input" value={remarks}
              onChange={(e) => setRemarks(e.target.value)} placeholder="Optional" />
          </div>
        </div>
      </div>

      {/* Line items card */}
      <div className="form-card pv-lines-card">
        <div className="pv-lines-header">
          <div className="form-card-title" style={{ marginBottom: 0 }}>{copy.columns.items}</div>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setLines((p) => [...p, emptyLine()])}>
            + Add Row
          </button>
        </div>

        {itemOptions.length === 0 && (
          <div className="pv-no-materials-notice">
            No raw materials found. Go to <strong>Add Raw Material</strong> first.
          </div>
        )}

        {/* Column headers */}
        <div className="pv-line-grid pv-line-head">
          <span>Raw Material</span>
          <span style={{ textAlign: "right" }}>{copy.columns.qty}</span>
          <span>Unit</span>
          <span style={{ textAlign: "right" }}>Rate (Rs.)</span>
          <span style={{ textAlign: "right" }}>{copy.columns.amount}</span>
          <span />
        </div>

        {/* Line rows */}
        <div className="pv-lines-body">
          {lines.map((line, idx) => {
            const amount = (Number(line.quantity) || 0) * (Number(line.unitPrice) || 0);
            const isLast = idx === lines.length - 1;
            return (
              <div key={line.key} className="pv-line-grid pv-line-row">

                {/* Material combobox */}
                <ItemCombobox
                  value={line.itemId}
                  options={itemOptions}
                  placeholder={itemOptions.length === 0 ? "No materials yet" : "Search material…"}
                  emptyLabel="No materials found"
                  onChange={(val) => {
                    selectItem(line.key, val);
                    if (val && isLast) ensureTrailingBlank();
                  }}
                  onEnter={() => {
                    if (isLast && line.itemId) ensureTrailingBlank();
                  }}
                />

                {/* Qty */}
                <input
                  className="form-input pv-num-input"
                  type="number"
                  step="any"
                  value={line.quantity}
                  placeholder="0"
                  onChange={(e) => updateLine(line.key, { quantity: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && isLast && line.itemId) {
                      e.preventDefault();
                      ensureTrailingBlank();
                    }
                  }}
                />

                {/* Unit */}
                <span className="pv-unit-cell">
                  {line.unitCode || <span className="pv-unit-dash">—</span>}
                </span>

                {/* Rate */}
                <input
                  className="form-input pv-num-input"
                  type="number"
                  step="any"
                  value={line.unitPrice}
                  placeholder={line.costPrice != null ? String(line.costPrice) : "0"}
                  onChange={(e) => updateLine(line.key, { unitPrice: e.target.value })}
                />

                {/* Amount */}
                <span className="pv-amount-cell">
                  {amount > 0 ? fmtNum(amount) : <span className="pv-unit-dash">—</span>}
                </span>

                {/* Remove */}
                <button
                  type="button"
                  className="btn btn-ghost pv-remove-btn"
                  onClick={() => removeLine(line.key)}
                  aria-label={copy.actions.removeRow}
                  tabIndex={-1}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>

        {/* Totals footer */}
        <div className="pv-totals-row">
          <span />
          <span className="pv-total-label">{copy.columns.total}</span>
          <span className="pv-total-qty">{totalQuantity > 0 ? totalQuantity : "—"}</span>
          <span />
          <span className="pv-total-amount">Rs. {fmtNum(totalAmount)}</span>
          <span />
        </div>
      </div>

      {/* Actions */}
      <div className="pv-form-actions">
        <button type="button" className="btn btn-secondary"
          onClick={() => onNavigate("purchase-voucher-list")}>{copy.common.cancel}</button>
        <button type="button" className="btn btn-primary" disabled={loading}
          onClick={() => void save()}>
          {loading ? "Saving…" : voucherId ? "Update Bill" : "Save Bill"}
        </button>
      </div>
    </div>
  );
};
