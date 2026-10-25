import React, { useCallback, useEffect, useRef, useState } from "react";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { useNotifications } from "../../state/NotificationsContext";
import type { InventoryImportColumn, InventoryImportResult } from "../../types/desktopApi";
import { StateView } from "../../components/shared/StateView";
import { downloadCsv } from "../../utils/exportFile";
import { ImportFileError, readSheetFile } from "../../utils/importFile";
import { Modal } from "./Modal";
import type { CategoryRow } from "./rawMaterial";
import { leaseRefusalText } from "../../../shared/leaseRefusal";

// Creating raw materials in bulk from a spreadsheet.
//
//   pick a category → download its template → upload → PREVIEW → confirm → summary
//
// The preview is the point. Uploading a file never writes anything: the same validation runs
// twice, once to show the operator exactly what will happen and once to do it, and the write
// itself is one transaction. Nothing is skipped quietly — every rejected row is named with
// its reason, before and after.
//
// The template is generated FOR THE CHOSEN CATEGORY, because attributes are per-category:
// RUBBER UPPER wants ARTICLE / COLOR / SIZE, BUCKLE does not. A single fixed template could
// only ever fit one category.

type Step = "choose" | "preview" | "done";

interface ImportMaterialsModalProps {
  categories: CategoryRow[];
  onClose: () => void;
  /** Re-reads the list once materials were actually created. */
  onImported: () => Promise<void>;
}

