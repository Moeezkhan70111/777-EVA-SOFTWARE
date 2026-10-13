import React, { useCallback, useEffect, useMemo, useState } from "react";
import { B_CARTON_COLOUR, CARTON_GRADE } from "@erp/domain";
import { useDesktopApi } from "../hooks/useDesktopApi";
import { useNotifications } from "../state/NotificationsContext";
import { SearchableCombobox } from "../components/shared/SearchableCombobox";
import { StateView } from "../components/shared/StateView";
import { StepHeading } from "../components/shared/StepHeading";
import { openCartonLabelPrintWindow } from "../utils/qrLabels";
import { copy } from "../config/copy";
import type { ProductRow, QrBatchRow, QrCodeRow, QrSequenceState } from "../types/desktopApi";
import {
  bCartonQuantityProblem,
  bCartonRange,
  isBCartonBatch,
  type BCartonRange,
} from "../features/products/bCartonLabels";

// B CARTON LABELS — the second-grade cartons' own label run.
//
//   ① Article + Size   [ EVR9 / 7/10   ▾ ]
//   ② How many         [ 24 ]              COLOUR  MIX
//                      Will register EVR9_MIX_7/10_000001 → …_000024
//                      [ Generate 24 labels ]
//
// A B carton is a carton whose contents are MIXED colours, so it names no colour: its identity
// carries MIX and its sticker prints a boxed B (migration 074). Until now the only way to get
// these labels was converting a FIX run's unreturned labels on Program Close — the floor also
// needs to label B cartons that simply come off the line, which is what this page is for.
//
// It is the ordinary carton registry underneath: the same generateQrBatch, the same permanent
// identity, the same sticker template — only the colour is decided (MIX) and the grade is set,
// so nothing here is a second QR generator.

interface BCartonGeneratorPageProps {
  /** The logged-in operator; recorded as who generated each run. */
  username?: string;
}

/** The recent B runs this page shows, newest first. */
const RECENT_LIMIT = 8;

