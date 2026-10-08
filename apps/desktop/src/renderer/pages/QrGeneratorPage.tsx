import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { buildQrId, formatQrSerial, normalizeQrColor } from "@erp/domain";
import type { AppRoute } from "../app/routes";
import { useDesktopApi } from "../hooks/useDesktopApi";
import type {
  QrBatchRow,
  QrCodeRow,
  QrSequenceState,
  ProductRow,
} from "../types/desktopApi";
import { useNotifications } from "../state/NotificationsContext";
import { QrPreview, openCartonLabelPrintWindow } from "../utils/qrLabels";
import { formatDate, formatTime } from "../utils/dates";
import { copy } from "../config/copy";
import { StepHeading } from "../components/shared/StepHeading";

const MAX_QUANTITY = 10000;
const QUICK_QUANTITIES = [50, 100, 250, 500, 1000];
const PREVIEW_LIMIT = 12;
// This page only shows what was just done; the full, searchable record lives in QR Management.
const RECENT_HISTORY_LIMIT = 10;

// Rebuilds a stored batch's identity range for display. Uses the same domain builder the
// generator writes with, so what the operator reads always matches what is registered.
const identityAt = (
  parts: { article: string; color: string; size: string },
  sequence: number,
): string => {
  try {
    return buildQrId({ ...parts, sequence });
  } catch {
    return `${parts.article}_${parts.color}_${parts.size}_${formatQrSerial(sequence)}`;
  }
};

// Same dropdown-select-only combobox keyboard behaviour as the Add/Edit Product page's
// Article/Size/Group fields: arrows move the highlight, Enter picks it, Escape closes
// the menu without letting the keystroke bubble up to the app's global Escape handler.
function makeComboboxKeyDown<T>(
  menuOpen: boolean,
  setMenuOpen: (v: boolean) => void,
  highlight: number,
  setHighlight: React.Dispatch<React.SetStateAction<number>>,
  items: T[],
  onSelect: (item: T) => void,
) {
  return (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!menuOpen) setMenuOpen(true);
      setHighlight((n) => Math.min(n + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((n) => Math.max(n - 1, 0));
    } else if (e.key === "Enter" && menuOpen && items.length > 0) {
      e.preventDefault();
      onSelect(items[highlight] ?? items[0]);
    } else if (e.key === "Escape") {
      e.stopPropagation();
      setMenuOpen(false);
    }
  };
}

interface QrGeneratorPageProps {
  onNavigate?: (route: AppRoute) => void;
  /** The logged-in operator; recorded as who generated each run. */
  username?: string;
}

const REQUESTED_BY_MAX = 120;

