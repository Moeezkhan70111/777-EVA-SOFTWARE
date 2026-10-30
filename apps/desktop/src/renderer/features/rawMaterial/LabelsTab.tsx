import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildRawMaterialQrId, isRawMaterialReceiptPartyType } from "@erp/domain";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import type { Party, RawMaterialMovementConfigRow, RawMaterialQrBatchRow, RawMaterialQrRow } from "../../types/desktopApi";
import { useNotifications } from "../../state/NotificationsContext";
import {
  openRawMaterialLabelPrintWindow,
  printRawMaterialLabelRuns,
  type RawMaterialLabelRun,
} from "../../utils/qrLabels";
import { copy } from "../../config/copy";
import { StepHeading } from "../../components/shared/StepHeading";
import { SearchableCombobox } from "../../components/shared/SearchableCombobox";
import { StateView } from "../../components/shared/StateView";
import { ConfirmDialog, type ConfirmFact } from "../../components/shared/ConfirmDialog";
import { formatQuantity, materialLabelAttributes, packName, type InventoryItemRow } from "./rawMaterial";
import { MaterialPickerTable } from "./MaterialPickerTable";
import { SelectedRunsTable } from "./SelectedRunsTable";
import { LabelRunHistory } from "./LabelRunHistory";
import { LabelRunResult } from "./LabelRunResult";
import { StockUnitPicker } from "./StockUnitPicker";
import { labelRunTotals, newLabelRun, runFigures, runIsReady, type LabelRun } from "./labelRuns";
import { leaseRefusalText } from "../../../shared/leaseRefusal";

// QR GENERATOR — registering and printing the labels that go on packets:
//
//   ① Select Supplier   ② Select Material            ③ Selected Items
//                       search / category / sub-cat   one row per run, packets × qty per packet
//                                                     [ Print QR Codes & Labels ]
//
// One press of Print registers ONE RUN PER ROW and sends every sticker to the printer as a
// single job. A delivery is rarely one material, and the same material can arrive in two
// packet sizes on the same day, so a row is a run and the same material may be queued twice.
//
// The identity model is untouched. Identities are built by the domain's buildRawMaterialQrId
// and registered by generateRawMaterialQrBatch, which reserves each run's serial range
// atomically and writes what one packet holds onto every label in it. The operator types that
// figure per row: the same material arrives 5 DOZEN to a packet one day and 3 the next, and
// each label's scans move exactly what its own packet holds.

const RECENT_HISTORY_LIMIT = 10;
const REQUESTED_BY_MAX = 120;

/** A print waiting for confirmation: the runs on the form, or an earlier run printed again. */
type PrintRequest = { kind: "new" } | { kind: "reprint"; batch: RawMaterialQrBatchRow };

/** One run that went through, kept so the operator can copy, preview or reprint it. */
interface RegisteredRun {
  batch: RawMaterialQrBatchRow;
  qrCodes: RawMaterialQrRow[];
}

interface LabelsTabProps {
  /** The logged-in operator; recorded as who generated each run. */
  username?: string;
  /** Per-material setup — the container's name for the "qty per packet" field. */
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
  const [requestedBy, setRequestedBy] = useState("");
  /** The runs queued for the next press of Print, in the order they were added. */
  const [runs, setRuns] = useState<LabelRun[]>([]);
  // A ref, not state: two Adds in the same tick must get two different keys, and state read
  // inside a batched handler is still the value from the last render — both rows would share a
  // key and typing in one would type in the other.
  const keySeq = useRef(0);

