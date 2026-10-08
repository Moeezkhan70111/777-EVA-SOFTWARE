import React, { useCallback, useEffect, useRef, useState } from "react";
import type { AppRoute } from "../app/routes";
import { useDesktopApi } from "../hooks/useDesktopApi";
import type { CashVoucher, Party } from "../types/desktopApi";
import { useNotifications } from "../state/NotificationsContext";
import { CashVoucherPartyTable } from "../components/CashVoucherPartyTable";
import { copy } from "../config/copy";
import { toIsoDate } from "../utils/dates";
import { formatWholeMoney } from "../app/format";

interface CashVoucherFormPageProps {
  voucherId?: string;
  onNavigate: (route: AppRoute) => void;
}

const today = () => toIsoDate();
const fmtNum = formatWholeMoney;

interface VoucherLine {
  id: string;
  partyId: string;
  partyName: string;
  description: string;
  modeOfTransfer: string;
  bankAccountTitle: string;
  chequeNumber: string;
  chequeDate: string;
  onlineFrom: string;
  onlineTo: string;
  referenceNo: string;
  receiptAmount: string;
  paymentAmount: string;
}

const visibleTransferColumns: Array<{ key: string; label: string }> = [];
const getTransferFieldLabel = (_mode: string) => "Description";
const getTransferColumnCount = (_mode: string) => 1;