export const QrGeneratorPage: React.FC<QrGeneratorPageProps> = ({ onNavigate, username }) => {
  const api = useDesktopApi();
  const { push } = useNotifications();

  const [products, setProducts] = useState<ProductRow[]>([]);
  const [knownColors, setKnownColors] = useState<string[]>([]);
  const [articleSizeId, setArticleSizeId] = useState("");
  const [color, setColor] = useState("");
  const [quantity, setQuantity] = useState("");
  // Who asked for the codes (optional) — a person's name, kept with the run for the audit trail.
  const [requestedBy, setRequestedBy] = useState("");

  // Product combobox — same dropdown-select-only pattern as the Add/Edit Product page's
  // Article/Size fields: typing filters the list, the value is only set by picking an item.
  const [productQuery, setProductQuery] = useState("");
  const [productMenuOpen, setProductMenuOpen] = useState(false);
  const [productHighlight, setProductHighlight] = useState(0);

  // Colour combobox — same pattern, with a "+" button opening an Add New Colour modal
  // instead of an inline reveal (matching Product Master's Add New Article/Size modals).
  const [colorQuery, setColorQuery] = useState("");
  const [colorMenuOpen, setColorMenuOpen] = useState(false);
  const [colorHighlight, setColorHighlight] = useState(0);
  const [showAddColorModal, setShowAddColorModal] = useState(false);
  const [newColorModalValue, setNewColorModalValue] = useState("");
  const [generating, setGenerating] = useState(false);
  const [sequence, setSequence] = useState<QrSequenceState | null>(null);
  const [lastResult, setLastResult] = useState<{
    batch: QrBatchRow;
    qrCodes: QrCodeRow[];
  } | null>(null);
  const [history, setHistory] = useState<QrBatchRow[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [copied, setCopied] = useState(false);

  const quantityRef = useRef<HTMLInputElement | null>(null);

  const loadProducts = useCallback(async () => {
    try {
      const result = await api.listProducts({
        status: "ACTIVE",
        pageSize: 1000,
      });
      setProducts(result.rows);
    } catch {
      push("error", copy.toast.loadFailed, "Could not load products");
    }
  }, [api, push]);

  const loadColors = useCallback(async () => {
    try {
      setKnownColors(await api.listQrColors());
    } catch {
      setKnownColors([]);
    }
  }, [api]);

  const loadHistory = useCallback(async () => {
    setLoadingHistory(true);
    try {
      setHistory(await api.listQrBatches({ limit: RECENT_HISTORY_LIMIT }));
    } catch {
      push("error", copy.toast.loadFailed, "Could not load recent generations");
    } finally {
      setLoadingHistory(false);
    }
  }, [api, push]);

  useEffect(() => {
    void loadProducts();
    void loadColors();
    void loadHistory();
  }, [loadProducts, loadColors, loadHistory]);

  // Same suppression the Add/Edit Product page uses: while a combobox menu or the Add New
  // Colour modal is open, the app's global Escape handler must not navigate to Dashboard.
  const anyOverlayOpen = productMenuOpen || colorMenuOpen || showAddColorModal;
  useEffect(() => {
    if (!anyOverlayOpen) return;
    const sentinel = document.createElement("div");
    sentinel.setAttribute("data-suppress-esc", "1");
    sentinel.style.display = "none";
    document.body.appendChild(sentinel);
    return () => {
      sentinel.remove();
    };
  }, [anyOverlayOpen]);

  const selectedProduct = useMemo(
    () => products.find((p) => p.articleSizeId === articleSizeId) ?? null,
    [products, articleSizeId],
  );

  const effectiveColor = normalizeQrColor(color);

  // Ask the database where this combination's sequence actually stands, so the operator
  // sees the real serial range rather than a placeholder shape.
  useEffect(() => {
    let cancelled = false;
    if (!articleSizeId || !effectiveColor) {
      setSequence(null);
      return;
    }
    void (async () => {
      try {
        const state = await api.getQrSequenceState({
          articleSizeId,
          color: effectiveColor,
        });
        if (!cancelled) setSequence(state);
      } catch {
        if (!cancelled) setSequence(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, articleSizeId, effectiveColor]);

  const filteredProducts = useMemo(() => {
    const needle = productQuery.trim().toLowerCase();
    if (!needle) return products;
    return products.filter((p) =>
      `${p.article} ${p.size}`.toLowerCase().includes(needle),
    );
  }, [products, productQuery]);

  // Colours already used for this product come first — they are the likely choice.
  const colorOptions = useMemo(() => {
    const onProduct = (selectedProduct?.colors ?? [])
      .map(normalizeQrColor)
      .filter(Boolean);
    const rest = knownColors
      .map(normalizeQrColor)
      .filter((c) => c && !onProduct.includes(c));
    return { onProduct: [...new Set(onProduct)], rest: [...new Set(rest)] };
  }, [selectedProduct, knownColors]);

  const filteredColorOptions = useMemo(() => {
    const all = [...colorOptions.onProduct, ...colorOptions.rest];
    const needle = colorQuery.trim().toLowerCase();
    if (!needle) return all;
    return all.filter((c) => c.toLowerCase().includes(needle));
  }, [colorOptions, colorQuery]);

  const quantityValue = quantity.trim() === "" ? NaN : Number(quantity);
  const quantityError = useMemo(() => {
    if (quantity.trim() === "") return null;
    if (!Number.isFinite(quantityValue) || !Number.isInteger(quantityValue))
      return "Enter a whole number.";
    if (quantityValue <= 0) return "Quantity must be at least 1.";
    if (quantityValue > MAX_QUANTITY)
      return `Maximum ${MAX_QUANTITY.toLocaleString()} per batch.`;
    return null;
  }, [quantity, quantityValue]);

  const colorError = useMemo(() => {
    if (!effectiveColor) return null;
    if (!/^[A-Z0-9]+$/.test(effectiveColor))
      return "Use letters and digits only — no spaces or punctuation.";
    return null;
  }, [effectiveColor]);

  const quantityOk =
    Number.isInteger(quantityValue) && quantityValue > 0 && !quantityError;

  // The exact range this generation will register, known before the operator commits.
  const pendingRange = useMemo(() => {
    if (!selectedProduct || !sequence || colorError || !quantityOk) return null;
    const parts = {
      article: sequence.article,
      color: sequence.color,
      size: sequence.size,
    };
    const start = sequence.nextSequence;
    const end = start + quantityValue - 1;
    return {
      first: identityAt(parts, start),
      last: identityAt(parts, end),
      start,
      end,
      isFirstEver: sequence.lastSequence === 0,
      alreadyGenerated: sequence.lastSequence,
    };
  }, [selectedProduct, sequence, colorError, quantityOk, quantityValue]);

  const canGenerate =
    Boolean(articleSizeId) &&
    Boolean(effectiveColor) &&
    !colorError &&
    quantityOk &&
    !generating;

  const resetForm = () => {
    setQuantity("");
    setColor("");
    setColorQuery("");
    setRequestedBy("");
  };

  // Dropdown-select-only, same as Product Master's Article/Size fields: the value is set
  // only by picking an item (click or Enter), never by the raw typed text.
  const selectProduct = (id: string) => {
    setArticleSizeId(id);
    setProductQuery("");
    setProductMenuOpen(false);
    setProductHighlight(0);
  };

  const selectColor = (value: string) => {
    setColor(value);
    setColorQuery("");
    setColorMenuOpen(false);
    setColorHighlight(0);
    if (value) window.setTimeout(() => quantityRef.current?.focus(), 0);
  };

  const productKeyDown = makeComboboxKeyDown(
    productMenuOpen,
    setProductMenuOpen,
    productHighlight,
    setProductHighlight,
    filteredProducts,
    (p) => selectProduct(p.articleSizeId ?? p.id),
  );

  const colorKeyDown = makeComboboxKeyDown(
    colorMenuOpen,
    setColorMenuOpen,
    colorHighlight,
    setColorHighlight,
    filteredColorOptions,
    (c) => selectColor(c),
  );

  // Mirrors Product Master's Add New Article/Size modals: a small popup instead of an
  // inline reveal, with the new value immediately available in the dropdown.
  const handleAddColor = () => {
    const normalized = normalizeQrColor(newColorModalValue);
    if (!normalized) return;
    if (!/^[A-Z0-9]+$/.test(normalized)) {
      push(
        "error",
        "Invalid colour",
        "Use letters and digits only — no spaces or punctuation.",
      );
      return;
    }
    setKnownColors((prev) => [...new Set([...prev, normalized])]);
    selectColor(normalized);
    setShowAddColorModal(false);
    setNewColorModalValue("");
  };

  const openPrintWindow = (batch: QrBatchRow, qrCodes: QrCodeRow[]) => {
    const ok = openCartonLabelPrintWindow({
      title: `QR Codes — ${batch.article} ${batch.color} ${batch.size}`,
      heading: `${batch.article} / ${batch.size} / ${batch.color}`,
      subheading: `${identityAt(batch, batch.startSequence)} → ${identityAt(batch, batch.endSequence)} · ${batch.quantity} codes`,
      identity: { article: batch.article, color: batch.color, size: batch.size },
      ids: qrCodes.map((b) => b.id),
    });
    if (!ok) push("error", copy.toast.popupBlocked, "Allow popups to print/download QR labels");
  };

  const handleGenerate = async () => {
    if (!canGenerate) {
      push(
        "error",
        "Check the form",
        colorError ??
          quantityError ??
          "Select a product and colour, then enter a quantity",
      );
      return;
    }

    setGenerating(true);
    try {
      const result = await api.generateQrBatch({
        articleSizeId,
        color: effectiveColor,
        quantity: quantityValue,
        createdBy: username?.trim() || undefined,
        requestedBy: requestedBy.trim() || undefined,
      });
      if (!result.accepted || !result.batch || !result.qrCodes) {
        push(
          "error",
          "Generation Failed",
          result.reason || "Could not generate codes",
        );
        return;
      }
      setLastResult({ batch: result.batch, qrCodes: result.qrCodes });
      setCopied(false);
      push(
        "success",
        "QR Generation Complete",
        `${result.batch.quantity} codes for ${result.batch.article} / ${result.batch.size} / ${result.batch.color}`,
      );
      resetForm();
      void loadColors();
      void loadHistory();
    } catch {
      push("error", "Generation Failed", "Could not generate codes");
    } finally {
      setGenerating(false);
    }
  };

  const handleReprintBatch = async (batch: QrBatchRow) => {
    try {
      const qrCodes = await api.listQrCodesForBatch(batch.id);
      openPrintWindow(batch, qrCodes);
    } catch {
      push("error", copy.toast.failed, "Could not load codes for this batch");
    }
  };

  // Pre-fills the form from a previous batch — the common case is generating more
  // of something already in production.
  const handleUseAgain = (batch: QrBatchRow) => {
    if (!batch.articleSizeId) return;
    setProductQuery("");
    setArticleSizeId(batch.articleSizeId);
    setColorQuery("");
    setColor(normalizeQrColor(batch.color));
    setQuantity("");
    window.setTimeout(() => quantityRef.current?.focus(), 0);
  };

  const handleCopyIdentities = async () => {
    if (!lastResult) return;
    try {
      await navigator.clipboard.writeText(
        lastResult.qrCodes.map((b) => b.id).join("\n"),
      );
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      push("error", copy.toast.copyFailed, "Could not copy to the clipboard");
    }
  };

  const firstIdentity = lastResult?.qrCodes[0]?.id ?? "";
  const lastIdentity =
    lastResult?.qrCodes[lastResult.qrCodes.length - 1]?.id ?? "";

  const knownProductIds = new Set(
    products.map((p) => p.articleSizeId ?? p.id).filter(Boolean),
  );

  return (
    <div className="page qr-generator-page">
      <div className="page-header">
        <h1>QR Generator</h1>
      </div>

      <form
        className="card qr-generate-card"
        onSubmit={(e) => {
          e.preventDefault();
          void handleGenerate();
        }}
      >
        <div className="card-header">
          <h2 className="card-title">Generate</h2>
          <span className="qr-flow-hint">
            Product → Colour → Quantity → Generate
          </span>
        </div>

        <div className="qr-steps">
          <section className="qr-step">
            <StepHeading
              index={1}
              done={Boolean(selectedProduct)}
              title={copy.columns.product}
            />
            <div className="qr-step-body">
              <div className="city-combobox">
                <span className="city-search-icon" aria-hidden="true">⌕</span>
                <input
                  id="bc-product"
                  type="text"
                  className="form-input"
                  value={
                    selectedProduct
                      ? `${selectedProduct.article} / ${selectedProduct.size}`
                      : productQuery
                  }
                  onChange={(e) => {
                    if (selectedProduct) selectProduct("");
                    setProductQuery(e.target.value);
                    setProductMenuOpen(true);
                    setProductHighlight(0);
                  }}
                  onFocus={(e) => {
                    e.currentTarget.select();
                    setProductMenuOpen(true);
                  }}
                  onBlur={() =>
                    window.setTimeout(() => setProductMenuOpen(false), 120)
                  }
                  onKeyDown={productKeyDown}
                  placeholder="Search or select…"
                  role="combobox"
                  aria-label={copy.columns.product}
                  aria-expanded={productMenuOpen}
                  aria-autocomplete="list"
                  autoComplete="off"
                />
                {selectedProduct && (
                  <button
                    type="button"
                    className="party-combobox-clear"
                    aria-label="Clear product"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      selectProduct("");
                      setProductQuery("");
                    }}
                  >
                    ×
                  </button>
                )}
                {productMenuOpen && (
                  <div className="city-options" role="listbox">
                    {filteredProducts.length === 0 ? (
                      <div className="city-options-empty">
                        No results found
                      </div>
                    ) : (
                      filteredProducts.map((p, idx) => {
                        const id = p.articleSizeId ?? p.id;
                        return (
                          <button
                            key={id}
                            type="button"
                            className={`city-option${idx === productHighlight || id === articleSizeId ? " highlighted" : ""}`}
                            role="option"
                            aria-selected={id === articleSizeId}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => selectProduct(id)}
                          >
                            {p.article} / {p.size}
                          </button>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
              <p className="field-help">
                From Product Master — products cannot be created here.
              </p>
            </div>
          </section>

          <section className="qr-step">
            <StepHeading
              index={2}
              done={Boolean(effectiveColor) && !colorError}
              title="Colour"
            />
            <div className="qr-step-body">
              {!articleSizeId ? (
                <p className="qr-step-waiting">Select a product first.</p>
              ) : (
                <>
                  <div className="input-with-button">
                    <div className="city-combobox" style={{ flex: 1 }}>
                      <span className="city-search-icon" aria-hidden="true">
                        ⌕
                      </span>
                      <input
                        id="bc-color"
                        type="text"
                        className={`form-input${colorError ? " error" : ""}`}
                        value={color ? color : colorQuery}
                        onChange={(e) => {
                          if (color) selectColor("");
                          setColorQuery(e.target.value);
                          setColorMenuOpen(true);
                          setColorHighlight(0);
                        }}
                        onFocus={(e) => {
                          e.currentTarget.select();
                          setColorMenuOpen(true);
                        }}
                        onBlur={() =>
                          window.setTimeout(() => setColorMenuOpen(false), 120)
                        }
                        onKeyDown={colorKeyDown}
                        placeholder="Search or select…"
                        role="combobox"
                        aria-label="Colour"
                        aria-expanded={colorMenuOpen}
                        aria-autocomplete="list"
                        autoComplete="off"
                      />
                      {color && (
                        <button
                          type="button"
                          className="party-combobox-clear"
                          aria-label="Clear colour"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => {
                            selectColor("");
                            setColorQuery("");
                          }}
                        >
                          ×
                        </button>
                      )}
                      {colorMenuOpen && (
                        <div className="city-options" role="listbox">
                          {filteredColorOptions.length === 0 ? (
                            <div className="city-options-empty">
                              No results found
                            </div>
                          ) : (
                            filteredColorOptions.map((c, idx) => (
                              <button
                                key={c}
                                type="button"
                                className={`city-option${idx === colorHighlight || c === color ? " highlighted" : ""}`}
                                role="option"
                                aria-selected={c === color}
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => selectColor(c)}
                              >
                                {c}
                              </button>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      className="btn btn-icon"
                      title="Add new colour"
                      aria-label="Add new colour"
                      onClick={() => setShowAddColorModal(true)}
                    >
                      +
                    </button>
                  </div>

                  {colorError ? (
                    <p className="qr-error">{colorError}</p>
                  ) : (
                    <p className="field-help">
                      Case does not matter — red, Red and RED are one colour.
                    </p>
                  )}
                </>
              )}
            </div>
          </section>

          <section className="qr-step">
            <StepHeading index={3} done={quantityOk} title={copy.columns.quantity} />
            <div className="qr-step-body">
              {!effectiveColor ? (
                <p className="qr-step-waiting">Choose a colour first.</p>
              ) : (
                <>
                  <input
                    id="bc-quantity"
                    ref={quantityRef}
                    type="number"
                    min={1}
                    max={MAX_QUANTITY}
                    step={1}
                    className="form-input qr-quantity"
                    aria-label={copy.columns.quantity}
                    value={quantity}
                    onChange={(e) => setQuantity(e.target.value)}
                    placeholder="e.g. 500"
                  />
                  <div className="qr-chips qr-quick">
                    {QUICK_QUANTITIES.map((n) => (
                      <button
                        key={n}
                        type="button"
                        className={`qr-chip${quantityValue === n ? " is-active" : ""}`}
                        onClick={() => setQuantity(String(n))}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                  {quantityError ? (
                    <p className="qr-error">{quantityError}</p>
                  ) : (
                    <p className="field-help">
                      Up to {MAX_QUANTITY.toLocaleString()} per batch.
                    </p>
                  )}

                  <div className="qr-requested-by">
                    <label htmlFor="bc-requested-by" className="input-label">
                      Requested by <span className="text-muted">(optional)</span>
                    </label>
                    <input
                      id="bc-requested-by"
                      type="text"
                      className="form-input"
                      value={requestedBy}
                      onChange={(e) => setRequestedBy(e.target.value)}
                      placeholder="Who asked for these codes — e.g. Aslam (Production)"
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
                Will register {quantityValue.toLocaleString()}{" "}
                {quantityValue === 1 ? "code" : "codes"}
              </p>
              <div className="qr-range">
                <code className="qr-identity">{pendingRange.first}</code>
                <span className="qr-range-sep">→</span>
                <code className="qr-identity">{pendingRange.last}</code>
              </div>
              <p className="field-help">
                {pendingRange.isFirstEver
                  ? "First batch for this article + colour + size."
                  : `Continues after ${pendingRange.alreadyGenerated.toLocaleString()} already generated.`}
              </p>
            </div>
          ) : (
            <p className="qr-pending-empty" aria-live="polite">
              Choose a product, colour and quantity to see the exact range.
            </p>
          )}

          <button
            type="submit"
            className="btn btn-primary btn-lg qr-generate-btn"
            disabled={!canGenerate}
          >
            {generating
              ? "Generating…"
              : quantityOk
                ? `Generate ${quantityValue.toLocaleString()} codes`
                : "Generate"}
          </button>
        </div>
      </form>

      {lastResult && (
        <div className="qr-input-card qr-result-card">
          <div className="card-header">
            <h2 className="card-title">
              <span className="badge badge-ok">Done</span> QR Generation
              Complete
            </h2>
            <div className="qr-result-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void handleCopyIdentities()}
              >
                {copied ? "Copied" : "Copy list"}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() =>
                  openPrintWindow(lastResult.batch, lastResult.qrCodes)
                }
              >
                🖨 Print / Download
              </button>
            </div>
          </div>

          <div className="qr-result-facts">
            <div>
              <span className="section-label">{copy.columns.product}</span>
              <strong>{lastResult.batch.article}</strong>
            </div>
            <div>
              <span className="section-label">{copy.columns.size}</span>
              <strong>{lastResult.batch.size}</strong>
            </div>
            <div>
              <span className="section-label">Colour</span>
              <strong>{lastResult.batch.color}</strong>
            </div>
            <div>
              <span className="section-label">{copy.columns.quantity}</span>
              <strong>{lastResult.batch.quantity.toLocaleString()}</strong>
            </div>
            <div>
              <span className="section-label">Generated by</span>
              <strong>{lastResult.batch.createdBy ?? "—"}</strong>
            </div>
            {lastResult.batch.requestedBy && (
              <div>
                <span className="section-label">Requested by</span>
                <strong>{lastResult.batch.requestedBy}</strong>
              </div>
            )}
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
            {lastResult.qrCodes.slice(0, PREVIEW_LIMIT).map((b) => (
              <div key={b.id} className="qr-preview-cell">
                <QrPreview value={b.id} />
              </div>
            ))}
          </div>
          {lastResult.qrCodes.length > PREVIEW_LIMIT && (
            <p className="field-help">
              Showing the first {PREVIEW_LIMIT} of{" "}
              {lastResult.qrCodes.length.toLocaleString()}. Use Print /
              Download for the full batch.
            </p>
          )}
        </div>
      )}

      <div className="card">
        <div className="card-header">
          <h2 className="card-title">Recent Generations</h2>
          <div className="qr-history-header-side">
            <span className="qr-history-count">
              {history.length === 0
                ? "No batches yet"
                : `Last ${history.length.toLocaleString()} ${history.length === 1 ? "batch" : "batches"}`}
            </span>
            {onNavigate && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => onNavigate("qr-management")}
              >
                Search all codes →
              </button>
            )}
          </div>
        </div>

        <div className="table-container">
          <table className="data-table qr-history-table">
            <thead>
              <tr>
                <th>{copy.columns.product}</th>
                <th>Colour</th>
                <th>Range</th>
                <th style={{textAlign:"center"}} className="qr-num-col">{copy.columns.qty}</th>
                <th>Generated</th>
                <th aria-label={copy.columns.actions} />
              </tr>
            </thead>
            <tbody>
              {loadingHistory && (
                <tr>
                  <td
                    colSpan={6}
                    className="loading"
                    style={{ textAlign: "center" }}
                  >{copy.common.loading}</td>
                </tr>
              )}

              {!loadingHistory && history.length === 0 && (
                <tr>
                  <td colSpan={6}>
                    <div className="empty-state">
                      <strong style={{ display: "block", marginBottom: 6 }}>
                        No codes generated yet
                      </strong>
                      <span style={{ fontSize: "0.82rem" }}>
                        Pick a product above to register your first batch.
                      </span>
                    </div>
                  </td>
                </tr>
              )}

              {!loadingHistory &&
                history.map((b) => {
                  const generatedAt = new Date(b.createdAt);
                  const canReuse =
                    Boolean(b.articleSizeId) &&
                    knownProductIds.has(b.articleSizeId as string);
                  return (
                    <tr key={b.id}>
                      <td>
                        <strong>{b.article}</strong>{" "}
                        <span className="text-muted">/ {b.size}</span>
                      </td>
                      <td>
                        <span className="qr-color-cell">
                          <span
                            className="qr-color-dot"
                            style={{ backgroundColor: b.color.toLowerCase() }}
                            aria-hidden="true"
                          />
                          {b.color}
                        </span>
                      </td>
                      <td className="qr-range-cell cell-mono">
                        <code>{identityAt(b, b.startSequence)}</code>
                        <span className="qr-range-sep">→</span>
                        <code>{identityAt(b, b.endSequence)}</code>
                      </td>
                      <td className="qr-num-col">
                        <span>
                        {b.quantity.toLocaleString()}</span>
                      </td>
                      <td>
                        <div className="qr-generated-cell">
                          <span className="qr-generated-date">
                            {formatDate(generatedAt)}
                          </span>
                          <span className="qr-generated-time">
                            {formatTime(generatedAt)}
                            {b.createdBy ? ` · ${b.createdBy}` : ""}
                          </span>
                          {b.requestedBy && (
                            <span className="qr-generated-time">for {b.requestedBy}</span>
                          )}
                        </div>
                      </td>
                      <td className="qr-row-actions">
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          disabled={!canReuse}
                          title={
                            canReuse
                              ? "Prefill the form with this combination"
                              : "This product is no longer active"
                          }
                          onClick={() => handleUseAgain(b)}
                        >
                          Use again
                        </button>
                        <button
                        style={{background:"var(--primary-blue)", color:"white"}}
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => void handleReprintBatch(b)}
                        >
                          🖨 Print
                        </button>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Add New Colour modal — same pattern as Product Master's Add New Article/Size ── */}
      {showAddColorModal && (
        <div
          className="member-modal-backdrop"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) {
              setShowAddColorModal(false);
              setNewColorModalValue("");
            }
          }}
        >
          <section
            className="member-modal product-add-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-colour-title"
          >
            <div className="member-modal-header">
              <div className="member-modal-identity">
                <div>
                  <h2 id="add-colour-title">Add New Colour</h2>
                </div>
              </div>
              <button
                type="button"
                className="member-modal-close"
                aria-label={copy.common.close}
                onClick={() => {
                  setShowAddColorModal(false);
                  setNewColorModalValue("");
                }}
              >
                ×
              </button>
            </div>
            <div className="form-group" style={{ margin: "18px 0 6px" }}>
              <label htmlFor="newColorModalValue" className="input-label">
                Colour Name <span className="required-mark">*</span>
              </label>
              <input
                id="newColorModalValue"
                type="text"
                className="form-input"
                style={{ width: "100%", textTransform: "uppercase" }}
                value={newColorModalValue}
                onChange={(e) => setNewColorModalValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleAddColor();
                  }
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    setShowAddColorModal(false);
                    setNewColorModalValue("");
                  }
                }}
                placeholder="e.g. RED"
                autoFocus
              />
              <span className="field-help">
                Case does not matter — red, Red and RED are the same colour.
              </span>
            </div>
            <div className="member-modal-actions">
              <span />
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setShowAddColorModal(false);
                  setNewColorModalValue("");
                }}
              >{copy.common.cancel}</button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleAddColor}
                disabled={!newColorModalValue.trim()}
              >
                Create
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
};