export const BCartonGeneratorPage: React.FC<BCartonGeneratorPageProps> = ({ username }) => {
  const api = useDesktopApi();
  const { push } = useNotifications();

  const [products, setProducts] = useState<ProductRow[]>([]);
  const [loadingProducts, setLoadingProducts] = useState(true);
  const [productsError, setProductsError] = useState<string | null>(null);
  const [articleSizeId, setArticleSizeId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [sequence, setSequence] = useState<QrSequenceState | null>(null);
  const [generating, setGenerating] = useState(false);
  const [lastRun, setLastRun] = useState<{ batch: QrBatchRow; qrCodes: QrCodeRow[] } | null>(null);
  const [recent, setRecent] = useState<QrBatchRow[]>([]);

  const loadProducts = useCallback(async () => {
    setLoadingProducts(true);
    setProductsError(null);
    try {
      const result = await api.listProducts({ status: "ACTIVE", pageSize: 1000 });
      setProducts(result.rows);
    } catch {
      setProductsError(copy.states.loadFailedBody);
    } finally {
      setLoadingProducts(false);
    }
  }, [api]);

  // Only this page's own runs: the ordinary carton runs belong to the QR Generator's history.
  const loadRecent = useCallback(async () => {
    try {
      const batches = await api.listQrBatches({ limit: 100 });
      setRecent(batches.filter(isBCartonBatch).slice(0, RECENT_LIMIT));
    } catch {
      setRecent([]);
    }
  }, [api]);

  useEffect(() => {
    void loadProducts();
    void loadRecent();
  }, [loadProducts, loadRecent]);

  // Where this article's MIX sequence actually stands, so the operator reads the real range
  // before committing rather than a guessed shape.
  useEffect(() => {
    let cancelled = false;
    if (!articleSizeId) {
      setSequence(null);
      return;
    }
    void (async () => {
      try {
        const state = await api.getQrSequenceState({ articleSizeId, color: B_CARTON_COLOUR });
        if (!cancelled) setSequence(state);
      } catch {
        if (!cancelled) setSequence(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, articleSizeId]);

  const options = useMemo(
    () =>
      products
        .filter((product) => product.articleSizeId)
        .map((product) => ({
          value: product.articleSizeId as string,
          label: `${product.article} / ${product.size}`,
          keywords: product.article,
        })),
    [products]
  );

  const problem = bCartonQuantityProblem(quantity);
  const range: BCartonRange | null = bCartonRange(sequence, quantity);
  const canGenerate = Boolean(articleSizeId) && range !== null && !generating;

  const printRun = (batch: QrBatchRow, qrCodes: QrCodeRow[]): void => {
    const opened = openCartonLabelPrintWindow({
      title: `${copy.bCartons.title} — ${batch.article} ${batch.size}`,
      // The stickers say B, not a colour, so the window above them says the same.
      heading: `${batch.article} / ${batch.size} / ${CARTON_GRADE.B}`,
      subheading: copy.bCartons.printSubheading(qrCodes.length),
      identity: { article: batch.article, color: batch.color, size: batch.size, grade: CARTON_GRADE.B },
      ids: qrCodes.map((code) => code.id),
    });
    if (!opened) push("error", copy.toast.popupBlocked, copy.bCartons.popupBlocked);
  };

  const generate = async () => {
    if (!canGenerate || !range) return;
    setGenerating(true);
    try {
      const result = await api.generateQrBatch({
        articleSizeId,
        color: B_CARTON_COLOUR,
        quantity: range.quantity,
        createdBy: username?.trim() || undefined,
        grade: CARTON_GRADE.B,
      });
      if (!result.accepted || !result.batch || !result.qrCodes) {
        push("error", copy.bCartons.failedTitle, result.reason ?? copy.states.loadFailedBody);
        return;
      }
      setLastRun({ batch: result.batch, qrCodes: result.qrCodes });
      push("success", copy.bCartons.doneTitle, copy.bCartons.doneBody(result.qrCodes.length, result.batch.article, result.batch.size));
      setQuantity("");
      printRun(result.batch, result.qrCodes);
      void loadRecent();
    } catch {
      push("error", copy.bCartons.failedTitle, copy.states.loadFailedBody);
    } finally {
      setGenerating(false);
    }
  };

  const reprint = async (batch: QrBatchRow) => {
    try {
      const codes = (await api.listQrCodesForBatch(batch.id)).filter((code) => code.status !== "VOID");
      if (codes.length === 0) {
        push("error", copy.bCartons.failedTitle, copy.bCartons.reprintNone);
        return;
      }
      printRun(batch, codes);
    } catch {
      push("error", copy.bCartons.failedTitle, copy.states.loadFailedBody);
    }
  };

  return (
    <div className="page qr-generator-page">
      <div className="page-header">
        <h1>{copy.bCartons.title}</h1>
      </div>

      <form
        className="card qr-generate-card"
        onSubmit={(event) => {
          event.preventDefault();
          void generate();
        }}
      >
        <div className="card-header">
          <h2 className="card-title">{copy.bCartons.generate}</h2>
          <span className="qr-flow-hint">{copy.bCartons.flowHint}</span>
        </div>

        {loadingProducts && products.length === 0 ? (
          <StateView kind="loading" />
        ) : productsError ? (
          <StateView kind="error" message={productsError} onRetry={() => void loadProducts()} />
        ) : products.length === 0 ? (
          <StateView kind="empty" title={copy.bCartons.noProductsTitle} hint={copy.bCartons.noProductsHint} />
        ) : (
          <>
            <div className="qr-steps">
              <section className="qr-step">
                <StepHeading index={1} done={Boolean(articleSizeId)} title={copy.bCartons.articleSize} />
                <div className="qr-step-body">
                  <SearchableCombobox
                    dropdown
                    value={articleSizeId}
                    options={options}
                    placeholder={copy.bCartons.choose}
                    ariaLabel={copy.bCartons.articleSize}
                    emptyLabel={copy.bCartons.noMatch}
                    onChange={setArticleSizeId}
                  />
                  <p className="field-help">{copy.bCartons.colourIsMix}</p>
                </div>
              </section>

              <section className="qr-step">
                <StepHeading index={2} done={range !== null} title={copy.bCartons.howMany} />
                <div className="qr-step-body">
                  <label className="section-label" htmlFor="bq-quantity">
                    {copy.bCartons.labelsToPrint}
                  </label>
                  <input
                    id="bq-quantity"
                    className="form-input"
                    type="text"
                    inputMode="numeric"
                    value={quantity}
                    autoComplete="off"
                    aria-invalid={problem ? true : undefined}
                    onChange={(event) => setQuantity(event.target.value)}
                  />
                  {problem ? (
                    <p className="mp-problem" role="alert">
                      ⚠ {problem}
                    </p>
                  ) : null}
                </div>
              </section>
            </div>

            <div className="qr-commit">
              {range && sequence ? (
                <div className="qr-pending" aria-live="polite">
                  <p className="summary-block-title">{copy.bCartons.willRegister(range.quantity)}</p>
                  <div className="qr-range">
                    <code className="qr-identity">{range.first}</code>
                    <span className="qr-range-sep">→</span>
                    <code className="qr-identity">{range.last}</code>
                  </div>
                  <p className="field-help">
                    {range.isFirstEver
                      ? copy.bCartons.firstEver
                      : copy.bCartons.continuesAfter(range.alreadyGenerated)}
                  </p>
                </div>
              ) : (
                <p className="qr-pending-empty" aria-live="polite">
                  {copy.bCartons.chooseToSeeRange}
                </p>
              )}

              <button type="submit" className="btn btn-primary btn-lg qr-generate-btn" disabled={!canGenerate}>
                {generating ? copy.bCartons.generating : copy.bCartons.generateCount(range?.quantity ?? null)}
              </button>
            </div>
          </>
        )}
      </form>

      {lastRun ? (
        <div className="qr-input-card qr-result-card">
          <div className="card-header">
            <h2 className="card-title">
              <span className="badge badge-ok">{copy.bCartons.done}</span> {copy.bCartons.doneTitle}
            </h2>
            <button type="button" className="btn btn-primary" onClick={() => printRun(lastRun.batch, lastRun.qrCodes)}>
              {copy.bCartons.printAgain}
            </button>
          </div>
          <div className="qr-result-facts">
            <div>
              <span className="section-label">{copy.columns.product}</span>
              <strong>{lastRun.batch.article}</strong>
            </div>
            <div>
              <span className="section-label">{copy.columns.size}</span>
              <strong>{lastRun.batch.size}</strong>
            </div>
            {/* No colour row: a B carton has none, which is the whole reason it prints a B. */}
            <div>
              <span className="section-label">{copy.bCartons.grade}</span>
              <strong>{CARTON_GRADE.B}</strong>
            </div>
            <div>
              <span className="section-label">{copy.columns.quantity}</span>
              <strong>{lastRun.batch.quantity.toLocaleString()}</strong>
            </div>
          </div>
        </div>
      ) : null}

      <div className="card">
        <div className="card-header">
          <h2 className="card-title">{copy.bCartons.recentTitle}</h2>
        </div>
        {recent.length === 0 ? (
          <StateView kind="empty" compact title={copy.bCartons.noRecentTitle} hint={copy.bCartons.noRecentHint} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">{copy.columns.product}</th>
                  <th scope="col">{copy.columns.size}</th>
                  <th scope="col" className="num">
                    {copy.columns.quantity}
                  </th>
                  <th scope="col">{copy.bCartons.generatedBy}</th>
                  <th scope="col">{copy.columns.actions}</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((batch) => (
                  <tr key={batch.id}>
                    <td>{batch.article}</td>
                    <td>{batch.size}</td>
                    <td className="num">{batch.quantity.toLocaleString()}</td>
                    <td>{batch.createdBy ?? "—"}</td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        aria-label={copy.bCartons.reprintOf(batch.article, batch.size)}
                        onClick={() => void reprint(batch)}
                      >
                        {copy.bCartons.reprint}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
