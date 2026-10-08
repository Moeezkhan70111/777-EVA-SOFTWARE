import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppRoute } from "../app/routes";
import { useDesktopApi } from "../hooks/useDesktopApi";
import type { Gatepass, Party, SaleVoucher } from "../types/desktopApi";
import { useNotifications } from "../state/NotificationsContext";
import { copy } from "../config/copy";
import { toIsoDate } from "../utils/dates";
import { formatWholeMoney } from "../app/format";
import { openSaleVoucherPrintWindow } from "../utils/saleVoucherPrint";
import { GatepassLinkBanner, type GatepassLink } from "../features/billing/GatepassLinkBanner";
import { voucherDraftFromGatepass } from "../features/billing/gatepassToVoucher";
import type { BillLine } from "../features/billing/billLines";
import { priceLinesFromGatepass, priceSavedLines, useBillLines } from "../features/billing/useBillLines";
import { useVoucherList } from "../features/billing/useVoucherList";
import { BillLinesTable } from "../features/billing/BillLinesTable";
import { BillSummaryPanel, type BillHeaderFields } from "../features/billing/BillSummaryPanel";
import { VoucherNavigator } from "../features/billing/VoucherNavigator";
import { GatepassBillPicker } from "../features/billing/GatepassBillPicker";
import { StateView } from "../components/shared/StateView";
import { usePartyBalance } from "../features/parties/usePartyBalance";
import type { PartyFacts } from "../features/parties/PartyCard";

// The bill (sale voucher). Every bill is made from a gatepass: the desk opens the gatepass
// notice (or types its number), the party, date and lines fill in — one line per article +
// size, in dozens, at the party's rate less the party's discount — then checks, saves and
// prints. Nothing is written until Save. Saved bills are walked with ‹ ›.
//
//   Gatepass ──▶ draft lines (features/billing) ──▶ Save ──▶ sale voucher + dispatch session

interface SaleVoucherFormPageProps {
  voucherId?: string;
  /** Opened from a gatepass notice: pre-fill a new bill from it, or open the bill already made from it. */
  fromGatepassId?: string;
  /** Session token for the gatepass read (the main process authorises it). */
  token?: string;
  onNavigate: (route: AppRoute) => void;
}

const blankFields = (): BillHeaderFields => ({ voucherDate: toIsoDate(), bookNo: "", subPartyNameUrdu: "", remarks: "" });

