import React, { useCallback, useEffect, useMemo, useState } from "react";
import { buildRawMaterialQrId } from "@erp/domain";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import type { Party, RawMaterialMovementConfigRow, RawMaterialQrBatchRow, RawMaterialQrRow, RawMaterialQrSequenceState } from "../../types/desktopApi";
import { useNotifications } from "../../state/NotificationsContext";
import { QrPreview, openRawMaterialLabelPrintWindow, printRawMaterialLabels, type RawMaterialLabelSheet } from "../../utils/qrLabels";
import { formatDate, formatTime } from "../../utils/dates";
import { copy } from "../../config/copy";
import { StepHeading } from "../../components/shared/StepHeading";
import { SearchableCombobox } from "../../components/shared/SearchableCombobox";
import { StateView } from "../../components/shared/StateView";
import { ConfirmDialog, type ConfirmFact } from "../../components/shared/ConfirmDialog";
import { formatQuantity, materialLabelAttributes, materialPickerOption, packName, packetContentsLabel, type InventoryItemRow } from "./rawMaterial";
import { downloadCsv, exportFileName } from "../../utils/exportFile";
import { StockUnitPicker } from "./StockUnitPicker";
import { buildQrBatchSheet } from "./rawMaterialExports";

// Registering and printing raw material labels: supplier → material → what one packet holds
// and how many → Print. One confirmation, then the run is registered and the labels go straight
// to the computer's default printer — no preview window in between.
//
// The identity model is untouched. Identities are built by the domain's
// buildRawMaterialQrId and registered by generateRawMaterialQrBatch, which reserves the
// serial range atomically and writes what one packet holds onto every label in the run. The
// operator types that figure each time: the same material arrives 5 DOZEN to a packet one day
// and 3 the next, and each label's scans move exactly what its own packet holds.

const MAX_QUANTITY = 10000;
const QUICK_QUANTITIES = [10, 25, 50, 100, 250];
const PREVIEW_LIMIT = 12;
const RECENT_HISTORY_LIMIT = 10;
const REQUESTED_BY_MAX = 120;

/** A print waiting for confirmation: the run on the form, or an earlier run printed again. */
type PrintRequest = { kind: "new" } | { kind: "reprint"; batch: RawMaterialQrBatchRow };

interface LabelsTabProps {
  /** The logged-in operator; recorded as who generated each run. */
  username?: string;
  /** Per-material setup — the container's name for the "One PACKET holds" field. */
  configByItem: Map<string, RawMaterialMovementConfigRow>;
  /** Set when the operator arrived from a material's drawer. */
  preselectItemId?: string;
  onPreselectConsumed: () => void;
  /** Units, so a material saved without one can be given one here instead of a dead end. */
  units?: Array<Record<string, unknown>>;
  /** Re-reads the workspace lookups after a unit is set or created. */
  onLookupsChanged?: () => Promise<void>;
}