export const ImportMaterialsModal: React.FC<ImportMaterialsModalProps> = ({ categories, onClose, onImported }) => {
  const api = useDesktopApi();
  const { push } = useNotifications();

  const [step, setStep] = useState<Step>("choose");
  const [categoryId, setCategoryId] = useState("");
  const [columns, setColumns] = useState<InventoryImportColumn[]>([]);
  const [rows, setRows] = useState<Array<Record<string, string>>>([]);
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<InventoryImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const category = categories.find((row) => String(row.id) === categoryId);

  const loadColumns = useCallback(async () => {
    if (!categoryId) {
      setColumns([]);
      return;
    }
    const result = await api.getInventoryImportColumns(categoryId);
    setColumns(result.accepted && result.columns ? result.columns : []);
  }, [api, categoryId]);

  useEffect(() => {
    void loadColumns();
  }, [loadColumns]);

  const downloadTemplate = () => {
    if (!category || columns.length === 0) return;
    downloadCsv(`raw-material-template-${String(category.name).toLowerCase().replace(/\s+/g, "-")}`, {
      preamble: [
        `Raw material import template — ${String(category.name)}`,
        "Fill in one material per row, then upload this file. Keep the heading row as it is.",
        ...columns.map((column) => `${column.header}${column.required ? " (required)" : ""}: ${column.hint}`),
      ],
      headers: columns.map((column) => column.header),
      rows: [columns.map((column) => (column.required ? "" : ""))],
    });
  };

  const chooseFile = async (file: File) => {
    setError(null);
    setBusy(true);
    try {
      const sheet = await readSheetFile(file);
      setFileName(file.name);
      setRows(sheet.rows);
      const result = await api.importInventoryItems({ categoryId, rows: sheet.rows, dryRun: true });
      if (!result.accepted || !result.result) {
        setError(result.reason ?? "The file could not be read.");
        return;
      }
      setPreview(result.result);
      setStep("preview");
    } catch (cause) {
      setError(cause instanceof ImportFileError ? cause.message : (leaseRefusalText(cause) ?? "The file could not be read."));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const confirmImport = async () => {
    setBusy(true);
    try {
      const result = await api.importInventoryItems({ categoryId, rows, dryRun: false });
      if (!result.accepted || !result.result) {
        push("error", "Nothing imported", result.reason ?? "The file could not be imported.");
        return;
      }
      setPreview(result.result);
      setStep("done");
      push("success", "Import finished", `${result.result.created} material${result.result.created === 1 ? "" : "s"} created`);
      await onImported();
    } finally {
      setBusy(false);
    }
  };

  const footer =
    step === "preview" && preview && preview.missingColumns.length === 0 && preview.rows.some((row) => row.outcome === "CREATE") ? (
      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void confirmImport()}>
        {busy ? "Importing…" : `Create ${preview.rows.filter((row) => row.outcome === "CREATE").length} materials`}
      </button>
    ) : step === "done" ? (
      <button type="button" className="btn btn-primary" onClick={onClose}>
        Done
      </button>
    ) : undefined;

  return (
    <Modal
      title="Import raw materials"
      subtitle={
        step === "choose"
          ? "Create many materials at once from a spreadsheet."
          : step === "preview"
            ? `Checked ${fileName} — nothing has been saved yet.`
            : "Finished."
      }
      wide
      onClose={onClose}
      footer={footer}
    >
      {step === "choose" ? (
        <>
          <div className="form-group">
            <label className="input-label" htmlFor="rm-import-category">
              Which category are these materials in?<span className="required-mark"> *</span>
            </label>
            <select
              id="rm-import-category"
              className="form-input"
              value={categoryId}
              onChange={(event) => setCategoryId(event.target.value)}
            >
              <option value="">Select a category…</option>
              {categories.map((row) => (
                <option key={String(row.id)} value={String(row.id)}>
                  {String(row.name)}
                </option>
              ))}
            </select>
            <span className="field-help">
              Each category asks for different attributes, so the template is made for the one you pick.
            </span>
          </div>

          {columns.length > 0 ? (
            <>
              <span className="section-label">The file needs these columns</span>
              <table className="data-table rm-import-columns">
                <thead>
                  <tr>
                    <th scope="col">Column</th>
                    <th scope="col">Required</th>
                    <th scope="col">What goes in it</th>
                  </tr>
                </thead>
                <tbody>
                  {columns.map((column) => (
                    <tr key={column.header}>
                      <td>
                        <strong>{column.header}</strong>
                      </td>
                      <td>{column.required ? "Yes" : "Optional"}</td>
                      <td className="rm-muted">{column.hint}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="field-help">
                A material's route out of the store is not imported — pick the destinations on the Stock tab afterwards.
              </p>

              <div className="rm-import-actions">
                <button type="button" className="btn btn-secondary" onClick={downloadTemplate}>
                  ⬇ Download template
                </button>
                <button type="button" className="btn btn-primary" disabled={busy} onClick={() => fileRef.current?.click()}>
                  {busy ? "Checking…" : "Upload filled file…"}
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".csv,.txt,text/csv"
                  hidden
                  aria-label="Spreadsheet to import"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void chooseFile(file);
                  }}
                />
              </div>
            </>
          ) : null}

          {error ? <StateView kind="error" compact title="That file could not be read" message={error} /> : null}
        </>
      ) : null}

      {step !== "choose" && preview ? <ImportOutcome result={preview} /> : null}
    </Modal>
  );
};

/** The preview and the summary are the same table — before and after are the same facts. */
const ImportOutcome: React.FC<{ result: InventoryImportResult }> = ({ result }) => {
  if (result.missingColumns.length > 0) {
    return (
      <StateView
        kind="error"
        title="The file is missing required columns"
        message={`Add these headings and upload it again: ${result.missingColumns.join(", ")}.`}
      />
    );
  }

  const label: Record<string, string> = {
    CREATE: result.applied ? "✓ Created" : "Will be created",
    DUPLICATE: "Already exists",
    REJECTED: "✕ Rejected",
  };

  return (
    <>
      <div className="rm-kpis rm-import-summary">
        <div className="rm-kpi">
          <span className="rm-kpi-label">Rows in file</span>
          <strong className="rm-kpi-value">{result.totalRows}</strong>
        </div>
        <div className="rm-kpi">
          <span className="rm-kpi-label">{result.applied ? "Created" : "To create"}</span>
          <strong className="rm-kpi-value">{result.applied ? result.created : result.rows.filter((row) => row.outcome === "CREATE").length}</strong>
        </div>
        <div className="rm-kpi">
          <span className="rm-kpi-label">Already exist</span>
          <strong className="rm-kpi-value">{result.duplicates}</strong>
        </div>
        <div className="rm-kpi">
          <span className="rm-kpi-label">Rejected</span>
          <strong className="rm-kpi-value">{result.rejected}</strong>
        </div>
      </div>

      {result.rejected > 0 && !result.applied ? (
        <p className="rm-correction-error">
          {result.rejected} row{result.rejected === 1 ? "" : "s"} will be left out. Fix them in the file and upload it again, or
          continue to import the rest.
        </p>
      ) : null}

      <div className="rm-import-rows">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Row</th>
              <th scope="col">Material</th>
              <th scope="col">Outcome</th>
              <th scope="col">Why</th>
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row) => (
              <tr key={row.rowNumber} className={`rm-import-row--${row.outcome.toLowerCase()}`}>
                <td className="rm-num">{row.rowNumber}</td>
                <td>
                  {row.displayName || "—"}
                  {row.itemCode ? <span className="cell-mono rm-row-code">{row.itemCode}</span> : null}
                </td>
                <td>{label[row.outcome]}</td>
                <td className="rm-muted">{row.problems.join("; ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
};
