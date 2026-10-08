import React, { useEffect, useMemo, useRef, useState } from "react";
import { useDesktopApi } from "../hooks/useDesktopApi";
import type { Party, ProductGroup } from "../types/desktopApi";
import { useNotifications } from "../state/NotificationsContext";
import { openPrintDocument } from "../platform/print";
import { formatDate, toIsoDate } from "../utils/dates";
import { escapeHtml } from "../utils/html";
import { copy } from "../config/copy";
import { downloadCsv } from "../utils/exportFile";

type DiscountTab      = "PRODUCT_GROUP" | "ARTICLE_SERIES" | "ARTICLE" | "PRICE_RANGE";
type ReportTypeFilter = "ALL" | "PRODUCT_GROUP" | "ARTICLE_SERIES" | "ARTICLE" | "PRICE_RANGE";

type ProductGroupRule  = { partyId: string; productGroupId: string; discountPerPair: string };
type ArticleSeriesRule = { partyId: string; articleSeriesId: string; discountPerPair: string };
// key is (partyId, size) — one entry per party×size for SEPARATE_SIZES, one per party for ALL_SIZES
type ArticleRule       = { partyId: string; articleName: string; sizeScope: "ALL_SIZES" | "SEPARATE_SIZES"; size: string; discountPerPair: string };
type PriceRangeRule    = { partyId: string; startPrice: string; endPrice: string; discountPerPair: string };

const emptyPriceRangeRule = (): PriceRangeRule => ({ partyId: "", startPrice: "", endPrice: "", discountPerPair: "" });

// ─── Reusable combobox ────────────────────────────────────────────────────────
interface ComboboxOption { value: string; label: string; }