export const LabelsTab: React.FC<LabelsTabProps> = ({ username, configByItem, preselectItemId, onPreselectConsumed, units, onLookupsChanged }) => {
  const api = useDesktopApi();
  const { push } = useNotifications();

  const [suppliers, setSuppliers] = useState<Party[]>([]);
  const [items, setItems] = useState<InventoryItemRow[]>([]);
  const [partyId, setPartyId] = useState("");
  const [itemId, setItemId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [requestedBy, setRequestedBy] = useState("");
  /** What one packet in this run holds, as typed — in the material's stock unit. */
  const [packetHolds, setPacketHolds] = useState("");

  const [generating, setGenerating] = useState(false);
  const [sequence, setSequence] = useState<RawMaterialQrSequenceState | null>(null);
  const [lastResult, setLastResult] = useState<{ batch: RawMaterialQrBatchRow; qrCodes: RawMaterialQrRow[] } | null>(null);
  const [history, setHistory] = useState<RawMaterialQrBatchRow[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  /** The print waiting for the operator's go-ahead: a new run, or a reprint of an old one. */
  const [confirming, setConfirming] = useState<PrintRequest | null>(null);
  /** The generated run waiting for a go-ahead to be erased. */
  const [erasing, setErasing] = useState<RawMaterialQrBatchRow | null>(null);

  const loadLookups = useCallback(async () => {
    try {
      const [partyResult, itemRows] = await Promise.all([
        api.listParties({ pageSize: 1000 }),
        api.listInventoryItems({}),
      ]);
      setSuppliers(partyResult.rows.filter((party) => party.partyType === "SUPPLIER"));
      setItems(itemRows);
    } catch (error) {
      push("error", copy.toast.loadFailed, error instanceof Error ? error.message : "Could not load");
    }
  }, [api, push]);

  const loadHistory = useCallback(async () => {
    setLoadingHistory(true);
    setHistoryError(null);
    try {
      setHistory(await api.listRawMaterialQrBatches({ limit: RECENT_HISTORY_LIMIT }));
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : copy.states.loadFailedBody);
    } finally {
      setLoadingHistory(false);
    }
  }, [api]);

  useEffect(() => {
    void loadLookups();
    void loadHistory();
  }, [loadLookups, loadHistory]);

  // Arriving from a material's drawer pre-fills step 2, so the operator only picks the
  // supplier and the count.
  useEffect(() => {
    if (!preselectItemId) return;
    setItemId(preselectItemId);
    onPreselectConsumed();
  }, [preselectItemId, onPreselectConsumed]);

  const selectedParty = useMemo(() => suppliers.find((party) => party.id === partyId) ?? null, [suppliers, partyId]);
  const selectedItem = useMemo(() => items.find((item) => String(item.id) === itemId), [items, itemId]);
  const selectedConfig = itemId ? configByItem.get(itemId) : undefined;
  const selectedPackName = packName(selectedConfig);
  // A packet's contents are recorded in the unit the material's stock is counted in, so a scan
  // adds them to the balance as they are.
  const stockUnitCode = String(selectedItem?.unit_code ?? selectedConfig?.stockUnitCode ?? "");

  // A different material is a different packet: never carry the last figure across to it.
  const chooseItem = (nextItemId: string) => {
    setItemId(nextItemId);
    setPacketHolds("");
  };

  const partyOptions = useMemo(
    () => suppliers.map((party) => ({ value: party.id, label: `${party.partyCode} — ${party.partyName}` })),
    [suppliers]
  );
  const itemOptions = useMemo(
    () =>
      items
        .filter((item) => item.id && item.display_name)
        .map(materialPickerOption),
    [items]
  );

  // Ask the database where this party+item combination's sequence actually stands, so the
  // operator sees the real serial range rather than a placeholder shape.
  // Re-read after a run is erased too: the serials it handed back change what the next run is.
  const loadSequence = useCallback(async () => {
    if (!partyId || !itemId) {
      setSequence(null);
      return;
    }
    try {
      setSequence(await api.getRawMaterialQrSequenceState({ partyId, itemId }));
    } catch {
      setSequence(null);
    }
  }, [api, partyId, itemId]);

  useEffect(() => {
    let cancelled = false;
    if (!partyId || !itemId) {
      setSequence(null);
      return;
    }
    void (async () => {
      try {
        const state = await api.getRawMaterialQrSequenceState({ partyId, itemId });
        if (!cancelled) setSequence(state);
      } catch {
        if (!cancelled) setSequence(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, partyId, itemId]);

  const quantityValue = quantity.trim() === "" ? NaN : Number(quantity);
  const quantityError = useMemo(() => {
    if (quantity.trim() === "") return null;
    if (!Number.isFinite(quantityValue) || !Number.isInteger(quantityValue)) return "Enter a whole number.";
    if (quantityValue <= 0) return "Quantity must be at least 1.";
    if (quantityValue > MAX_QUANTITY) return `Maximum ${MAX_QUANTITY.toLocaleString()} per batch.`;
    return null;
  }, [quantity, quantityValue]);

  const quantityOk = Number.isInteger(quantityValue) && quantityValue > 0 && !quantityError;

  const packetHoldsValue = packetHolds.trim() === "" ? NaN : Number(packetHolds);
  const packetHoldsOk = Number.isFinite(packetHoldsValue) && packetHoldsValue > 0;
  const packetHoldsError = packetHolds.trim() !== "" && !packetHoldsOk ? "Enter a number greater than zero, e.g. 5." : null;

  // Rebuilds the identity for display using the same domain builder the generator writes
  // with, so what the operator reads always matches what will be registered.
  const identityAt = useCallback((partyCode: string, itemCode: string, sequenceNum: number): string => {
    try {
      return buildRawMaterialQrId({ partyCode, itemCode, sequence: sequenceNum });
    } catch {
      return `RM_${partyCode}_${itemCode}_${sequenceNum}`;
    }
  }, []);

  // The exact range this generation will register, known before the operator commits.
  const pendingRange = useMemo(() => {
    if (!selectedParty || !selectedItem || !sequence || !quantityOk) return null;
    const start = sequence.nextSequence;
    return {
      first: identityAt(selectedParty.partyCode, String(selectedItem.item_code), start),
      last: identityAt(selectedParty.partyCode, String(selectedItem.item_code), start + quantityValue - 1),
      isFirstEver: sequence.lastSequence === 0,
      alreadyGenerated: sequence.lastSequence,
    };
  }, [selectedParty, selectedItem, sequence, quantityOk, quantityValue, identityAt]);

  const canGenerate = Boolean(partyId) && Boolean(itemId) && packetHoldsOk && quantityOk && !generating;

  const labelSheetFor = (batch: RawMaterialQrBatchRow, qrCodes: RawMaterialQrRow[]): RawMaterialLabelSheet => {
    // The batch itself only carries the item's code/name — its category and configured
    // attributes live on the material row already loaded for step 2's picker.
    const material = items.find((item) => String(item.id) === batch.itemId);
    return {
      title: `Raw Material QR — ${batch.partyName} / ${batch.itemDisplayName}`,
      heading: `${batch.partyName} — ${batch.itemDisplayName}`,
      subheading: `${identityAt(batch.partyCode, batch.itemCode, batch.startSequence)} → ${identityAt(batch.partyCode, batch.itemCode, batch.endSequence)} · ${batch.quantity} codes`,
      header: {
        categoryLine: String(material?.top_category_name ?? material?.category_name ?? ""),
        subCategoryLine: String(material?.sub_category_name ?? ""),
        attributes: material ? materialLabelAttributes(material) : [],
        partyName: batch.partyName,
        packQuantity: batch.packingQuantity == null ? "" : formatQuantity(batch.packingQuantity),
      },
      ids: qrCodes.map((code) => code.id),
    };
  };

  /** The old preview window — kept only for checking a run on screen or saving it as a PDF. */
  const openPreviewWindow = (batch: RawMaterialQrBatchRow, qrCodes: RawMaterialQrRow[]) => {
    if (!openRawMaterialLabelPrintWindow(labelSheetFor(batch, qrCodes))) {
      push("error", copy.toast.popupBlocked, "Allow popups to preview QR codes");
    }
  };

  /** Sends a run to the default printer. Resolves with the reason it did not print, or null. */
  const printBatch = async (batch: RawMaterialQrBatchRow, qrCodes: RawMaterialQrRow[]): Promise<string | null> => {
    const result = await printRawMaterialLabels(labelSheetFor(batch, qrCodes));
    if (!result.printed) return result.reason;
    push("success", copy.labelPrint.sentTitle, copy.labelPrint.sentBody(qrCodes.length));
    return null;
  };

  /** Print pressed on the form: check it, then ask before anything is registered. */
  const requestPrint = () => {
    if (!canGenerate) {
      push(
        "error",
        "Check the form",
        packetHoldsError ?? quantityError ?? `Select a supplier and raw material, then enter what one ${selectedPackName} holds and how many labels`
      );
      return;
    }
    setConfirming({ kind: "new" });
  };

  /** Confirmed: register the run, then print it. Resolves with a reason to keep the dialog open. */
  const generateAndPrint = async (): Promise<string | null> => {
    setGenerating(true);
    try {
      const result = await api.generateRawMaterialQrBatch({
        partyId,
        itemId,
        quantity: quantityValue,
        packingQuantity: packetHoldsValue,
        createdBy: username?.trim() || undefined,
        requestedBy: requestedBy.trim() || undefined,
      });
      if (!result.accepted || !result.batch || !result.qrCodes) {
        return result.reason || copy.labelPrint.registerFailed;
      }
      setLastResult({ batch: result.batch, qrCodes: result.qrCodes });
      setCopied(false);
      setQuantity("");
      setPacketHolds("");
      setRequestedBy("");
      void loadHistory();
      // The codes now exist whatever the printer does, so a printing problem closes the dialog
      // and points at Print in the history rather than inviting a second registration.
      const notPrinted = await printBatch(result.batch, result.qrCodes);
      if (notPrinted) push("error", copy.labelPrint.notPrintedTitle, copy.labelPrint.notPrintedBody(notPrinted));
      return null;
    } catch {
      return copy.labelPrint.registerFailed;
    } finally {
      setGenerating(false);
    }
  };

  const reprintBatch = async (batch: RawMaterialQrBatchRow): Promise<string | null> => {
    let qrCodes: RawMaterialQrRow[];
    try {
      qrCodes = await api.listRawMaterialQrsForBatch(batch.id);
    } catch {
      return copy.labelPrint.codesLoadFailed;
    }
    return printBatch(batch, qrCodes);
  };

  /**
   * Erasing a run is refused by the data layer the moment one of its labels has been scanned,
   * and the refusal says so — the confirmation shows that answer rather than deciding here.
   */
  const eraseRun = async (): Promise<string | null> => {
    if (!erasing) return null;
    const result = await api.deleteRawMaterialQrBatch(erasing.id);
    if (!result.accepted) return result.reason ?? copy.labelPrint.registerFailed;
    push("success", copy.removal.deleteRunDone(result.quantity ?? erasing.quantity, result.nextSequence ?? 1));
    if (lastResult?.batch.id === erasing.id) setLastResult(null);
    void loadHistory();
    void loadSequence();
    return null;
  };

  /** What the confirmation shows: the facts of the run about to be printed. */
  const confirmFacts = (request: PrintRequest): ConfirmFact[] => {
    if (request.kind === "reprint") {
      const { batch } = request;
      return [
        { label: copy.columns.supplier, value: batch.partyName },
        { label: "Raw Material", value: batch.itemDisplayName },
        { label: copy.labelPrint.factLabels, value: `${identityAt(batch.partyCode, batch.itemCode, batch.startSequence)} → ${identityAt(batch.partyCode, batch.itemCode, batch.endSequence)}` },
      ];
    }
    return [
      { label: copy.columns.supplier, value: selectedParty?.partyName ?? "" },
      { label: "Raw Material", value: String(selectedItem?.display_name ?? "") },
      { label: copy.labelPrint.factPacket(selectedPackName), value: packetContentsLabel(packetHoldsValue, stockUnitCode) },
      { label: copy.labelPrint.factLabels, value: pendingRange ? `${pendingRange.first} → ${pendingRange.last}` : quantityValue.toLocaleString() },
    ];
  };

  const handleCopyIdentities = async () => {
    if (!lastResult) return;
    try {
      await navigator.clipboard.writeText(lastResult.qrCodes.map((code) => code.id).join("\n"));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      push("error", copy.toast.copyFailed, "Could not copy to the clipboard");
    }
  };

  const unitCodeOf = (materialId: string): string => {
    const material = items.find((item) => String(item.id) === materialId);
    return String(material?.unit_code ?? configByItem.get(materialId)?.stockUnitCode ?? "");
  };

  const knownPartyIds = new Set(suppliers.map((party) => party.id));
  const knownItemIds = new Set(items.map((item) => String(item.id)));
  const firstIdentity = lastResult?.qrCodes[0]?.id ?? "";
  const lastIdentity = lastResult?.qrCodes[lastResult.qrCodes.length - 1]?.id ?? "";

  return (
    <div className="rm-labels">
      <form
        className="card qr-generate-card"
        onSubmit={(event) => {
          event.preventDefault();
          requestPrint();
        }}
      >
        <div className="card-header">
          <h2 className="card-title">{copy.labelPrint.cardTitle}</h2>
          <span className="qr-flow-hint">{copy.labelPrint.flowHint}</span>
        </div>

        <div className="qr-steps">
          <section className="qr-step">
            <StepHeading index={1} done={Boolean(selectedParty)} title={copy.columns.supplier} />
            <div className="qr-step-body">
              <SearchableCombobox
                value={partyId}
                options={partyOptions}
                placeholder={partyOptions.length === 0 ? "No suppliers yet" : "Choose supplier…"}
                emptyLabel="No suppliers found"
                onChange={setPartyId}
                dropdown
              />
              <p className="field-help">From Party Management — suppliers cannot be created here.</p>
            </div>
          </section>

          <section className="qr-step">
            <StepHeading index={2} done={Boolean(selectedItem)} title="Raw Material" />
            <div className="qr-step-body">
              {/* Always shown: the operator may know the material before the supplier, and a
                  hidden picker reads as a missing one. Generate still needs both. */}
              <SearchableCombobox
                value={itemId}
                options={itemOptions}
                placeholder={itemOptions.length === 0 ? "No raw materials yet" : "Choose raw material — or type to filter"}
                emptyLabel="No raw materials found"
                onChange={chooseItem}
                dropdown
              />
              {/* Once picked, the full category and code are shown, so the short name in the
                  box is never ambiguous. */}
              <p className="field-help">
                {selectedItem ? materialPickerOption(selectedItem).detail : "Type any part of the name to filter, in any order — e.g. brown 8/13."}
              </p>
            </div>
          </section>

          <section className="qr-step">
            <StepHeading index={3} done={packetHoldsOk && quantityOk} title="Packet & labels" />
            <div className="qr-step-body">
              {!itemId ? (
                <p className="qr-step-waiting">Choose a raw material first.</p>
              ) : !stockUnitCode && selectedItem ? (
                // What a packet holds is recorded in the material's stock unit, so without one
                // there is nothing to print. Set it here rather than send the operator away.
                <div className="rm-unit-missing">
                  <p className="qr-error">⚠ This material has no stock unit yet. Set it to print labels.</p>
                  {units ? (
                    <StockUnitPicker
                      itemId={String(selectedItem.id)}
                      displayName={String(selectedItem.display_name ?? "")}
                      units={units}
                      onSaved={async () => {
                        await Promise.all([loadLookups(), onLookupsChanged?.()]);
                      }}
                    />
                  ) : (
                    <p className="field-help">Open the material on the Stock tab to set its unit.</p>
                  )}
                </div>
              ) : (
                <>
                  <div className="qr-packet-holds">
                    <label htmlFor="rmqr-packet-holds" className="input-label">
                      One {selectedPackName} holds
                    </label>
                    <div className="qr-packet-holds-row">
                      <input
                        id="rmqr-packet-holds"
                        type="number"
                        min={0}
                        step="any"
                        inputMode="decimal"
                        className="form-input"
                        value={packetHolds}
                        onChange={(event) => setPacketHolds(event.target.value)}
                        placeholder="e.g. 5"
                        aria-describedby="rmqr-packet-holds-help"
                      />
                      <span className="qr-packet-holds-unit">{stockUnitCode}</span>
                    </div>
                    {packetHoldsError ? (
                      <p className="qr-error">{packetHoldsError}</p>
                    ) : (
                      <p id="rmqr-packet-holds-help" className="field-help">
                        Printed bold in the label's bottom-left corner. Each scan of these labels adds or removes exactly this much.
                      </p>
                    )}
                  </div>
                  <label htmlFor="rmqr-quantity" className="input-label">
                    How many labels
                  </label>
                  <input
                    id="rmqr-quantity"
                    type="number"
                    min={1}
                    max={MAX_QUANTITY}
                    step={1}
                    className="form-input qr-quantity"
                    value={quantity}
                    onChange={(event) => setQuantity(event.target.value)}
                    placeholder="e.g. 50"
                  />
                  <div className="qr-chips qr-quick">
                    {QUICK_QUANTITIES.map((count) => (
                      <button
                        key={count}
                        type="button"
                        className={`qr-chip${quantityValue === count ? " is-active" : ""}`}
                        onClick={() => setQuantity(String(count))}
                      >
                        {count}
                      </button>
                    ))}
                  </div>
                  {quantityError ? (
                    <p className="qr-error">{quantityError}</p>
                  ) : (
                    <p className="field-help">One label goes on one packet. Up to {MAX_QUANTITY.toLocaleString()} per batch.</p>
                  )}

                  <div className="qr-requested-by">
                    <label htmlFor="rmqr-requested-by" className="input-label">
                      Requested by <span className="text-muted">(optional)</span>
                    </label>
                    <input
                      id="rmqr-requested-by"
                      type="text"
                      className="form-input"
                      value={requestedBy}
                      onChange={(event) => setRequestedBy(event.target.value)}
                      placeholder="Who asked for these — e.g. Aslam (Store)"
                      maxLength={REQUESTED_BY_MAX}
                      autoComplete="off"
                    />
                    <p className="field-help">
                      Kept with the run. You{username ? ` (${username})` : ""} are recorded as the operator.
                    </p>
                  </div>
                </>
              )}
            </div>
          </section>
        </div>

        <div className="qr-commit">
          {pendingRange ? (
            <div className="qr-pending" aria-live="polite">
              <p className="summary-block-title">
                Will register {quantityValue.toLocaleString()} {quantityValue === 1 ? "code" : "codes"}
              </p>
              <div className="qr-range">
                <code className="qr-identity">{pendingRange.first}</code>
                <span className="qr-range-sep">→</span>
                <code className="qr-identity">{pendingRange.last}</code>
              </div>
              {packetHoldsOk ? (
                <p className="field-help">
                  Each {selectedPackName} holds {packetContentsLabel(packetHoldsValue, stockUnitCode)}.
                </p>
              ) : null}
              <p className="field-help">
                {pendingRange.isFirstEver
                  ? "First batch for this supplier + raw material."
                  : `Continues after ${pendingRange.alreadyGenerated.toLocaleString()} already generated.`}
              </p>
            </div>
          ) : (
            <p className="qr-pending-empty" aria-live="polite">
              Choose a supplier, raw material and quantity to see the exact range.
            </p>
          )}

          <button type="submit" className="btn btn-primary btn-lg qr-generate-btn" disabled={!canGenerate}>
            {generating ? copy.labelPrint.printing : copy.labelPrint.printButton(quantityOk ? quantityValue : null)}
          </button>
        </div>
      </form>

      {lastResult ? (
        <div className="qr-input-card qr-result-card">
          <div className="card-header">
            <h2 className="card-title">
              <span className="badge badge-ok">Done</span> {lastResult.batch.quantity.toLocaleString()} labels registered
            </h2>
            <div className="qr-result-actions">
              <button type="button" className="btn btn-secondary" onClick={() => void handleCopyIdentities()}>
                {copied ? "Copied" : "Copy list"}
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => openPreviewWindow(lastResult.batch, lastResult.qrCodes)}>
                {copy.labelPrint.preview}
              </button>
              <button type="button" className="btn btn-primary" onClick={() => setConfirming({ kind: "reprint", batch: lastResult.batch })}>
                {copy.labelPrint.printAgain}
              </button>
            </div>
          </div>

          <div className="qr-result-facts">
            <div>
              <span className="section-label">{copy.columns.supplier}</span>
              <strong>{lastResult.batch.partyName}</strong>
            </div>
            <div>
              <span className="section-label">Raw Material</span>
              <strong>{lastResult.batch.itemDisplayName}</strong>
            </div>
            <div>
              <span className="section-label">{copy.columns.quantity}</span>
              <strong>{lastResult.batch.quantity.toLocaleString()}</strong>
            </div>
            {lastResult.batch.packingQuantity != null ? (
              <div>
                <span className="section-label">One packet holds</span>
                <strong>{packetContentsLabel(lastResult.batch.packingQuantity, unitCodeOf(lastResult.batch.itemId))}</strong>
              </div>
            ) : null}
            <div>
              <span className="section-label">Generated by</span>
              <strong>{lastResult.batch.createdBy ?? "—"}</strong>
            </div>
            {lastResult.batch.requestedBy ? (
              <div>
                <span className="section-label">Requested by</span>
                <strong>{lastResult.batch.requestedBy}</strong>
              </div>
            ) : null}
          </div>

          <div className="qr-pending qr-range-block">
            <p className="summary-block-title">Generated</p>
            <div className="qr-range">
              <code className="qr-identity">{firstIdentity}</code>
              <span className="qr-range-sep">→</span>
              <code className="qr-identity">{lastIdentity}</code>
            </div>
          </div>

          <div className="qr-preview-grid">
            {lastResult.qrCodes.slice(0, PREVIEW_LIMIT).map((code) => (
              <div key={code.id} className="qr-preview-cell">
                <QrPreview value={code.id} />
              </div>
            ))}
          </div>
          {lastResult.qrCodes.length > PREVIEW_LIMIT ? (
            <p className="field-help">
              Showing the first {PREVIEW_LIMIT} of {lastResult.qrCodes.length.toLocaleString()}. Use {copy.labelPrint.preview} to see the full batch.
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="card">
        <div className="card-header">
          <h2 className="card-title">Recent generations</h2>
          <div className="qr-history-header-side">
            <span className="qr-history-count">
              {history.length === 0 ? "No batches yet" : `Last ${history.length.toLocaleString()} ${history.length === 1 ? "batch" : "batches"}`}
            </span>
            {history.length > 0 ? (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => downloadCsv(exportFileName("raw-material-label-batches"), buildQrBatchSheet(history, identityAt))}
              >
                Export batches (Excel)
              </button>
            ) : null}
          </div>
        </div>

        {loadingHistory ? (
          <StateView kind="loading" compact message="Loading recent generations…" />
        ) : historyError ? (
          <StateView kind="error" compact message={historyError} onRetry={() => void loadHistory()} />
        ) : history.length === 0 ? (
          <StateView
            kind="empty"
            compact
            title="No codes generated yet"
            hint="Pick a supplier and raw material above to register your first batch."
          />
        ) : (
          <div className="table-container">
            <table className="data-table qr-history-table">
              <thead>
                <tr>
                  <th scope="col">{copy.columns.supplier}</th>
                  <th scope="col">Raw Material</th>
                  <th scope="col">Range</th>
                  <th scope="col" className="qr-num-col" style={{ textAlign: "center" }}>
                    {copy.columns.qty}
                  </th>
                  <th scope="col">Generated</th>
                  <th scope="col" aria-label={copy.columns.actions} />
                </tr>
              </thead>
              <tbody>
                {history.map((batch) => {
                  const generatedAt = new Date(batch.createdAt);
                  const canReuse = knownPartyIds.has(batch.partyId) && knownItemIds.has(batch.itemId);
                  return (
                    <tr key={batch.id}>
                      <td>
                        <strong>{batch.partyName}</strong>
                      </td>
                      <td>
                        {batch.itemDisplayName}
                        {batch.packingQuantity != null ? (
                          <span className="qr-generated-time">
                            {" "}· {packName(configByItem.get(batch.itemId))} of {packetContentsLabel(batch.packingQuantity, unitCodeOf(batch.itemId))}
                          </span>
                        ) : null}
                      </td>
                      <td className="qr-range-cell cell-mono">
                        <code>{identityAt(batch.partyCode, batch.itemCode, batch.startSequence)}</code>
                        <span className="qr-range-sep">→</span>
                        <code>{identityAt(batch.partyCode, batch.itemCode, batch.endSequence)}</code>
                      </td>
                      <td className="qr-num-col">{batch.quantity.toLocaleString()}</td>
                      <td>
                        <div className="qr-generated-cell">
                          <span className="qr-generated-date">{formatDate(generatedAt)}</span>
                          <span className="qr-generated-time">
                            {formatTime(generatedAt)}
                            {batch.createdBy ? ` · ${batch.createdBy}` : ""}
                          </span>
                          {batch.requestedBy ? <span className="qr-generated-time">for {batch.requestedBy}</span> : null}
                        </div>
                      </td>
                      <td className="qr-row-actions">
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          disabled={!canReuse}
                          title={canReuse ? "Fill the form with this combination" : "This supplier or material is no longer active"}
                          onClick={() => {
                            setPartyId(batch.partyId);
                            setItemId(batch.itemId);
                            setPacketHolds(batch.packingQuantity == null ? "" : formatQuantity(batch.packingQuantity));
                            setQuantity("");
                          }}
                        >
                          Use again
                        </button>
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setConfirming({ kind: "reprint", batch })}>
                          🖨 Print
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm rm-run-erase"
                          title={copy.removal.deleteRun}
                          onClick={() => setErasing(batch)}
                        >
                          {copy.actions.delete}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {confirming ? (
        <ConfirmDialog
          title={confirming.kind === "new" ? copy.labelPrint.confirmTitle(quantityValue) : copy.labelPrint.reprintTitle(confirming.batch.quantity)}
          facts={confirmFacts(confirming)}
          explain={confirming.kind === "new" ? copy.labelPrint.confirmExplain : copy.labelPrint.reprintExplain}
          warning={confirming.kind === "reprint" ? copy.labelPrint.reprintWarning : null}
          confirmLabel={copy.labelPrint.confirmButton}
          tone="primary"
          busyLabel={copy.labelPrint.printing}
          onConfirm={confirming.kind === "new" ? generateAndPrint : () => reprintBatch(confirming.batch)}
          onClose={() => setConfirming(null)}
        />
      ) : null}

      {erasing ? (
        <ConfirmDialog
          title={copy.removal.deleteRunTitle(erasing.quantity)}
          facts={[
            { label: copy.columns.supplier, value: erasing.partyName },
            { label: "Raw Material", value: erasing.itemDisplayName },
            { label: copy.labelPrint.factLabels, value: `${identityAt(erasing.partyCode, erasing.itemCode, erasing.startSequence)} → ${identityAt(erasing.partyCode, erasing.itemCode, erasing.endSequence)}` },
          ]}
          explain={copy.removal.deleteRunExplain}
          warning={copy.removal.deleteRunWarning}
          confirmLabel={copy.actions.delete}
          busyLabel={copy.removal.erasing}
          onConfirm={eraseRun}
          onClose={() => setErasing(null)}
        />
      ) : null}
    </div>
  );
};