// ─── Party Search Dropdown ────────────────────────────────────────────────────
const PartySearch: React.FC<{
  parties: Party[];
  selectedPartyId: string;
  selectedPartyName: string;
  onSelect: (id: string, name: string) => void;
  disabled?: boolean;
}> = ({ parties, selectedPartyId, selectedPartyName, onSelect, disabled }) => {
  const [search, setSearch] = useState(selectedPartyName);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSearch(selectedPartyName);
  }, [selectedPartyName]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        // Reset to selected name if user didn't pick
        setSearch(selectedPartyName);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [selectedPartyName]);

  const filtered = search.trim()
    ? parties.filter((p) => p.partyName.toLowerCase().includes(search.toLowerCase()))
    : parties;

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <input
        type="text"
        className="form-input"
        value={search}
        disabled={disabled}
        placeholder="Search party..."
        onChange={(e) => { setSearch(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        style={{ width: "100%", boxSizing: "border-box" }}
      />
      {open && filtered.length > 0 && (
        <div style={{
          position: "absolute", top: "100%", left: 0, right: 0, zIndex: 999,
          background: "var(--white)", border: "1px solid #d1d5db", borderRadius: "6px",
          boxShadow: "0 4px 16px rgba(0,0,0,0.12)", maxHeight: "220px", overflowY: "auto",
        }}>
          {filtered.map((p) => (
            <div
              key={p.id}
              style={{
                padding: "8px 12px", cursor: "pointer", fontSize: "13px",
                background: p.id === selectedPartyId ? "var(--accent-soft)" : undefined,
                borderBottom: "1px solid var(--neutral-100)",
              }}
              onMouseDown={() => {
                onSelect(p.id, p.partyName);
                setSearch(p.partyName);
                setOpen(false);
              }}
            >
              <span style={{ fontWeight: 600 }}>{p.partyName}</span>
              {p.city && <span style={{ color: "var(--chrome-muted)", marginLeft: 8, fontSize: "11px" }}>{p.city}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ─── Main Component ───────────────────────────────────────────────────────────
export const CashVoucherFormPage: React.FC<CashVoucherFormPageProps> = ({ voucherId, onNavigate }) => {
  const api = useDesktopApi();
  const { push } = useNotifications();

  // ── form state ──
  const [voucherNumber, setVoucherNumber] = useState<number>(0);
  const [voucherDate, setVoucherDate] = useState<string>(today());
  const [partyId, setPartyId] = useState<string>("");
  const [partyName, setPartyName] = useState<string>("");
  const [description, setDescription] = useState<string>("");
  const [receiptAmount, setReceiptAmount] = useState<string>("");
  const [paymentAmount, setPaymentAmount] = useState<string>("");
  const [voucherLines, setVoucherLines] = useState<VoucherLine[]>([]);
  const [partyBalances, setPartyBalances] = useState<Record<string, number>>({});

  // ── UI state ──
  const [parties, setParties] = useState<Party[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [currentId, setCurrentId] = useState<string | undefined>(voucherId);
  const [maxVoucherNumber, setMaxVoucherNumber] = useState<number>(1);

  const voucherNumInputRef = useRef<HTMLInputElement>(null);
  const partyFieldRefs = useRef<Record<string, HTMLSelectElement | null>>({});

  const updateLine = (lineId: string, changes: Partial<VoucherLine>) => {
    setVoucherLines((lines) => lines.map((line) => line.id === lineId ? { ...line, ...changes } : line));
  };

  const handleLineModeChange = (lineId: string, modeOfTransfer: string) => {
    const resetDetails = {
      modeOfTransfer,
      bankAccountTitle: "",
      chequeNumber: "",
      chequeDate: "",
      onlineFrom: "",
      onlineTo: "",
      referenceNo: "",
    };
    updateLine(lineId, resetDetails);
  };

  const addPartyRow = useCallback(() => {
    const id = crypto.randomUUID();
    setVoucherLines((lines) => [...lines, {
      id,
      partyId: "",
      partyName: "",
      description: "",
      modeOfTransfer: "Cash",
      bankAccountTitle: "",
      chequeNumber: "",
      chequeDate: "",
      onlineFrom: "",
      onlineTo: "",
      referenceNo: "",
      receiptAmount: "",
      paymentAmount: "",
    }]);
    window.setTimeout(() => partyFieldRefs.current[id]?.focus(), 0);
  }, []);

  const handlePartyRowKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    event.stopPropagation();

    const row = event.currentTarget.closest("tr");
    if (!(row instanceof HTMLTableRowElement)) return;
    const fields = Array.from(row.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, select"));
    const currentFieldIndex = fields.indexOf(event.currentTarget as HTMLInputElement | HTMLSelectElement);
    const nextField = fields[currentFieldIndex + 1];

    if (nextField) {
      nextField.focus();
      return;
    }

    addPartyRow();
  };

  // ─── Load parties and init ────────────────────────────────────────────────
  useEffect(() => {
    void loadParties();
    if (voucherId) {
      void loadVoucher(voucherId);
    } else {
      void loadNextNumber();
    }
  }, [voucherId]);

  const loadParties = async () => {
    try {
      const result = await api.listParties({ status: "ACTIVE", pageSize: 1000 });
      setParties(result.rows);
    } catch {
      push("error", copy.toast.error, "Failed to load parties");
    }
  };

  const loadNextNumber = async () => {
    try {
      const num = await api.getNextCashVoucherNumber();
      setVoucherNumber(num);
      setMaxVoucherNumber(num);
      setVoucherLines([{ id: `new-${Date.now()}`, partyId: "", partyName: "", description: "", modeOfTransfer: "Cash", bankAccountTitle: "", chequeNumber: "", chequeDate: "", onlineFrom: "", onlineTo: "", referenceNo: "", receiptAmount: "", paymentAmount: "" }]);
    } catch {
      setVoucherNumber(1);
    }
  };

  const loadVoucher = async (id: string) => {
    setLoading(true);
    try {
      const v = await api.getCashVoucher(id);
      if (v) applyVoucher(v);
      else push("error", copy.toast.notFound, "Voucher not found");
    } catch {
      push("error", copy.toast.error, "Failed to load voucher");
    } finally {
      setLoading(false);
    }
  };

  const applyVoucher = (v: CashVoucher) => {
    setCurrentId(v.id);
    setVoucherNumber(v.voucherNumber);
    setVoucherDate(v.voucherDate);
    setPartyId(v.partyId);
    setPartyName(v.partyName);
    setDescription(v.description);
    setVoucherLines(v.lines?.map((line, index) => ({
      id: `${line.partyId}-${index}`,
      partyId: line.partyId,
      partyName: line.partyName,
      description: line.description,
      modeOfTransfer: line.modeOfTransfer ?? "Cash",
      bankAccountTitle: line.bankAccountTitle ?? "",
      chequeNumber: line.chequeNumber ?? "",
      chequeDate: line.chequeDate ?? "",
      onlineFrom: line.onlineFrom ?? "",
      onlineTo: line.onlineTo ?? "",
      referenceNo: line.referenceNo ?? "",
      receiptAmount: line.receiptAmount ? String(line.receiptAmount) : "",
      paymentAmount: line.paymentAmount ? String(line.paymentAmount) : "",
    })) ?? [{
      id: "legacy",
      partyId: v.partyId,
      partyName: v.partyName,
      description: v.description,
      modeOfTransfer: v.modeOfTransfer ?? "Cash",
      bankAccountTitle: "",
      chequeNumber: "",
      chequeDate: "",
      onlineFrom: "",
      onlineTo: "",
      referenceNo: "",
      receiptAmount: v.receiptAmount ? String(v.receiptAmount) : "",
      paymentAmount: v.paymentAmount ? String(v.paymentAmount) : "",
    }]);
    setReceiptAmount(String(v.receiptAmount));
    setPaymentAmount(String(v.paymentAmount));
  };

  // ─── Navigation: prev / next / load ──────────────────────────────────────
  const navigateToNumber = async (num: number) => {
    if (num < 1) return;
    setLoading(true);
    try {
      const v = await api.getCashVoucherByNumber(num);
      if (v) {
        applyVoucher(v);
      } else {
        push("info", copy.toast.notFound, `Cash voucher #${num} does not exist`);
      }
    } catch {
      push("error", copy.toast.error, "Failed to load voucher");
    } finally {
      setLoading(false);
    }
  };

  const handlePrev = () => navigateToNumber(voucherNumber - 1);
  const handleNext = () => navigateToNumber(voucherNumber + 1);

  const handleLoad = async () => {
    const num = parseInt(String(voucherNumber));
    if (!num || num < 1) return;
    await navigateToNumber(num);
  };

  // ─── Save ─────────────────────────────────────────────────────────────────
  const handleSave = async () => {
    const populatedLines = voucherLines.filter((line) =>
      line.partyId ||
      line.description.trim() ||
      line.bankAccountTitle.trim() ||
      line.chequeNumber.trim() ||
      line.chequeDate ||
      line.onlineFrom.trim() ||
      line.onlineTo.trim() ||
      line.referenceNo.trim() ||
      line.receiptAmount ||
      line.paymentAmount
    );
    if (voucherNumber < 1 || !voucherDate || !populatedLines.length) { push("error", copy.toast.validation, "Voucher number, date, and at least one party row are required"); return; }
    if (populatedLines.some((line) => !line.partyId || !line.modeOfTransfer || (Number(line.receiptAmount) <= 0 && Number(line.paymentAmount) <= 0) || (Number(line.receiptAmount) > 0 && Number(line.paymentAmount) > 0))) {
      push("error", copy.toast.validation, "Each party row needs a party, payment mode, and either a receipt or payment amount"); return;
    }
    const normalizedLines = populatedLines.map((line) => ({
      partyId: line.partyId,
      description: line.description.trim(),
      modeOfTransfer: line.modeOfTransfer || "Cash",
      bankAccountTitle: line.bankAccountTitle,
      chequeNumber: line.chequeNumber,
      chequeDate: line.chequeDate,
      onlineFrom: line.onlineFrom,
      onlineTo: line.onlineTo,
      referenceNo: line.referenceNo,
      receiptAmount: Number(line.receiptAmount) || 0,
      paymentAmount: Number(line.paymentAmount) || 0,
    }));
    const firstLine = normalizedLines[0];

    setSaving(true);
    try {
      if (currentId) {
        // Update existing
        const result = await api.updateCashVoucher(currentId, {
          partyId: firstLine.partyId,
          voucherDate,
          modeOfTransfer: firstLine.modeOfTransfer,
          description: description.trim(),
          receiptAmount: firstLine.receiptAmount,
          paymentAmount: firstLine.paymentAmount,
          lines: normalizedLines,
        });
        if (result.accepted) {
          push("success", copy.toast.updated, `Cash voucher #${voucherNumber} updated`);
        } else {
          push("error", copy.toast.failed, result.reason ?? "Update failed");
        }
      } else {
        // Create new
        const result = await api.createCashVoucher({
          partyId: firstLine.partyId,
          voucherDate,
          modeOfTransfer: firstLine.modeOfTransfer,
          description: description.trim(),
          receiptAmount: firstLine.receiptAmount,
          paymentAmount: firstLine.paymentAmount,
          lines: normalizedLines,
        });
        if (result.accepted && result.voucherId) {
          push("success", copy.toast.saved, `Cash voucher #${voucherNumber} created`);
          setCurrentId(result.voucherId);
          // Prepare next blank voucher
          const nextNum = await api.getNextCashVoucherNumber();
          setMaxVoucherNumber(nextNum);
        } else {
          push("error", copy.toast.failed, result.reason ?? "Create failed");
        }
      }
    } catch {
      push("error", copy.toast.error, "Failed to save voucher");
    } finally {
      setSaving(false);
    }
  };

  // ─── New blank voucher ─────────────────────────────────────────────────────
  const handleNew = async () => {
    const nextNum = await api.getNextCashVoucherNumber();
    setCurrentId(undefined);
    setVoucherNumber(nextNum);
    setMaxVoucherNumber(nextNum);
    setVoucherDate(today());
    setPartyId("");
    setPartyName("");
    setDescription("");
    setVoucherLines([{ id: `new-${Date.now()}`, partyId: "", partyName: "", description: "", modeOfTransfer: "Cash", bankAccountTitle: "", chequeNumber: "", chequeDate: "", onlineFrom: "", onlineTo: "", referenceNo: "", receiptAmount: "", paymentAmount: "" }]);
    setReceiptAmount("");
    setPaymentAmount("");
  };

  // ─── Delete ───────────────────────────────────────────────────────────────
  const handleDelete = async () => {
    if (!currentId) return;
    if (!window.confirm(`Delete cash voucher #${voucherNumber}? This cannot be undone.`)) return;
    try {
      const result = await api.deleteCashVoucher(currentId);
      if (result.accepted) {
        push("success", copy.toast.deleted, `Cash voucher #${voucherNumber} deleted`);
        await handleNew();
      } else {
        push("error", copy.toast.failed, result.reason ?? "Delete failed");
      }
    } catch {
      push("error", copy.toast.error, "Failed to delete voucher");
    }
  };

  const handleLinePartyChange = async (lineId: string, nextPartyId: string) => {
    const nextParty = parties.find((party) => party.id === nextPartyId);
    setVoucherLines((lines) => lines.map((line) => line.id === lineId ? { ...line, partyId: nextPartyId, partyName: nextParty?.partyName ?? "" } : line));
    if (nextPartyId) {
      const balance = await api.getCurrentPartyBalance(nextPartyId);
      setPartyBalances((current) => ({ ...current, [nextPartyId]: balance }));
    }
  };

  const isExisting = Boolean(currentId);

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="cash-voucher-page" style={{ display: "flex", flexDirection: "column", height: "100vh", background: "var(--surface-2)", overflow: "hidden" }}>

      {/* ── Top Bar ── */}
      <div className="cash-voucher-topbar" style={{
        background: "var(--chrome-ink)", color: "var(--white)",
        padding: "0 20px",
        display: "flex", alignItems: "center", gap: "12px",
        height: "52px", flexShrink: 0,
        boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
      }}>
        <button
          onClick={() => onNavigate("cash-voucher-list")}
          style={{
            background: "transparent", border: "1px solid var(--neutral-600)",
            color: "var(--neutral-400)", borderRadius: "6px",
            padding: "5px 12px", cursor: "pointer", fontSize: "12px",
          }}
        >
          ← Back
        </button>

        <span style={{ fontSize: "13px", color: "var(--chrome-muted)" }}>Billing</span>
        <span style={{ color: "var(--neutral-600)" }}>/</span>
        <span style={{ fontSize: "14px", fontWeight: 600, color: "var(--neutral-200)" }}>Cash Voucher</span>

        <div style={{ flex: 1 }} />

        {/* voucher number + nav */}
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <button
            onClick={handlePrev}
            disabled={loading || voucherNumber <= 1}
            title="Previous voucher"
            style={{
              background: "var(--neutral-700)", border: "none", color: "var(--neutral-200)",
              borderRadius: "5px", padding: "5px 10px", cursor: "pointer",
              fontSize: "14px", opacity: voucherNumber <= 1 ? 0.4 : 1,
            }}
          >
            ‹
          </button>

          <input
            ref={voucherNumInputRef}
            type="number"
            value={voucherNumber}
            onChange={(e) => setVoucherNumber(parseInt(e.target.value) || 1)}
            onBlur={handleLoad}
            onKeyDown={(e) => { if (e.key === "Enter") void handleLoad(); }}
            style={{
              width: "72px", textAlign: "center",
              background: "#0f172a", border: "1px solid var(--neutral-600)",
              color: "#fbbf24", borderRadius: "6px",
              padding: "5px 8px", fontSize: "15px", fontWeight: 700,
            }}
          />

          <button
            onClick={handleNext}
            disabled={loading}
            title="Next voucher"
            style={{
              background: "var(--neutral-700)", border: "none", color: "var(--neutral-200)",
              borderRadius: "5px", padding: "5px 10px", cursor: "pointer", fontSize: "14px",
            }}
          >
            ›
          </button>

          <button
            onClick={handleLoad}
            disabled={loading}
            style={{
              background: "var(--neutral-700)", border: "none", color: "var(--neutral-200)",
              borderRadius: "5px", padding: "5px 12px", cursor: "pointer", fontSize: "12px",
            }}
          >
            Load
          </button>
        </div>

        <div style={{ width: "1px", height: "28px", background: "var(--neutral-700)" }} />

        <button
          onClick={handleNew}
          style={{
            background: "var(--neutral-700)", border: "1px solid var(--neutral-600)",
            color: "var(--neutral-200)", borderRadius: "6px",
            padding: "6px 14px", cursor: "pointer", fontSize: "12px",
          }}
        >
          + New
        </button>

        <button
          onClick={() => void handleSave()}
          disabled={saving || loading}
          style={{
            background: saving ? "var(--accent-strong)" : "var(--accent)",
            border: "none", color: "var(--white)", borderRadius: "6px",
            padding: "6px 18px", cursor: "pointer", fontSize: "13px",
            fontWeight: 600, opacity: saving ? 0.7 : 1,
          }}
        >
          {saving ? "Saving…" : (isExisting ? "Update" : "Save")}
        </button>

        {isExisting && (
          <button
            onClick={() => void handleDelete()}
            style={{
              background: "transparent", border: "1px solid #991b1b",
              color: "#fca5a5", borderRadius: "6px",
              padding: "5px 12px", cursor: "pointer", fontSize: "12px",
            }}
          >{copy.actions.delete}</button>
        )}
      </div>

      {/* ── Body ── */}
      <div className="cash-voucher-body" style={{
        flex: 1, overflowY: "auto", padding: "24px",
        display: "flex", flexDirection: "column", gap: "20px",
      }}>

        {loading && (
          <div style={{ textAlign: "center", color: "var(--chrome-muted)", padding: "40px" }}>{copy.common.loading}</div>
        )}

        {!loading && (
          <>
            {/* ── Header Card ── */}
            <div className="cash-voucher-card cash-voucher-header-card" style={{
              background: "var(--white)", borderRadius: "10px",
              boxShadow: "0 1px 4px rgba(0,0,0,0.08)",
              padding: "20px 24px",
            }}>
              <div style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr 1fr",
                gap: "16px",
                alignItems: "end",
              }}>

                {/* Voucher No. */}
                <div>
                  <label style={{ display: "block", fontSize: "12px", color: "var(--chrome-muted)", marginBottom: "5px", fontWeight: 600 }}>
                    Voucher No. *
                  </label>
                  <input type="text" className="form-input" value={String(voucherNumber).padStart(5, "0")} readOnly style={{ width: "100%", boxSizing: "border-box" }} />
                </div>

                {/* Date */}
                <div>
                  <label style={{ display: "block", fontSize: "12px", color: "var(--chrome-muted)", marginBottom: "5px", fontWeight: 600 }}>
                    Date *
                  </label>
                  <input
                    type="date"
                    className="form-input"
                    value={voucherDate}
                    onChange={(e) => setVoucherDate(e.target.value)}
                    style={{ width: "100%", boxSizing: "border-box" }}
                  />
                </div>

                {/* Remarks */}
                <div>
                  <label style={{ display: "block", fontSize: "12px", color: "var(--chrome-muted)", marginBottom: "5px", fontWeight: 600 }}>
                    Remarks (optional)
                  </label>
                  <input
                    type="text"
                    className="form-input"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Enter remarks..."
                    style={{ width: "100%", boxSizing: "border-box" }}
                  />
                </div>
              </div>
            </div>

            {/* ── Amount Card ── */}
            <div className="cash-voucher-card cash-voucher-amount-card" style={{
              background: "var(--white)", borderRadius: "10px",
              boxShadow: "0 1px 4px rgba(0,0,0,0.08)",
              padding: "24px",
            }}>
              <div className="cash-voucher-section-title">Parties <button type="button" className="cash-add-party" onClick={addPartyRow}>+ Add Party</button></div>
              <CashVoucherPartyTable lines={voucherLines} parties={parties} partyFieldRefs={partyFieldRefs} onPartyChange={handleLinePartyChange} onModeChange={handleLineModeChange} onUpdate={updateLine} onKeyDown={handlePartyRowKeyDown} onDelete={(lineId) => setVoucherLines((lines) => lines.filter((line) => line.id !== lineId))} />
              <div className="cash-party-table-legacy"><table className="cash-party-table"><thead><tr><th>#</th><th>Party *</th><th>Mode of Payment</th>{visibleTransferColumns.map((column) => <th key={column.key}>{column.label}</th>)}<th>Receipt Amount (Rs.)</th><th>Payment Amount (Rs.)</th><th>Ledger Balance (Rs.)</th><th>Action</th></tr></thead><tbody>{voucherLines.map((line, index) => {
                const party = parties.find((item) => item.id === line.partyId);
                const balance = party ? (partyBalances[party.id] ?? 0) : 0;
                const mode = line.modeOfTransfer || "Cash";
                const transferLabel = getTransferFieldLabel(mode);
                const isBankTransfer = mode === "Bank Transfer";
                const isCheque = mode === "Cheque";
                const isOnline = mode === "Online Transfer";
                return <tr key={line.id}><td>{index + 1}</td><td><select ref={(element) => { partyFieldRefs.current[line.id] = element; }} value={line.partyId} onChange={(event) => void handleLinePartyChange(line.id, event.target.value)} onKeyDown={handlePartyRowKeyDown}><option value="">Select party...</option>{parties.map((item) => <option key={item.id} value={item.id}>{item.partyName}</option>)}</select></td><td><select value={mode} onChange={(event) => setVoucherLines((lines) => lines.map((item) => item.id === line.id ? { ...item, modeOfTransfer: event.target.value } : item))} onKeyDown={handlePartyRowKeyDown}><option>Cash</option><option>Bank Transfer</option><option>Cheque</option><option>Online Transfer</option><option>Other</option></select></td>{isBankTransfer ? <><td><input value={line.bankAccountTitle} placeholder="Bank/Acc Title" onChange={(event) => setVoucherLines((lines) => lines.map((item) => item.id === line.id ? { ...item, bankAccountTitle: event.target.value } : item))} onKeyDown={handlePartyRowKeyDown} /></td><td><input value={line.description} placeholder={copy.columns.description} onChange={(event) => setVoucherLines((lines) => lines.map((item) => item.id === line.id ? { ...item, description: event.target.value } : item))} onKeyDown={handlePartyRowKeyDown} /></td></> : isCheque ? <><td><input value={line.bankAccountTitle} placeholder="Bank/Acc Title" onChange={(event) => setVoucherLines((lines) => lines.map((item) => item.id === line.id ? { ...item, bankAccountTitle: event.target.value } : item))} onKeyDown={handlePartyRowKeyDown} /></td><td><input value={line.chequeNumber} placeholder="Chq no" onChange={(event) => setVoucherLines((lines) => lines.map((item) => item.id === line.id ? { ...item, chequeNumber: event.target.value } : item))} onKeyDown={handlePartyRowKeyDown} /></td><td><input type="date" value={line.chequeDate} onChange={(event) => setVoucherLines((lines) => lines.map((item) => item.id === line.id ? { ...item, chequeDate: event.target.value } : item))} onKeyDown={handlePartyRowKeyDown} /></td></> : isOnline ? <><td><input value={line.onlineFrom} placeholder="From" onChange={(event) => setVoucherLines((lines) => lines.map((item) => item.id === line.id ? { ...item, onlineFrom: event.target.value } : item))} onKeyDown={handlePartyRowKeyDown} /></td><td><input value={line.onlineTo} placeholder="To" onChange={(event) => setVoucherLines((lines) => lines.map((item) => item.id === line.id ? { ...item, onlineTo: event.target.value } : item))} onKeyDown={handlePartyRowKeyDown} /></td><td><input value={line.referenceNo} placeholder="Reference no" onChange={(event) => setVoucherLines((lines) => lines.map((item) => item.id === line.id ? { ...item, referenceNo: event.target.value } : item))} onKeyDown={handlePartyRowKeyDown} /></td></> : <td><input value={line.description} placeholder="Enter description..." onChange={(event) => setVoucherLines((lines) => lines.map((item) => item.id === line.id ? { ...item, description: event.target.value } : item))} onKeyDown={handlePartyRowKeyDown} /></td>}<td><input type="number" min="0" value={line.receiptAmount} placeholder="0.00" onChange={(event) => setVoucherLines((lines) => lines.map((item) => item.id === line.id ? { ...item, receiptAmount: event.target.value, paymentAmount: "" } : item))} onKeyDown={handlePartyRowKeyDown} /></td><td><input type="number" min="0" value={line.paymentAmount} placeholder="0.00" onChange={(event) => setVoucherLines((lines) => lines.map((item) => item.id === line.id ? { ...item, paymentAmount: event.target.value, receiptAmount: "" } : item))} onKeyDown={handlePartyRowKeyDown} /></td><td className={balance > 0 ? "cash-balance-credit" : "cash-balance-empty"}>{balance !== 0 ? `Rs. ${fmtNum(Math.abs(balance))} ${balance > 0 ? "Dr" : "Cr"}` : "-"}</td><td><button type="button" className="cash-delete-line" title={copy.actions.removeRow} onClick={() => setVoucherLines((lines) => lines.filter((item) => item.id !== line.id))}>✕</button></td></tr>;
              })}<tr className="cash-party-total"><td colSpan={3 + getTransferColumnCount(voucherLines[0]?.modeOfTransfer ?? "Cash")}>{copy.columns.total}</td><td>Rs. {fmtNum(voucherLines.reduce((sum, line) => sum + (Number(line.receiptAmount) || 0), 0))}</td><td>Rs. {fmtNum(voucherLines.reduce((sum, line) => sum + (Number(line.paymentAmount) || 0), 0))}</td><td colSpan={2}>-</td></tr></tbody></table></div>
            </div>

          </>
        )}
      </div>
    </div>
  );
};