const Combobox: React.FC<{
  id?:       string;
  value:     string;
  options:   ComboboxOption[];
  placeholder: string;
  onChange:  (value: string) => void;
  maxWidth?: number | string;
}> = ({ id, value, options, placeholder, onChange, maxWidth }) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [query,     setQuery]     = useState("");
  const [open,      setOpen]      = useState(false);
  const [highlight, setHighlight] = useState(0);

  const selected = options.find((o) => o.value === value);
  const filtered = options.filter((o) =>
    o.label.toLowerCase().includes(query.trim().toLowerCase()),
  );

  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open]);

  const select = (opt: ComboboxOption) => {
    onChange(opt.value); setQuery(""); setOpen(false); setHighlight(0);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setHighlight((i) => Math.min(i + 1, filtered.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHighlight((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter" && open && filtered.length > 0) { e.preventDefault(); select(filtered[highlight] ?? filtered[0]); }
    else if (e.key === "Escape") { e.stopPropagation(); setOpen(false); }
  };

  return (
    <div ref={wrapRef} className="city-combobox" style={maxWidth ? { maxWidth } : undefined}>
      <span className="city-search-icon" aria-hidden="true">⌕</span>
      <input
        id={id} type="text" className="form-input"
        value={open ? query : (selected?.label ?? "")}
        placeholder={placeholder} autoComplete="off"
        role="combobox" aria-expanded={open} aria-autocomplete="list"
        onChange={(e) => { setQuery(e.target.value); if (value) onChange(""); setOpen(true); setHighlight(0); }}
        onFocus={(e) => { e.currentTarget.select(); setOpen(true); setHighlight(0); }}
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        onKeyDown={handleKeyDown}
      />
      {value && (
        <button type="button" className="party-combobox-clear" aria-label={copy.actions.clear}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => { onChange(""); setQuery(""); }}>×</button>
      )}
      {open && (
        <div className="city-options" role="listbox">
          {filtered.length === 0
            ? <div className="city-options-empty">No options found</div>
            : filtered.map((opt, idx) => (
              <button key={opt.value} type="button"
                className={`city-option${(idx === highlight || opt.value === value) ? " highlighted" : ""}`}
                role="option" aria-selected={opt.value === value}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => select(opt)}
              >{opt.label}</button>
            ))
          }
        </div>
      )}
    </div>
  );
};

// ─── Export helpers ───────────────────────────────────────────────────────────
const TYPE_LABELS: Record<string, string> = {
  PRODUCT_GROUP: "Product Group",
  ARTICLE_SERIES: "Article Series",
  ARTICLE: "Article",
  PRICE_RANGE: "Price Range",
};

const exportToExcel = (
  rows: Array<{ partyName: string; type: string; label: string; discountPerPair: number }>,
  typeFilter: ReportTypeFilter,
) => {
  const title = typeFilter === "ALL" ? "Discount Policy — All Types" : `Discount Policy — ${TYPE_LABELS[typeFilter] ?? typeFilter}`;
  const header = ["Party", "Discount Type", "Item / Range", "Discount / Pair (Rs.)"];
  downloadCsv(`discount-policy-${typeFilter.toLowerCase()}-${toIsoDate()}`, {
    preamble: [title],
    headers: header,
    rows: rows.map((r) => [r.partyName, TYPE_LABELS[r.type] ?? r.type, r.label || "—", r.discountPerPair]),
  });
};

const printPdf = (
  rows: Array<{ partyName: string; type: string; label: string; discountPerPair: number }>,
  typeFilter: ReportTypeFilter,
) => {
  const title = typeFilter === "ALL" ? "Discount Policy — All Types" : `Discount Policy — ${TYPE_LABELS[typeFilter] ?? typeFilter}`;
  const date  = formatDate(new Date());
  const e = escapeHtml;

  const tableRows = rows.map((r) => `
    <tr>
      <td>${e(r.partyName)}</td>
      <td>${e(TYPE_LABELS[r.type] ?? r.type)}</td>
      <td>${e(r.label || "—")}</td>
      <td class="num">Rs. ${e(r.discountPerPair.toLocaleString("en-PK"))}</td>
    </tr>`).join("");

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>${e(title)}</title>
  <style>
    body { font-family: 'Segoe UI', sans-serif; font-size: 12px; color: #111; margin: 32px; }
    h1   { font-size: 16px; font-weight: 800; margin: 0 0 4px; }
    .sub { color: #6b7280; font-size: 11px; margin-bottom: 20px; }
    table { width: 100%; border-collapse: collapse; }
    th { background: #f3f4f6; padding: 8px 10px; text-align: left; font-size: 10px;
         text-transform: uppercase; letter-spacing: .06em; border-bottom: 2px solid #e5e7eb; }
    td { padding: 7px 10px; border-bottom: 1px solid #e5e7eb; }
    tr:last-child td { border-bottom: none; }
    .num { text-align: right; font-variant-numeric: tabular-nums; font-weight: 700; }
    @media print { body { margin: 16px; } }
  </style>
</head>
<body>
  <h1>${e(title)}</h1>
  <div class="sub">Generated ${e(date)} &nbsp;·&nbsp; ${rows.length} rule${rows.length === 1 ? "" : "s"}</div>
  <table>
    <thead>
      <tr>
        <th>Party</th><th>Discount Type</th><th>Item / Range</th><th style="text-align:right">Discount / Pair</th>
      </tr>
    </thead>
    <tbody>${tableRows}</tbody>
  </table>
</body>
</html>`;

  const printed = openPrintDocument(html, { features: "width=900,height=650" });
  if (!printed.opened) return;
  printed.window.focus();
  printed.window.print();
};

// ─── Page ─────────────────────────────────────────────────────────────────────
export const DiscountPolicyPage: React.FC = () => {
  const api      = useDesktopApi();
  const { push } = useNotifications();

  const [tab,           setTab]           = useState<DiscountTab>("PRODUCT_GROUP");
  // TASK 3: only CUSTOMER parties
  const [parties,       setParties]       = useState<Party[]>([]);
  const [productGroups, setProductGroups] = useState<ProductGroup[]>([]);
  const [articleSeries, setArticleSeries] = useState<Array<{ id: string; name: string }>>([]);
  // articles: deduplicated by article name — value IS the article name string, not a variant UUID
  const [articleNames,  setArticleNames]  = useState<string[]>([]);
  // full variant list for size resolution
  const [variants,      setVariants]      = useState<Array<{ id: string; article: string; size: string; color: string }>>([]);
  const [partyReport,   setPartyReport]   = useState<Array<{ partyId: string; partyName: string; type: string; label: string; discountPerPair: number }>>([]);

  const [selectedGroupId,   setSelectedGroupId]   = useState("");
  const [selectedSeriesId,  setSelectedSeriesId]  = useState("");
  // TASK 2: selectedArticle is now the article NAME string, not a variant UUID
  const [selectedArticle,   setSelectedArticle]   = useState("");
  const [selectedPartyId,   setSelectedPartyId]   = useState("");

  const [groupRules,   setGroupRules]   = useState<ProductGroupRule[]>([]);
  const [seriesRules,  setSeriesRules]  = useState<ArticleSeriesRule[]>([]);
  // TASK 2: articleRules keyed by (partyId, size) for SEPARATE_SIZES
  const [articleRules, setArticleRules] = useState<ArticleRule[]>([]);
  const [rangeRules,   setRangeRules]   = useState<PriceRangeRule[]>([]);
  const [articleSizeScope, setArticleSizeScope] = useState<"ALL_SIZES" | "SEPARATE_SIZES">("ALL_SIZES");

  // TASK 4: report filter + export
  const [reportTypeFilter, setReportTypeFilter] = useState<ReportTypeFilter>("ALL");

  useEffect(() => { void loadData(); }, []);

  const loadData = async () => {
    try {
      const [partiesRes, groupsRes, seriesRes, articlesRes] = await Promise.all([
        // TASK 3: filter CUSTOMER only
        api.listParties({ pageSize: 1000, partyType: "CUSTOMER" }),
        api.listProductGroups(),
        api.listArticleSeries(),
        api.listProducts({ pageSize: 1000, status: "ACTIVE" }),
      ]);

      const customerParties = partiesRes.rows;
      setParties(customerParties);
      setProductGroups(groupsRes);
      setArticleSeries(seriesRes.map((s) => ({ id: s.id, name: s.name })));

      const variantRows = articlesRes.rows.map((r) => ({ id: r.id, article: r.article, size: r.size, color: r.color }));
      setVariants(variantRows);
      // Deduplicated article names, sorted
      const names = Array.from(new Set(variantRows.map((v) => v.article))).sort();
      setArticleNames(names);

      // Load report for all customer parties
      const reportRows = await Promise.all(customerParties.map((p) => api.getPartyDiscountReport(p.id)));
      setPartyReport(reportRows.flat());
    } catch {
      push("error", copy.toast.loadFailed, "Could not load discount policy data");
    }
  };

  // ── option arrays ──────────────────────────────────────────────────────────
  const partyOptions:  ComboboxOption[] = parties.map((p) => ({ value: p.id, label: p.partyName }));
  const groupOptions:  ComboboxOption[] = productGroups.map((g) => ({ value: g.id, label: g.groupName }));
  const seriesOptions: ComboboxOption[] = articleSeries.map((s) => ({ value: s.id, label: s.name }));
  // TASK 2: article combobox value = article NAME string
  const articleOptions: ComboboxOption[] = articleNames.map((name) => ({ value: name, label: name }));
  const sizeScopeOptions: ComboboxOption[] = [
    { value: "ALL_SIZES",      label: "All Sizes"      },
    { value: "SEPARATE_SIZES", label: "Separate Sizes" },
  ];
  const reportTypeOptions: ComboboxOption[] = [
    { value: "ALL",            label: "All Types"      },
    { value: "PRODUCT_GROUP",  label: "Product Group"  },
    { value: "ARTICLE_SERIES", label: "Article Series" },
    { value: "ARTICLE",        label: copy.columns.article        },
    { value: "PRICE_RANGE",    label: "Price Range"    },
  ];

  // ── derived: sizes for selected article ───────────────────────────────────
  const articleSizes = useMemo(
    () => Array.from(new Set(variants.filter((v) => v.article === selectedArticle).map((v) => v.size))).sort(),
    [variants, selectedArticle],
  );

  const tabs: Array<{ key: DiscountTab; label: string }> = [
    { key: "PRODUCT_GROUP",  label: "Product Group"  },
    { key: "ARTICLE_SERIES", label: "Article Series" },
    { key: "ARTICLE",        label: copy.columns.article        },
    { key: "PRICE_RANGE",    label: "Price Range"    },
  ];

  // ── seed article rules ────────────────────────────────────────────────────
  const seedArticleRules = (articleName: string, scope: "ALL_SIZES" | "SEPARATE_SIZES", sizes: string[]) => {
    if (scope === "ALL_SIZES") {
      // One entry per party
      setArticleRules(parties.map((p) => ({
        partyId: p.id, articleName, sizeScope: "ALL_SIZES", size: "", discountPerPair: "",
      })));
    } else {
      // One entry per (party × size)
      const rows: ArticleRule[] = [];
      for (const p of parties) {
        for (const size of sizes) {
          rows.push({ partyId: p.id, articleName, sizeScope: "SEPARATE_SIZES", size, discountPerPair: "" });
        }
      }
      setArticleRules(rows);
    }
  };

  // ── save handlers ─────────────────────────────────────────────────────────
  type RuleSave = { partyId: string; save: () => Promise<{ accepted: boolean; reason?: string }> };

  /** Saves one rule per party; every refusal is reported against the party, and the page reloads if any saved. */
  const saveRules = async (label: string, rules: RuleSave[]) => {
    if (rules.length === 0) { push("error", "Nothing to Save", "Enter at least one discount"); return; }
    let saved = 0;
    for (const rule of rules) {
      const result = await rule.save().catch((error: unknown) => ({ accepted: false, reason: error instanceof Error ? error.message : "Could not save" }));
      if (result.accepted) { saved++; continue; }
      const partyName = parties.find((p) => p.id === rule.partyId)?.partyName ?? rule.partyId;
      push("error", copy.toast.saveFailed, `${partyName}: ${result.reason ?? "Could not save"}`);
    }
    if (saved > 0) {
      push("success", copy.toast.saved, `${saved} ${label} discount rule${saved === 1 ? "" : "s"} saved`);
      await loadData();
    }
  };

  const saveProductGroup = () => {
    if (!selectedGroupId) return;
    const rules = groupRules.filter((r) => r.partyId && r.discountPerPair.trim() !== "");
    return saveRules("product group", rules.map((rule) => ({
      partyId: rule.partyId,
      save: () => api.createPartyProductGroupDiscount({ partyId: rule.partyId, productGroupId: selectedGroupId, discountPerPair: Number(rule.discountPerPair) }),
    })));
  };

  const saveArticleSeries = () => {
    if (!selectedSeriesId) return;
    const rules = seriesRules.filter((r) => r.partyId && r.discountPerPair.trim() !== "");
    return saveRules("article series", rules.map((rule) => ({
      partyId: rule.partyId,
      save: () => api.createPartyArticleSeriesDiscount({ partyId: rule.partyId, articleSeriesId: selectedSeriesId, discountPerPair: Number(rule.discountPerPair) }),
    })));
  };

  const saveArticle = () => {
    if (!selectedArticle) return;
    const rules = articleRules.filter((r) => r.partyId && r.discountPerPair.trim() !== "");
    return saveRules("article", rules.map((rule) => ({
      partyId: rule.partyId,
      save: () => api.createPartyArticleDiscount({
        partyId: rule.partyId,
        article: selectedArticle,
        sizeScope: rule.sizeScope,
        size: rule.sizeScope === "SEPARATE_SIZES" ? rule.size : null,
        discountPerPair: Number(rule.discountPerPair),
      }),
    })));
  };

  const savePriceRange = () => {
    const rules = rangeRules.filter((r) => r.partyId && r.startPrice && r.endPrice && r.discountPerPair);
    return saveRules("price range", rules.map((rule) => ({
      partyId: rule.partyId,
      save: () => api.createPartyPriceRangeDiscount({
        partyId: rule.partyId,
        startPrice: Number(rule.startPrice),
        endPrice: Number(rule.endPrice),
        discountPerPair: Number(rule.discountPerPair),
      }),
    })));
  };

  // ── report data ───────────────────────────────────────────────────────────
  const filteredReport = useMemo(() => {
    const rows = partyReport.filter((r) => r.discountPerPair > 0);
    if (reportTypeFilter === "ALL") return rows;
    return rows.filter((r) => r.type === reportTypeFilter);
  }, [partyReport, reportTypeFilter]);

  // ── tab renderers ─────────────────────────────────────────────────────────
  const renderProductGroup = () => (
    <div className="form-card">
      <div className="form-card-title">Product Group Discount Policy</div>
      <div className="form-section">
        <div className="form-group">
          <label>Product Group</label>
          <Combobox id="dp-group" value={selectedGroupId} options={groupOptions}
            placeholder="Select product group…" maxWidth={340}
            onChange={(val) => {
              setSelectedGroupId(val);
              setGroupRules(parties.map((p) => ({ partyId: p.id, productGroupId: val, discountPerPair: "" })));
            }} />
        </div>
      </div>
      {selectedGroupId && (
        <div className="form-section">
          <table className="data-table" style={{ width: "100%" }}>
            <thead><tr><th>{copy.columns.customer}</th><th style={{ width: 180 }}>Discount / Pair (Rs.)</th></tr></thead>
            <tbody>
              {parties.map((party) => {
                const val = groupRules.find((r) => r.partyId === party.id)?.discountPerPair ?? "";
                return (
                  <tr key={party.id}>
                    <td>{party.partyName}</td>
                    <td><input className="form-input" type="number" min="0" step="1" value={val}
                      onChange={(e) => setGroupRules((prev) => prev.map((r) => r.partyId === party.id ? { ...r, discountPerPair: e.target.value } : r))} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="form-actions">
            <button type="button" className="btn btn-primary" onClick={() => void saveProductGroup()}>{copy.common.save}</button>
          </div>
        </div>
      )}
    </div>
  );

  const renderArticleSeries = () => (
    <div className="form-card">
      <div className="form-card-title">Article Series Discount Policy</div>
      <div className="form-section">
        <div className="form-group">
          <label>Article Series</label>
          <Combobox id="dp-series" value={selectedSeriesId} options={seriesOptions}
            placeholder="Select article series…" maxWidth={340}
            onChange={(val) => {
              setSelectedSeriesId(val);
              setSeriesRules(parties.map((p) => ({ partyId: p.id, articleSeriesId: val, discountPerPair: "" })));
            }} />
        </div>
      </div>
      {selectedSeriesId && (
        <div className="form-section">
          <table className="data-table" style={{ width: "100%" }}>
            <thead><tr><th>{copy.columns.customer}</th><th style={{ width: 180 }}>Discount / Pair (Rs.)</th></tr></thead>
            <tbody>
              {parties.map((party) => {
                const val = seriesRules.find((r) => r.partyId === party.id)?.discountPerPair ?? "";
                return (
                  <tr key={party.id}>
                    <td>{party.partyName}</td>
                    <td><input className="form-input" type="number" min="0" step="1" value={val}
                      onChange={(e) => setSeriesRules((prev) => prev.map((r) => r.partyId === party.id ? { ...r, discountPerPair: e.target.value } : r))} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="form-actions">
            <button type="button" className="btn btn-primary" onClick={() => void saveArticleSeries()}>{copy.common.save}</button>
          </div>
        </div>
      )}
    </div>
  );

  const renderArticle = () => (
    <div className="form-card">
      <div className="form-card-title">Article Discount Policy</div>
      <div className="form-section">
        <div className="form-row">
          <div className="form-group">
            <label>{copy.columns.article}</label>
            <Combobox id="dp-article" value={selectedArticle} options={articleOptions}
              placeholder="Select article…" maxWidth={340}
              onChange={(val) => {
                setSelectedArticle(val);
                const sizes = Array.from(new Set(variants.filter((v) => v.article === val).map((v) => v.size))).sort();
                seedArticleRules(val, articleSizeScope, sizes);
              }} />
          </div>
          <div className="form-group">
            <label>Size Scope</label>
            <Combobox id="dp-article-mode" value={articleSizeScope} options={sizeScopeOptions}
              placeholder="Select mode…" maxWidth={200}
              onChange={(val) => {
                const scope = val as "ALL_SIZES" | "SEPARATE_SIZES";
                setArticleSizeScope(scope);
                if (selectedArticle) {
                  const sizes = Array.from(new Set(variants.filter((v) => v.article === selectedArticle).map((v) => v.size))).sort();
                  seedArticleRules(selectedArticle, scope, sizes);
                }
              }} />
          </div>
        </div>

        {selectedArticle && (
          <>
            {articleSizeScope === "ALL_SIZES" ? (
              /* One discount per party, across all sizes */
              <div className="form-section">
                <table className="data-table" style={{ width: "100%" }}>
                  <thead><tr><th>{copy.columns.customer}</th><th style={{ width: 180 }}>Discount / Pair (Rs.)</th></tr></thead>
                  <tbody>
                    {parties.map((party) => {
                      const rule = articleRules.find((r) => r.partyId === party.id && r.sizeScope === "ALL_SIZES");
                      return (
                        <tr key={party.id}>
                          <td>{party.partyName}</td>
                          <td><input className="form-input" type="number" min="0" step="1"
                            value={rule?.discountPerPair ?? ""}
                            onChange={(e) => setArticleRules((prev) => prev.map((r) =>
                              r.partyId === party.id && r.sizeScope === "ALL_SIZES"
                                ? { ...r, discountPerPair: e.target.value } : r))} /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              /* One discount per party per size */
              <div className="form-section">
                <table className="data-table" style={{ width: "100%" }}>
                  <thead>
                    <tr>
                      <th>{copy.columns.customer}</th>
                      {articleSizes.map((size) => <th key={size} style={{ textAlign: "right" }}>Size {size}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {parties.map((party) => (
                      <tr key={party.id}>
                        <td>{party.partyName}</td>
                        {articleSizes.map((size) => {
                          const rule = articleRules.find((r) => r.partyId === party.id && r.size === size && r.sizeScope === "SEPARATE_SIZES");
                          return (
                            <td key={size}>
                              <input className="form-input" type="number" min="0" step="1"
                                style={{ width: 90, textAlign: "right" }}
                                value={rule?.discountPerPair ?? ""}
                                onChange={(e) => setArticleRules((prev) => prev.map((r) =>
                                  r.partyId === party.id && r.size === size && r.sizeScope === "SEPARATE_SIZES"
                                    ? { ...r, discountPerPair: e.target.value } : r))} />
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="form-actions">
              <button type="button" className="btn btn-primary" onClick={() => void saveArticle()}>{copy.common.save}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );

  const renderPriceRange = () => (
    <div className="form-card">
      <div className="form-card-title">Price Range Discount Policy</div>
      <div className="form-section">
        <div className="form-group">
          <label>{copy.columns.customer}</label>
          <Combobox id="dp-price-party" value={selectedPartyId} options={partyOptions}
            placeholder="Select customer…" maxWidth={340}
            onChange={(val) => { setSelectedPartyId(val); setRangeRules([]); }} />
        </div>
      </div>
      {selectedPartyId && (
        <div className="form-section">
          <table className="data-table" style={{ width: "100%" }}>
            <thead><tr><th>From (Rs.)</th><th>To (Rs.)</th><th>Discount / Pair (Rs.)</th><th style={{ width: 40 }} /></tr></thead>
            <tbody>
              {rangeRules.length === 0 && (
                <tr><td colSpan={4} className="empty-state" style={{ padding: "14px 16px" }}>
                  No ranges yet. Click "+ Add Range".
                </td></tr>
              )}
              {rangeRules.map((rule, idx) => (
                <tr key={idx}>
                  <td><input className="form-input" type="number" min="0" step="1" value={rule.startPrice}
                    onChange={(e) => setRangeRules((prev) => { const n = [...prev]; n[idx] = { ...n[idx], startPrice: e.target.value }; return n; })} /></td>
                  <td><input className="form-input" type="number" min="0" step="1" value={rule.endPrice}
                    onChange={(e) => setRangeRules((prev) => { const n = [...prev]; n[idx] = { ...n[idx], endPrice: e.target.value }; return n; })} /></td>
                  <td><input className="form-input" type="number" min="0" step="1" value={rule.discountPerPair}
                    onChange={(e) => setRangeRules((prev) => { const n = [...prev]; n[idx] = { ...n[idx], discountPerPair: e.target.value }; return n; })} /></td>
                  <td><button type="button" className="btn btn-ghost btn-sm"
                    style={{ color: "var(--err)" }}
                    onClick={() => setRangeRules((prev) => prev.filter((_, i) => i !== idx))}>×</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="form-actions">
            <button type="button" className="btn btn-secondary"
              onClick={() => setRangeRules((prev) => [...prev, { ...emptyPriceRangeRule(), partyId: selectedPartyId }])}>
              + Add Range
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void savePriceRange()}>{copy.common.save}</button>
          </div>
        </div>
      )}
    </div>
  );

  // ── main render ───────────────────────────────────────────────────────────
  return (
    <div className="page">
      <div className="page-header">
        <h1>Discount Policy</h1>
      </div>

      {/* Tab bar */}
      <div className="form-card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {tabs.map((item) => (
            <button key={item.key} type="button"
              className={`btn ${tab === item.key ? "btn-primary" : "btn-secondary"}`}
              onClick={() => setTab(item.key)}>
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      {tab === "PRODUCT_GROUP"  && renderProductGroup()}
      {tab === "ARTICLE_SERIES" && renderArticleSeries()}
      {tab === "ARTICLE"        && renderArticle()}
      {tab === "PRICE_RANGE"    && renderPriceRange()}

      {/* ── Discount Report ───────────────────────────────────────── */}
      <div className="form-card" style={{ marginTop: 20 }}>
        {/* Report header: title + filter + export buttons */}
        <div className="dp-report-header">
          <div className="form-card-title" style={{ marginBottom: 0 }}>Discount Report</div>

          <div className="dp-report-controls">
            <Combobox
              id="dp-report-type"
              value={reportTypeFilter}
              options={reportTypeOptions}
              placeholder="All Types"
              maxWidth={200}
              onChange={(val) => setReportTypeFilter((val || "ALL") as ReportTypeFilter)}
            />

            {/* TASK 4: Excel + PDF export */}
            <button
              type="button"
              className="btn btn-excel btn-sm"
              disabled={filteredReport.length === 0}
              onClick={() => exportToExcel(filteredReport, reportTypeFilter)}
              title="Download as Excel / TSV"
            >
              ↓ Excel
            </button>
            <button
              type="button"
              className="btn btn-pdf btn-sm"
              disabled={filteredReport.length === 0}
              onClick={() => printPdf(filteredReport, reportTypeFilter)}
              title="Print / Save as PDF"
            >
              ↓ PDF
            </button>
          </div>
        </div>

        <div className="form-section">
          <table className="data-table" style={{ width: "100%" }}>
            <thead>
              <tr>
                <th>{copy.columns.customer}</th>
                <th>{copy.columns.type}</th>
                <th>Item / Range</th>
                <th style={{ textAlign: "right" }}>Discount / Pair (Rs.)</th>
              </tr>
            </thead>
            <tbody>
              {filteredReport.length === 0 ? (
                <tr>
                  <td colSpan={4} className="empty-state" style={{ padding: "24px 16px" }}>
                    No discount rules found{reportTypeFilter !== "ALL" ? ` for "${TYPE_LABELS[reportTypeFilter]}"` : ""}.
                  </td>
                </tr>
              ) : filteredReport.map((row, idx) => (
                <tr key={`${row.partyId}-${row.type}-${row.label || idx}`}>
                  <td>{row.partyName}</td>
                  <td>
                    <span className="badge badge-muted" style={{ fontSize: "0.68rem" }}>
                      {TYPE_LABELS[row.type] ?? row.type}
                    </span>
                  </td>
                  <td>{row.label || "—"}</td>
                  <td style={{ textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                    {row.discountPerPair.toLocaleString("en-PK")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