  const [generating, setGenerating] = useState(false);
  const [registered, setRegistered] = useState<RegisteredRun[]>([]);
  const [history, setHistory] = useState<RawMaterialQrBatchRow[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<PrintRequest | null>(null);
  const [erasing, setErasing] = useState<RawMaterialQrBatchRow | null>(null);

  const loadLookups = useCallback(async () => {
    try {
      const [partyResult, itemRows] = await Promise.all([api.listParties({ pageSize: 1000 }), api.listInventoryItems({})]);
      setSuppliers(partyResult.rows.filter((party) => isRawMaterialReceiptPartyType(party.partyType)));
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

  const addRun = useCallback(
    (item: InventoryItemRow, perPacket?: number | null) => {
      keySeq.current += 1;
      const run = newLabelRun(item, configByItem.get(String(item.id)), `run-${keySeq.current}`);
      setRuns((previous) => [...previous, perPacket == null ? run : { ...run, perPacket: formatQuantity(perPacket) }]);
    },
    [configByItem]
  );

  // Arriving from a material's drawer queues it, so the operator only picks the supplier and
  // says how many.
  useEffect(() => {
    if (!preselectItemId) return;
    const item = items.find((candidate) => String(candidate.id) === preselectItemId);
    if (!item) return;
    addRun(item);
    onPreselectConsumed();
  }, [preselectItemId, items, addRun, onPreselectConsumed]);

  // A material given a stock unit while it is queued must pick it up here too: the row holds
  // the unit it was queued with, and what a packet holds is recorded in that unit.
  useEffect(() => {
    setRuns((previous) => {
      let changed = false;
      const next = previous.map((run) => {
        const item = items.find((candidate) => String(candidate.id) === run.itemId);
        const unitCode = String(item?.unit_code ?? configByItem.get(run.itemId)?.stockUnitCode ?? "");
        if (unitCode === run.unitCode) return run;
        changed = true;
        return { ...run, unitCode };
      });
      return changed ? next : previous;
    });
  }, [items, configByItem]);

  const selectedParty = useMemo(() => suppliers.find((party) => party.id === partyId) ?? null, [suppliers, partyId]);
  const partyOptions = useMemo(
    () => suppliers.map((party) => ({ value: party.id, label: `${party.partyCode} — ${party.partyName}` })),
    [suppliers]
  );

  const chosenItemIds = useMemo(() => new Set(runs.map((run) => run.itemId)), [runs]);
  /** Queued materials with no stock unit — they cannot be labelled until they have one. */
  const unitless = useMemo(() => runs.filter((run) => !run.unitCode), [runs]);
  const totals = labelRunTotals(runs);
  const everyRunReady = runs.length > 0 && runs.every(runIsReady);
  const canPrint = Boolean(partyId) && everyRunReady && !generating;

  const changeRun = (key: string, patch: Partial<Pick<LabelRun, "packets" | "perPacket">>) =>
    setRuns((previous) => previous.map((run) => (run.key === key ? { ...run, ...patch } : run)));

  // Rebuilds the identity for display using the same domain builder the generator writes with,
  // so what the operator reads always matches what was registered.
  const identityAt = useCallback((partyCode: string, itemCode: string, sequenceNum: number): string => {
    try {
      return buildRawMaterialQrId({ partyCode, itemCode, sequence: sequenceNum });
    } catch {
      return `RM_${partyCode}_${itemCode}_${sequenceNum}`;
    }
  }, []);

  const unitCodeOf = (materialId: string): string => {
    const material = items.find((item) => String(item.id) === materialId);
    return String(material?.unit_code ?? configByItem.get(materialId)?.stockUnitCode ?? "");
  };

  /** The sticker header for one batch — the material's own category, attributes and pack figure. */
  const headerFor = (batch: RawMaterialQrBatchRow): RawMaterialLabelRun["header"] => {
    const material = items.find((item) => String(item.id) === batch.itemId);
    return {
      categoryLine: String(material?.top_category_name ?? material?.category_name ?? ""),
      subCategoryLine: String(material?.sub_category_name ?? ""),
      attributes: material ? materialLabelAttributes(material) : [],
      partyName: batch.partyName,
      packQuantity: batch.packingQuantity == null ? "" : formatQuantity(batch.packingQuantity),
    };
  };

  const sheetTitleFor = (entries: RegisteredRun[]) => {
    const labels = entries.reduce((total, entry) => total + entry.qrCodes.length, 0);
    const names = entries.map((entry) => entry.batch.itemDisplayName);
    return {
      title: `Raw Material QR — ${entries[0]?.batch.partyName ?? ""}`,
      heading: entries[0]?.batch.partyName ?? "",
      subheading: `${names.join(" · ")} · ${labels.toLocaleString()} ${labels === 1 ? "code" : "codes"}`,
    };
  };

  /** Sends runs to the default printer as ONE job. Answers with why it did not print, or null. */
  const printRuns = async (entries: RegisteredRun[]): Promise<string | null> => {
    if (entries.length === 0) return null;
    const result = await printRawMaterialLabelRuns({
      ...sheetTitleFor(entries),
      runs: entries.map((entry) => ({ header: headerFor(entry.batch), ids: entry.qrCodes.map((code) => code.id) })),
    });
    if (!result.printed) return result.reason;
    const labels = entries.reduce((total, entry) => total + entry.qrCodes.length, 0);
    push("success", copy.labelPrint.sentTitle, copy.labelPrint.sentBody(labels));
    return null;
  };

  const openPreviewWindow = (entry: RegisteredRun) => {
    const { title, heading, subheading } = sheetTitleFor([entry]);
    if (!openRawMaterialLabelPrintWindow({ title, heading, subheading, header: headerFor(entry.batch), ids: entry.qrCodes.map((code) => code.id) })) {
      push("error", copy.toast.popupBlocked, "Allow popups to preview QR codes");
    }
  };

  /** Print pressed on the form: check it, then ask before anything is registered. */
  const requestPrint = () => {
    if (!canPrint) {
      const firstProblem = runs.length === 0 ? copy.labelPrint.nothingSelectedHint : copy.labelPrint.chooseSupplierFirst;
      push("error", "Check the form", !partyId ? copy.labelPrint.chooseSupplierFirst : firstProblem);
      return;
    }
    setConfirming({ kind: "new" });
  };

  /**
   * Confirmed: register one run per row, then print the lot as one job.
   *
   * Each row is its own transaction in the data layer, which reserves its serial range. The
   * first refusal stops the rest — and whatever was registered before it IS registered, so its
   * labels are printed anyway: a code that exists with no sticker on a packet is a packet
   * nobody can scan. The rows that went through leave the list so a second press cannot
   * register them twice.
   */
  const registerAndPrint = async (): Promise<string | null> => {
    setGenerating(true);
    const done: RegisteredRun[] = [];
    let refusal: string | null = null;
    try {
      for (const run of runs) {
        const { packets, perPacket } = runFigures(run);
        const result = await api.generateRawMaterialQrBatch({
          partyId,
          itemId: run.itemId,
          quantity: packets,
          packingQuantity: perPacket,
          createdBy: username?.trim() || undefined,
          requestedBy: requestedBy.trim() || undefined,
        });
        if (!result.accepted || !result.batch || !result.qrCodes) {
          refusal = copy.labelPrint.registerFailedFor(run.name, result.reason || copy.labelPrint.registerFailed);
          break;
        }
        done.push({ batch: result.batch, qrCodes: result.qrCodes });
      }
    } catch (error) {
      // A refused leased write names who writes the store, not a generic failure.
      refusal = refusal ?? leaseRefusalText(error) ?? copy.labelPrint.registerFailed;
    } finally {
      setGenerating(false);
    }

    if (done.length > 0) {
      setRegistered(done);
      setRuns((previous) => previous.slice(done.length));
      void loadHistory();
      const notPrinted = await printRuns(done);
      if (notPrinted) push("error", copy.labelPrint.notPrintedTitle, copy.labelPrint.notPrintedBody(notPrinted));
    }
    if (refusal) {
      push("error", copy.labelPrint.notPrintedTitle, `${refusal} ${copy.labelPrint.registeredSoFar(done.length)}`);
      return refusal;
    }
    setRequestedBy("");
    return null;
  };

  const reprintBatch = async (batch: RawMaterialQrBatchRow): Promise<string | null> => {
    let qrCodes: RawMaterialQrRow[];
    try {
      qrCodes = await api.listRawMaterialQrsForBatch(batch.id);
    } catch {
      return copy.labelPrint.codesLoadFailed;
    }
    return printRuns([{ batch, qrCodes }]);
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
    setRegistered((previous) => previous.filter((entry) => entry.batch.id !== erasing.id));
    void loadHistory();
    return null;
  };

  /** What the confirmation shows: the facts of what is about to be printed. */
  const confirmFacts = (request: PrintRequest): ConfirmFact[] => {
    if (request.kind === "reprint") {
      const { batch } = request;
      return [
        { label: copy.columns.supplier, value: batch.partyName },
        { label: "Raw Material", value: batch.itemDisplayName },
        {
          label: copy.labelPrint.factLabels,
          value: `${identityAt(batch.partyCode, batch.itemCode, batch.startSequence)} → ${identityAt(batch.partyCode, batch.itemCode, batch.endSequence)}`,
        },
      ];
    }
    return [
      { label: copy.columns.supplier, value: selectedParty?.partyName ?? "" },
      { label: copy.labelPrint.factMaterials, value: runs.map((run) => `${run.name} × ${run.packets}`).join(", ") },
      { label: copy.labelPrint.factLabels, value: totals.labels.toLocaleString() },
    ];
  };

  const knownPartyIds = new Set(suppliers.map((party) => party.id));
  const knownItemIds = new Set(items.map((item) => String(item.id)));

  return (
    <div className="rm-labels">
      <form
        className="card qr-generate-card"
        onSubmit={(event) => {
          event.preventDefault();
          requestPrint();
        }}
      >
        <div className="qr-steps qr-steps--runs">
          <section className="qr-step">
            <StepHeading index={1} done={Boolean(selectedParty)} title={copy.labelPrint.stepSupplier} />
            <div className="qr-step-body">
              <SearchableCombobox
                value={partyId}
                options={partyOptions}
                placeholder={partyOptions.length === 0 ? "No suppliers yet" : "Choose supplier…"}
                emptyLabel="No suppliers found"
                ariaLabel={copy.columns.supplier}
                onChange={setPartyId}
                dropdown
              />
              <p className="field-help">From Party Management — suppliers cannot be created here.</p>
            </div>
          </section>

          <section className="qr-step">
            <StepHeading index={2} done={runs.length > 0} title={copy.labelPrint.stepMaterials} />
            <div className="qr-step-body">
              <MaterialPickerTable
                items={items}
                chosenItemIds={chosenItemIds}
                onAdd={(item) => addRun(item)}
                onRemoveAll={(itemId) => setRuns((previous) => previous.filter((run) => run.itemId !== itemId))}
              />
            </div>
          </section>

          <section className="qr-step">
            <StepHeading index={3} done={everyRunReady} title={copy.labelPrint.stepSelected} />
            <span className="qr-step-note">{copy.labelPrint.stepSelectedHint}</span>
            <div className="qr-step-body">
              <SelectedRunsTable runs={runs} onChange={changeRun} onRemove={(key) => setRuns((previous) => previous.filter((run) => run.key !== key))} onClear={() => setRuns([])} />

              {/* What a packet holds is recorded in the material's stock unit, so without one
                  there is nothing to print. Set it here rather than send the operator away. */}
              {unitless.length > 0 && units ? (
                <div className="rm-unit-missing">
                  <p className="qr-error">⚠ {copy.labelPrint.unitMissing(unitless.length)}</p>
                  {unitless.map((run) => (
                    <StockUnitPicker
                      key={run.key}
                      itemId={run.itemId}
                      displayName={run.name}
                      units={units}
                      onSaved={async () => {
                        await Promise.all([loadLookups(), onLookupsChanged?.()]);
                      }}
                    />
                  ))}
                </div>
              ) : null}

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
                  Kept with every run in this print. You{username ? ` (${username})` : ""} are recorded as the operator.
                </p>
              </div>
            </div>
          </section>
        </div>

        <div className="qr-commit">
          {!partyId && runs.length > 0 ? <p className="qr-error">{copy.labelPrint.chooseSupplierFirst}</p> : null}
          <button type="submit" className="btn btn-primary btn-lg qr-generate-btn" disabled={!canPrint}>
            {generating ? copy.labelPrint.printing : copy.labelPrint.printRuns}
          </button>
        </div>
      </form>

      {registered.map((entry) => (
        <LabelRunResult
          key={entry.batch.id}
          batch={entry.batch}
          qrCodes={entry.qrCodes}
          unitCode={unitCodeOf(entry.batch.itemId)}
          identityAt={identityAt}
          onPreview={() => openPreviewWindow(entry)}
          onPrintAgain={() => setConfirming({ kind: "reprint", batch: entry.batch })}
        />
      ))}

      <LabelRunHistory
        history={history}
        loading={loadingHistory}
        error={historyError}
        onReload={() => void loadHistory()}
        configByItem={configByItem}
        unitCodeOf={unitCodeOf}
        identityAt={identityAt}
        canReuse={(batch) => knownPartyIds.has(batch.partyId) && knownItemIds.has(batch.itemId)}
        onUseAgain={(batch) => {
          setPartyId(batch.partyId);
          const item = items.find((candidate) => String(candidate.id) === batch.itemId);
          if (item) addRun(item, batch.packingQuantity);
        }}
        onReprint={(batch) => setConfirming({ kind: "reprint", batch })}
        onErase={setErasing}
      />

      {confirming ? (
        <ConfirmDialog
          title={
            confirming.kind === "new"
              ? copy.labelPrint.confirmRunsTitle(totals.labels, totals.articles)
              : copy.labelPrint.reprintTitle(confirming.batch.quantity)
          }
          facts={confirmFacts(confirming)}
          explain={confirming.kind === "new" ? copy.labelPrint.confirmExplain : copy.labelPrint.reprintExplain}
          warning={confirming.kind === "reprint" ? copy.labelPrint.reprintWarning : null}
          confirmLabel={copy.labelPrint.confirmButton}
          tone="primary"
          busyLabel={copy.labelPrint.printing}
          onConfirm={confirming.kind === "new" ? registerAndPrint : () => reprintBatch(confirming.batch)}
          onClose={() => setConfirming(null)}
        />
      ) : null}

      {erasing ? (
        <ConfirmDialog
          title={copy.removal.deleteRunTitle(erasing.quantity)}
          facts={[
            { label: copy.columns.supplier, value: erasing.partyName },
            { label: "Raw Material", value: erasing.itemDisplayName },
            {
              label: copy.labelPrint.factLabels,
              value: `${identityAt(erasing.partyCode, erasing.itemCode, erasing.startSequence)} → ${identityAt(erasing.partyCode, erasing.itemCode, erasing.endSequence)}`,
            },
          ]}
          explain={copy.removal.deleteRunExplain}
          warning={copy.removal.deleteRunWarning}
          confirmLabel={copy.actions.delete}
          busyLabel={copy.removal.erasing}
          onConfirm={eraseRun}
          onClose={() => setErasing(null)}
        />
      ) : null}

      {items.length === 0 ? <StateView kind="empty" compact title={copy.labelPrint.noMaterialsTitle} hint={copy.labelPrint.noMaterialsHint} /> : null}
    </div>
  );
};