export const SaleVoucherFormPage: React.FC<SaleVoucherFormPageProps> = ({ voucherId, fromGatepassId, token, onNavigate }) => {
  const api = useDesktopApi();
  const { push } = useNotifications();
  const vouchers = useVoucherList();

  const [voucherNumber, setVoucherNumber] = useState("");
  const [activeId, setActiveId] = useState<string | undefined>(voucherId);
  const [curIdx, setCurIdx] = useState(-1);
  const [partyId, setPartyId] = useState("");
  /** Name, code and city as the document carries them (a saved bill has only the name). */
  const [partySnapshot, setPartySnapshot] = useState<PartyFacts | null>(null);
  /** The party's master record, for the code, city and credit limit the document lacks. */
  const [partyMaster, setPartyMaster] = useState<Party | null>(null);
  const [fields, setFields] = useState<BillHeaderFields>(blankFields);
  /** The gatepass this bill is (being) made from; its status decides whether the bill may stand. */
  const [gatepassLink, setGatepassLink] = useState<GatepassLink | null>(null);
  /** Starts busy when something is to be opened, so the gatepass picker does not flash first. */
  const [loading, setLoading] = useState(Boolean(voucherId || fromGatepassId));
  const bill = useBillLines(partyId);
  const balance = usePartyBalance(partyId);

  /** The gatepass already opened on this mount, so StrictMode's double effect fills the form once. */
  const openedGatepassRef = useRef<string | null>(null);
  const hasBill = Boolean(activeId) || gatepassLink !== null;

  // ── the party's master record: code, city and credit limit ───────────────
  useEffect(() => {
    setPartyMaster(null);
    if (!partyId) return;
    let cancelled = false;
    void api.getParty(partyId).then((party) => {
      if (!cancelled && party) setPartyMaster(party);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [api, partyId]);

  const partyFacts = useMemo<PartyFacts | null>(() => {
    if (!partySnapshot) return null;
    return { partyName: partySnapshot.partyName, partyCode: partySnapshot.partyCode || partyMaster?.partyCode || "", city: partySnapshot.city ?? partyMaster?.city ?? null };
  }, [partySnapshot, partyMaster]);
  const balanceLimit = partyMaster?.balanceLimit ?? null;

  // ── one bill on screen ────────────────────────────────────────────────────
  // A saved bill's less follows the party's rules as they stand when it is opened.
  const showVoucher = async (voucher: SaleVoucher, index: number) => {
    const lines = await priceSavedLines(api, voucher.partyId, voucher.lineItems);
    setVoucherNumber(voucher.voucherNumber);
    setPartyId(voucher.partyId);
    setPartySnapshot({ partyName: voucher.partyName, partyCode: "" });
    setFields({ voucherDate: voucher.voucherDate, bookNo: voucher.bookNo ?? "", subPartyNameUrdu: voucher.subPartyNameUrdu ?? "", remarks: voucher.remarks ?? "" });
    setGatepassLink(voucher.gatepassId && voucher.gatepassCode ? { id: voucher.gatepassId, code: voucher.gatepassCode, status: voucher.gatepassStatus ?? "CREATED" } : null);
    bill.load(lines);
    setActiveId(voucher.id);
    setCurIdx(index);
  };

  const showDraft = (gatepass: Gatepass, lines: BillLine[], nextNumber: string, index: number) => {
    const draft = voucherDraftFromGatepass(gatepass);
    setVoucherNumber(nextNumber);
    setPartyId(draft.partyId);
    setPartySnapshot({ partyName: gatepass.partyName, partyCode: gatepass.partyCode, city: gatepass.partyCity });
    setFields({ voucherDate: draft.voucherDate, bookNo: "", subPartyNameUrdu: "", remarks: "" });
    setGatepassLink({ id: gatepass.id, code: gatepass.code, status: gatepass.status });
    bill.load(lines);
    setActiveId(undefined);
    setCurIdx(index);
  };

  /** Nothing on screen: the next bill starts from a gatepass number. */
  const showNew = (nextNumber: string | null, index: number) => {
    if (nextNumber !== null) setVoucherNumber(nextNumber);
    setPartyId("");
    setPartySnapshot(null);
    setFields(blankFields());
    setGatepassLink(null);
    bill.load([]);
    setActiveId(undefined);
    setCurIdx(index);
  };

  const loadVoucher = async (id: string, index?: number): Promise<SaleVoucher | null> => {
    setLoading(true);
    try {
      const voucher = await api.getSaleVoucher(id);
      if (!voucher) return null;
      await showVoucher(voucher, index ?? vouchers.ids.indexOf(id));
      return voucher;
    } catch {
      push("error", copy.toast.loadFailed, "Could not load voucher");
      return null;
    } finally {
      setLoading(false);
    }
  };

  // ── from a gatepass ───────────────────────────────────────────────────────
  // The bill already made from the gatepass opens; otherwise a new one is drafted from it.
  const openExistingBill = async (gatepassId: string): Promise<boolean> => {
    const existing = await api.findSaleVoucherByGatepass(gatepassId);
    if (!existing) return false;
    const snapshot = await vouchers.refresh();
    const voucher = await loadVoucher(existing.id, snapshot.ids.indexOf(existing.id));
    // The cancelled-gatepass banner says everything when that is the case.
    if (voucher?.gatepassStatus !== "CANCELLED") push("info", copy.billing.alreadyBilledTitle, copy.billing.alreadyBilledBody(existing.voucherNumber));
    return true;
  };

  const draftFromGatepass = async (gatepass: Gatepass) => {
    if (gatepass.status === "CANCELLED") {
      push("warning", copy.billing.gatepassCancelledTitle(gatepass.code), copy.billing.gatepassCancelledNoBill(gatepass.code));
      return;
    }
    const draft = voucherDraftFromGatepass(gatepass);
    const { lines, missingRate } = await priceLinesFromGatepass(api, draft.partyId, draft.lines);
    const snapshot = await vouchers.refresh();
    showDraft(gatepass, lines, snapshot.nextNumber, snapshot.ids.length);
    push("success", copy.billing.prefilledTitle(gatepass.code), copy.billing.prefilledBody(lines.length));
    if (missingRate.length > 0) push("warning", copy.billing.missingRateTitle, copy.billing.missingRateBody(missingRate.join(", ")), 10000);
  };

  const openFromGatepassId = async (gatepassId: string) => {
    setLoading(true);
    try {
      if (await openExistingBill(gatepassId)) return;
      const gatepass = await api.getGatepass(gatepassId, { token });
      if (!gatepass) { push("error", copy.toast.notFound, copy.billing.gatepassNotFound); return; }
      await draftFromGatepass(gatepass);
    } catch (err) {
      push("error", copy.toast.loadFailed, err instanceof Error ? err.message : "Could not open the gatepass");
    } finally {
      setLoading(false);
    }
  };

  const billGatepassNumber = async (gatepassNumber: number) => {
    setLoading(true);
    try {
      const gatepass = await api.getGatepassByNumber(gatepassNumber, { token });
      if (!gatepass) { push("error", copy.toast.notFound, copy.billing.gatepassNumberNotFound(gatepassNumber)); return; }
      if (await openExistingBill(gatepass.id)) return;
      await draftFromGatepass(gatepass);
    } catch (err) {
      push("error", copy.toast.loadFailed, err instanceof Error ? err.message : "Could not open the gatepass");
    } finally {
      setLoading(false);
    }
  };

  // ── on mount ──────────────────────────────────────────────────────────────
  // A gatepass notice takes its own path below (it refreshes the list itself).
  useEffect(() => {
    if (!voucherId && fromGatepassId) return;
    void (async () => {
      setLoading(true);
      try {
        const snapshot = await vouchers.refresh();
        if (voucherId) await loadVoucher(voucherId, snapshot.ids.indexOf(voucherId));
        else showNew(snapshot.nextNumber, snapshot.ids.length);
      } catch {
        push("error", copy.toast.loadFailed, "Could not load form data");
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voucherId]);

  useEffect(() => {
    if (!fromGatepassId || openedGatepassRef.current === fromGatepassId) return;
    openedGatepassRef.current = fromGatepassId;
    void openFromGatepassId(fromGatepassId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromGatepassId]);

  // ── navigation ────────────────────────────────────────────────────────────
  /** An unsaved draft with lines is not left silently. */
  const mayLeaveDraft = () => activeId || bill.lines.length === 0 || window.confirm(copy.billing.discardDraft);

  const goPrev = async () => {
    if (curIdx <= 0) { push("warning", copy.billing.firstVoucherTitle, copy.billing.firstVoucherBody); return; }
    if (!mayLeaveDraft()) return;
    await loadVoucher(vouchers.ids[curIdx - 1], curIdx - 1);
  };

  const goNext = async () => {
    if (!mayLeaveDraft()) return;
    const next = curIdx + 1;
    if (next < vouchers.ids.length) { await loadVoucher(vouchers.ids[next], next); return; }
    const snapshot = await vouchers.refresh();
    showNew(snapshot.nextNumber, snapshot.ids.length);
  };

  const goTo = async (number: string) => {
    if (!mayLeaveDraft()) return;
    setLoading(true);
    try {
      const found = await vouchers.findByNumber(number);
      if (!found) { push("error", copy.toast.notFound, copy.billing.voucherNotFound(number)); return; }
      await loadVoucher(found.id, found.index);
    } catch {
      push("error", copy.toast.error, "Search failed");
    } finally {
      setLoading(false);
    }
  };

  const printVoucher = async () => {
    if (!activeId) { push("warning", copy.billing.printVoucher, copy.billing.printNeedsSave); return; }
    const voucher = await api.getSaleVoucher(activeId).catch(() => null);
    if (!voucher) { push("error", copy.toast.loadFailed, "Could not load voucher"); return; }
    if (!openSaleVoucherPrintWindow(voucher)) push("error", copy.toast.popupBlocked, copy.common.popupBlocked);
  };

  // ── lines ─────────────────────────────────────────────────────────────────
  const changePriceType = async (index: number, priceType: BillLine["priceType"]) => {
    const derived = await bill.changePriceType(index, priceType);
    if (!derived && priceType === "B_TYPE") push("warning", copy.billing.priceTypeBType, copy.billing.bTypeUnavailable);
  };

  const removeLine = async (index: number) => {
    const result = await bill.removeLine(index);
    if (!result.ok) push("error", copy.toast.deleteFailed, result.reason || copy.billing.lineDeleteFailed);
  };

  // ── delete ────────────────────────────────────────────────────────────────
  const deleteVoucher = async () => {
    if (!activeId) return;
    if (!window.confirm(copy.billing.confirmDelete(voucherNumber))) return;
    setLoading(true);
    try {
      const result = await api.deleteSaleVoucher(activeId);
      if (!result.accepted) { push("error", copy.toast.deleteFailed, result.reason ?? ""); return; }
      if (result.ambiguousDispatchEventIds && result.ambiguousDispatchEventIds.length > 0) {
        push("warning", copy.billing.voucherDeletedAmbiguousTitle, copy.billing.ambiguousDispatchWarning(result.ambiguousDispatchEventIds.length), 8000);
      } else {
        push("success", copy.toast.deleted, copy.billing.deleted(voucherNumber));
      }
      // The deleted number stays on screen so the desk sees which one went; nothing is renumbered.
      const snapshot = await vouchers.refresh();
      showNew(null, snapshot.ids.length);
    } catch (err) {
      push("error", copy.toast.error, err instanceof Error ? err.message : "Delete failed");
    } finally {
      setLoading(false);
    }
  };

  // ── save ──────────────────────────────────────────────────────────────────
  const lineInput = (line: BillLine) => ({ productVariantId: line.productVariantId, quantity: line.dznQty, unitPrice: line.pairRate, discount: line.totalDisc, priceType: line.priceType });

  const saveExisting = async (id: string): Promise<boolean> => {
    const header = await api.updateSaleVoucher(id, { bookNo: fields.bookNo, subPartyNameUrdu: fields.subPartyNameUrdu, remarks: fields.remarks });
    if (!header.accepted) { push("error", copy.toast.failed, header.reason ?? "Update failed"); return false; }
    for (const line of bill.lines) {
      const result = line.id ? await api.updateVoucherLineItem(line.id, lineInput(line)) : await api.addVoucherLineItem(id, lineInput(line));
      if (!result.accepted) { push("error", copy.toast.failed, result.reason ?? "Update item failed"); return false; }
    }
    push("success", copy.toast.updated, copy.billing.saved(voucherNumber));
    return true;
  };

  const explainRefusal = (refusal: Awaited<ReturnType<typeof api.createSaleVoucher>>) => {
    if (refusal.errorCode === "PARTY_BALANCE_LIMIT_EXCEEDED") {
      const money = (value?: number) => formatWholeMoney(value ?? 0);
      push("error", copy.billing.limitExceededTitle, copy.billing.limitExceededBody({ current: money(refusal.currentBalance), voucher: money(refusal.voucherAmount), projected: money(refusal.projectedBalance), limit: money(refusal.limit), available: money(refusal.available) }));
      return;
    }
    push("error", copy.toast.failed, refusal.reason ?? "Create failed");
  };

  const createNew = async (): Promise<string | null> => {
    const created = await api.createSaleVoucher({ partyId, ...fields, projectedTotal: bill.totals.net, gatepassId: gatepassLink?.id ?? null });
    if (!created.accepted) {
      if (created.errorCode === "GATEPASS_ALREADY_BILLED" && created.existingVoucherId) {
        // Someone billed it meanwhile: open that bill rather than make a second one.
        push("warning", copy.billing.alreadyBilledTitle, created.reason ?? "");
        const snapshot = await vouchers.refresh();
        await loadVoucher(created.existingVoucherId, snapshot.ids.indexOf(created.existingVoucherId));
        return null;
      }
      explainRefusal(created);
      return null;
    }
    if (!created.id) { push("error", copy.toast.failed, "No voucher ID returned"); return null; }
    for (const line of bill.lines) {
      const result = await api.addVoucherLineItem(created.id, lineInput(line));
      if (!result.accepted) { push("error", copy.toast.failed, result.reason ?? "Add item failed"); return null; }
    }
    push("success", copy.toast.created, copy.billing.created(created.voucherNumber ?? ""));
    return created.id;
  };

  const save = async () => {
    if (!partyId) { push("error", copy.toast.required, copy.billing.partyRequired); return; }
    if (bill.lines.length === 0) { push("error", copy.billing.noLines, copy.billing.noLinesBody); return; }
    setLoading(true);
    try {
      const savedId = activeId ? (await saveExisting(activeId) ? activeId : null) : await createNew();
      if (!savedId) return;
      // The saved bill stays on screen, linked to its gatepass, ready to print.
      const snapshot = await vouchers.refresh();
      await loadVoucher(savedId, snapshot.ids.indexOf(savedId));
    } catch (err) {
      push("error", copy.toast.error, err instanceof Error ? err.message : "Save failed");
    } finally {
      setLoading(false);
    }
  };

  const onFieldsChange = useCallback((patch: Partial<BillHeaderFields>) => setFields((prev) => ({ ...prev, ...patch })), []);

  // ─── render ───────────────────────────────────────────────────────────────
  return (
    <div className="page gatepass-page gp-compose bill-page">
      <header className="gp-topbar">
        <div className="gp-topbar-main">
          <h1 className="page-title">{copy.billing.title}</h1>
          <div className="bill-topbar-no">
            <span className="gp-nav-prefix">No.</span>
            <strong data-testid="voucher-number">{voucherNumber || "—"}</strong>
            {activeId && <span className="bill-topbar-tag">{copy.billing.editing}</span>}
            {!activeId && hasBill && <span className="bill-topbar-tag">{copy.billing.newBill}</span>}
          </div>
          {gatepassLink && gatepassLink.status !== "CANCELLED" && <GatepassLinkBanner link={gatepassLink} saved={Boolean(activeId)} busy={loading} onDelete={() => void deleteVoucher()} />}
        </div>
        <div className="gp-topbar-actions">
          <VoucherNavigator canPrev={curIdx > 0} canNext={hasBill || curIdx < vouchers.ids.length} busy={loading} onPrev={() => void goPrev()} onNext={() => void goNext()} onGo={(number) => void goTo(number)} />
          <button type="button" className="btn btn-secondary" onClick={() => void printVoucher()} disabled={loading || !activeId} data-testid="print-voucher">
            🖨 {copy.billing.printVoucher}
          </button>
        </div>
      </header>

      {gatepassLink?.status === "CANCELLED" && <GatepassLinkBanner link={gatepassLink} saved={Boolean(activeId)} busy={loading} onDelete={() => void deleteVoucher()} />}

      <div className="gp-workspace">
        <section className="card gp-card gp-section bill-lines-card" aria-labelledby="bill-lines-title">
          <div className="gp-section-head-row">
            <h2 className="gp-section-title" id="bill-lines-title">{copy.billing.itemsTitle} ({bill.lines.length})</h2>
          </div>
          {loading && !hasBill ? (
            <StateView kind="loading" compact />
          ) : hasBill ? (
            <BillLinesTable lines={bill.lines} disabled={loading} gatepassCode={gatepassLink?.code ?? null} onFieldChange={bill.changeField} onPriceTypeChange={(index, type) => void changePriceType(index, type)} onRemove={(index) => void removeLine(index)} />
          ) : (
            <GatepassBillPicker busy={loading} onPick={(number) => void billGatepassNumber(number)} />
          )}
        </section>

        <BillSummaryPanel
          party={partyFacts}
          balance={balance}
          balanceLimit={balanceLimit}
          totals={bill.totals}
          fields={fields}
          onFieldsChange={onFieldsChange}
          saved={Boolean(activeId)}
          busy={loading}
          canSave={hasBill && bill.lines.length > 0}
          onSave={() => void save()}
          onDelete={() => void deleteVoucher()}
          onCancel={() => onNavigate("dashboard")}
        />
      </div>
    </div>
  );
};
