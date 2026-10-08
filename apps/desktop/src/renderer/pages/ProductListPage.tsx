import { BRAND_LOGO_URL } from "../config/branding";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppRoute } from "../app/routes";
import { useDesktopApi } from "../hooks/useDesktopApi";
import type {
  ProductRow,
  ProductGroup,
  MainGroup,
  InventoryRow,
} from "../types/desktopApi";
import { useNotifications } from "../state/NotificationsContext";
import { computeBTypePrice } from "@erp/domain";
import {
  buildRateListHtml,
  buildRateListRows,
  type RateListFormat,
  type RateListHierarchy,
  type RateListType,
} from "../utils/rateList";
import { copy } from "../config/copy";
import { StateView } from "../components/shared/StateView";
import { formatBookDate, toIsoDate } from "../utils/dates";
import { ProductDetailModal } from "../components/products/ProductDetailModal";
import {
  getStockStatus,
  stockStatusBadgeClass,
  stockStatusLabel,
} from "../components/products/stockStatus";

type SellingTypeFilter = "ALL" | "NORMAL" | "B_TYPE";

// Derived, display-only row — NORMAL/B-TYPE are selling types of the same ArticleSize,
// never a separate ArticleSize/productVariant/stock/QR record.
interface SellingTypeRow {
  key: string;
  type: "NORMAL" | "B_TYPE";
  product: ProductRow;
  label: string;
  price: number | null;
}

interface ProductListPageProps {
  onNavigate: (route: AppRoute, productId?: string) => void;
}

type StockFilter = "ALL" | "IN_STOCK" | "LOW_STOCK" | "OUT_OF_STOCK";
const PAGE_SIZE = 20;

export const ProductListPage: React.FC<ProductListPageProps> = ({
  onNavigate,
}) => {
  const api = useDesktopApi();
  const { push } = useNotifications();

  const [products, setProducts] = useState<ProductRow[]>([]);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("ACTIVE");
  const [mainGroupId, setMainGroupId] = useState("");
  const [productGroupId, setProductGroupId] = useState("");
  const [articleSeriesId, setArticleSeriesId] = useState("");
  const [typeFilter, setTypeFilter] = useState<SellingTypeFilter>("ALL");
  type StockFilter = "ALL" | "IN_STOCK" | "LOW_STOCK" | "OUT_OF_STOCK";
  const [stockFilter, setStockFilter] = useState<StockFilter>("ALL");
  const [mainGroups, setMainGroups] = useState<MainGroup[]>([]);
  const [productGroups, setProductGroups] = useState<ProductGroup[]>([]);
  const [articleSeries, setArticleSeries] = useState<
    Array<{ id: string; name: string }>
  >([]);
  const [inventory, setInventory] = useState<InventoryRow[]>([]);
  const [articleImages, setArticleImages] = useState<Record<string, string>>(
    {},
  );
  const [page, setPage] = useState(1);
  const [selectedProduct, setSelectedProduct] = useState<SellingTypeRow | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{
    show: boolean;
    productId: string;
    productName: string;
    action: "disable" | "enable";
  }>({ show: false, productId: "", productName: "", action: "disable" });
  const [rateListOpen, setRateListOpen] = useState(false);
  const [rateListFormat, setRateListFormat] =
    useState<RateListFormat>("PICTURES");
  const [rateListType, setRateListType] = useState<RateListType>("A_TYPE");
  const [rateListGenerating, setRateListGenerating] = useState(false);
  const [rateListHierarchy, setRateListHierarchy] = useState<RateListHierarchy>(
    { articleOrder: [], sizeOrder: [] },
  );
  const [hierarchyEditorOpen, setHierarchyEditorOpen] = useState(false);
  const [hierarchyLoading, setHierarchyLoading] = useState(false);
  const [hierarchySaving, setHierarchySaving] = useState(false);

  // ── filter panel ────────────────────────────────────────────────────
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);

  // combobox: main group
  const [mainGroupQuery, setMainGroupQuery] = useState("");
  const [mainGroupMenuOpen, setMainGroupMenuOpen] = useState(false);
  const [mainGroupHighlight, setMainGroupHighlight] = useState(0);
  const filteredMainGroupOptions = mainGroups.filter((g) =>
    g.groupName.toLowerCase().includes(mainGroupQuery.trim().toLowerCase()),
  );

  // combobox: product group
  const [productGroupQuery, setProductGroupQuery] = useState("");
  const [productGroupMenuOpen, setProductGroupMenuOpen] = useState(false);
  const [productGroupHighlight, setProductGroupHighlight] = useState(0);
  const filteredProductGroupOptions = productGroups.filter((g) =>
    g.groupName.toLowerCase().includes(productGroupQuery.trim().toLowerCase()),
  );

  // combobox: article series
  const [seriesQuery, setSeriesQuery] = useState("");
  const [seriesMenuOpen, setSeriesMenuOpen] = useState(false);
  const [seriesHighlight, setSeriesHighlight] = useState(0);
  const filteredSeriesOptions = articleSeries.filter((s) =>
    s.name.toLowerCase().includes(seriesQuery.trim().toLowerCase()),
  );

  const selectedMainGroupName =
    mainGroups.find((g) => g.id === mainGroupId)?.groupName ?? "";
  const selectedProductGroupName =
    productGroups.find((g) => g.id === productGroupId)?.groupName ?? "";
  const selectedSeriesName =
    articleSeries.find((s) => s.id === articleSeriesId)?.name ?? "";

  // close panel on outside click
  useEffect(() => {
    if (!filterOpen) return;
    const handleOutside = (e: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node))
        setFilterOpen(false);
    };
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [filterOpen]);

  // active filter count
  const activeFilterCount =
    (status !== "ACTIVE" ? 1 : 0) +
    (mainGroupId ? 1 : 0) +
    (productGroupId ? 1 : 0) +
    (articleSeriesId ? 1 : 0) +
    (typeFilter !== "ALL" ? 1 : 0) +
    (stockFilter !== "ALL" ? 1 : 0);

  // generic combobox keydown
  const makeKeyDown =
    <T extends { id: string }>(
      menuOpen: boolean,
      setMenuOpen: (v: boolean) => void,
      highlight: number,
      setHighlight: React.Dispatch<React.SetStateAction<number>>,
      items: T[],
      onSelect: (item: T) => void,
    ) =>
    (e: React.KeyboardEvent<HTMLInputElement>) => {
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

  const mainGroupKeyDown = makeKeyDown(
    mainGroupMenuOpen,
    setMainGroupMenuOpen,
    mainGroupHighlight,
    setMainGroupHighlight,
    filteredMainGroupOptions,
    (g) => {
      setMainGroupId(g.id);
      setMainGroupQuery("");
      setMainGroupMenuOpen(false);
      setMainGroupHighlight(0);
    },
  );
  const productGroupKeyDown = makeKeyDown(
    productGroupMenuOpen,
    setProductGroupMenuOpen,
    productGroupHighlight,
    setProductGroupHighlight,
    filteredProductGroupOptions,
    (g) => {
      setProductGroupId(g.id);
      setProductGroupQuery("");
      setProductGroupMenuOpen(false);
      setProductGroupHighlight(0);
    },
  );
  const seriesKeyDown = makeKeyDown(
    seriesMenuOpen,
    setSeriesMenuOpen,
    seriesHighlight,
    setSeriesHighlight,
    filteredSeriesOptions,
    (s) => {
      setArticleSeriesId(s.id);
      setSeriesQuery("");
      setSeriesMenuOpen(false);
      setSeriesHighlight(0);
    },
  );

  useEffect(() => {
    void loadGroupsAndProducts();
  }, []);
  useEffect(() => {
    void fetchProducts();
  }, [search, status, mainGroupId, productGroupId, articleSeriesId]);
  useEffect(() => {
    if (typeof api.getSettings !== "function") return;
    void api
      .getSettings()
      .then((settings) => {
        try {
          const saved = JSON.parse(
            settings["rate-list.hierarchy"] ?? "{}",
          ) as Partial<RateListHierarchy>;
          setRateListHierarchy({
            articleOrder: Array.isArray(saved.articleOrder)
              ? saved.articleOrder.filter(
                  (value): value is string => typeof value === "string",
                )
              : [],
            sizeOrder: Array.isArray(saved.sizeOrder)
              ? saved.sizeOrder.filter(
                  (value): value is string => typeof value === "string",
                )
              : [],
          });
        } catch {
          // Ignore malformed optional settings and use the natural order.
        }
      })
      .catch(() => undefined);
  }, [api]);

  const loadGroupsAndProducts = async () => {
    try {
      const mainGroupsResult = await api.listMainGroups();
      setMainGroups(mainGroupsResult);
      const productGroupsResult = await api.listProductGroups();
      setProductGroups(productGroupsResult);
      const seriesResult: Array<{ id: string; name: string }> =
        typeof api.listArticleSeries === "function"
          ? await api.listArticleSeries()
          : [];
      setArticleSeries(
        seriesResult.map((s: { id: string; name: string }) => ({
          id: s.id,
          name: s.name,
        })),
      );
    } catch (error) {
      console.error("Failed to load groups:", error);
    }
  };

  const fetchProducts = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const results = await api.listProducts({
        search,
        status: status === "ALL" ? undefined : status,
        page: 1,
        pageSize: 1000,
      });
      let filtered: ProductRow[] = results.rows;
      if (mainGroupId)
        filtered = filtered.filter((p) => p.mainGroupId === mainGroupId);
      if (productGroupId)
        filtered = filtered.filter((p) => p.groupId === productGroupId);
      if (articleSeriesId)
        filtered = filtered.filter(
          (p) => p.articleSeriesId === articleSeriesId,
        );

      const seen = new Map<string, ProductRow>();
      for (const product of filtered) {
        const key = `${product.article}|||${product.size}`;
        if (!seen.has(key)) seen.set(key, product);
      }
      setProducts(Array.from(seen.values()));

      const inventoryRows =
        typeof api.listInventory === "function"
          ? await api.listInventory("")
          : [];
      setInventory(inventoryRows);

      const articles: string[] = [...new Set(filtered.map((p) => p.article))];
      const images: Record<string, string> = {};
      for (const article of articles) {
        const image =
          typeof api.getProductImage === "function"
            ? await api.getProductImage(article)
            : null;
        if (image) images[article] = image;
      }
      setArticleImages(images);
    } catch (error) {
      console.error("Failed to fetch products:", error);
      setLoadError(error instanceof Error ? error.message : copy.states.loadFailedBody);
      push("error", copy.toast.loadFailed, "Could not load products");
    } finally {
      setLoading(false);
    }
  };

  const sellingTypeRows = useMemo<SellingTypeRow[]>(() => {
    const rows: SellingTypeRow[] = [];
    for (const product of products) {
      const label = [product.article, product.size, product.groupName]
        .filter(Boolean)
        .join(" ");
      rows.push({
        key: `${product.id}-NORMAL`,
        type: "NORMAL",
        product,
        label,
        price: product.sellingPrice,
      });
      const bType = computeBTypePrice(product.sellingPrice);
      if (bType.ok)
        rows.push({
          key: `${product.id}-B_TYPE`,
          type: "B_TYPE",
          product,
          label: `${label} - B`,
          price: bType.price,
        });
    }
    return rows;
  }, [products]);

  const inventoryByArticleSize = useMemo(() => {
    const map = new Map<string, InventoryRow[]>();
    for (const row of inventory) {
      const key = `${row.article}|||${row.size}`;
      map.set(key, [...(map.get(key) ?? []), row]);
    }
    return map;
  }, [inventory]);

  const filteredRows = useMemo(() => {
    let rows =
      typeFilter === "ALL"
        ? sellingTypeRows
        : sellingTypeRows.filter((r) => r.type === typeFilter);
    if (stockFilter !== "ALL") {
      rows = rows.filter((r) => {
        const stockRows =
          inventoryByArticleSize.get(
            `${r.product.article}|||${r.product.size}`,
          ) ?? [];
        const stock = stockRows.reduce((sum, s) => sum + s.quantity, 0);
        if (r.product.status !== "ACTIVE")
          return stockFilter === "OUT_OF_STOCK";
        if (stockFilter === "IN_STOCK") return stock >= 10;
        if (stockFilter === "LOW_STOCK") return stock > 0 && stock < 10;
        if (stockFilter === "OUT_OF_STOCK") return stock === 0;
        return true;
      });
    }
    return rows;
  }, [sellingTypeRows, typeFilter, stockFilter, inventoryByArticleSize]);
  const pageRows = filteredRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  const articleDetails = useMemo(() => {
    const details = new Map<
      string,
      { sizes: string[]; colors: string[]; stock: number }
    >();
    for (const product of products) {
      const current = details.get(product.article) ?? {
        sizes: [],
        colors: [],
        stock: 0,
      };
      if (!current.sizes.includes(product.size))
        current.sizes.push(product.size);
      details.set(product.article, current);
    }
    for (const row of inventory) {
      const current = details.get(row.article) ?? {
        sizes: [],
        colors: [],
        stock: 0,
      };
      if (!current.colors.includes(row.color)) current.colors.push(row.color);
      current.stock += row.quantity;
      details.set(row.article, current);
    }
    return details;
  }, [products, inventory]);

  const articleProducts = useMemo(
    () =>
      selectedProduct
        ? products.filter((p) => p.article === selectedProduct.product.article)
        : [],
    [products, selectedProduct],
  );
  const closeProductDetail = useCallback(() => setSelectedProduct(null), []);

  useEffect(() => {
    setPage(1);
  }, [
    search,
    status,
    mainGroupId,
    productGroupId,
    articleSeriesId,
    typeFilter,
    stockFilter,
  ]);

  const handleEdit = (productId: string) =>
    onNavigate("product-form", productId);

  const handleDisableClick = (product: ProductRow) => {
    setConfirmDialog({
      show: true,
      productId: product.id,
      productName: `${product.article} - ${product.size}`,
      action: "disable",
    });
  };

  const handleEnableClick = (product: ProductRow) => {
    setConfirmDialog({
      show: true,
      productId: product.id,
      productName: `${product.article} - ${product.size}`,
      action: "enable",
    });
  };

  const handleConfirmAction = async () => {
    try {
      if (confirmDialog.action === "disable") {
        await api.disableProduct(confirmDialog.productId);
        push("warning", "Product Disabled", confirmDialog.productName);
      } else {
        const result = await api.enableProduct(confirmDialog.productId);
        if (!result.accepted) {
          push("error", copy.toast.failed, result.reason ?? "Could not enable product");
          return;
        }
        push("success", "Product Enabled", confirmDialog.productName);
      }
      setConfirmDialog({
        show: false,
        productId: "",
        productName: "",
        action: "disable",
      });
      await fetchProducts();
    } catch {
      push("error", copy.toast.failed, `Could not ${confirmDialog.action} product`);
    }
  };

  const handleCancelConfirm = () =>
    setConfirmDialog({
      show: false,
      productId: "",
      productName: "",
      action: "disable",
    });

  const readBrandLogo = async (): Promise<string | null> => {
    try {
      const response = await fetch(BRAND_LOGO_URL);
      if (!response.ok) return null;
      const blob = await response.blob();
      return await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () =>
          resolve(typeof reader.result === "string" ? reader.result : null);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      });
    } catch {
      return null;
    }
  };

  const handleGenerateRateList = async () => {
    setRateListGenerating(true);
    try {
      const productsResult = await api.listProducts({
        status: "ACTIVE",
        page: 1,
        pageSize: 10000,
      });
      const activeProducts = productsResult.rows.filter(
        (product) => product.status === "ACTIVE",
      );
      const articles = [
        ...new Set(activeProducts.map((product) => product.article)),
      ];
      const images: Record<string, string> = {};
      await Promise.all(
        articles.map(async (article) => {
          const image = await api.getProductImage(article);
          if (image) images[article] = image;
        }),
      );
      const settings = await api.getSettings();
      let previousRates: Record<string, number | null> = {};
      try {
        const saved = JSON.parse(settings["rate-list.previous-rates"] ?? "{}");
        if (saved && typeof saved === "object")
          previousRates = saved as Record<string, number | null>;
      } catch {
        previousRates = {};
      }
      const rows = buildRateListRows(
        activeProducts,
        rateListType,
        images,
        rateListHierarchy,
        previousRates,
      );
      if (!rows.length) {
        push(
          "warning",
          "No Rates Available",
          "There are no enabled products with a rate to export.",
        );
        return;
      }
      const html = buildRateListHtml({
        format: rateListFormat,
        type: rateListType,
        rows,
        logo: await readBrandLogo(),
        generatedAt: formatBookDate(new Date()),
      });
      const suffix =
        rateListFormat === "PICTURES" ? "rate-list" : "rate-list-difference";
      const saveResult = await api.saveRateList({
        html,
        fileName: `${suffix}-${toIsoDate()}.pdf`,
      });
      if (saveResult.accepted) {
        if (rateListFormat !== "DIFFERENCE") {
          const currentRates = { ...previousRates };
          for (const row of rows)
            currentRates[`A_TYPE:${row.article}:${row.size}`] =
              row.aRate ?? row.newRate;
          await api.saveSettings({
            ...settings,
            "rate-list.previous-rates": JSON.stringify(currentRates),
          });
        }
        push(
          "success",
          "Rate List Generated",
          "The PDF was saved successfully.",
        );
        setRateListOpen(false);
      } else if (!saveResult.canceled) {
        push(
          "error",
          "Rate List Failed",
          saveResult.reason ?? "Could not generate the PDF.",
        );
      }
    } catch (error) {
      push(
        "error",
        "Rate List Failed",
        error instanceof Error ? error.message : "Could not generate the PDF.",
      );
    } finally {
      setRateListGenerating(false);
    }
  };

  const openHierarchyEditor = async () => {
    setHierarchyEditorOpen(true);
    setHierarchyLoading(true);
    try {
      const result = await api.listProducts({
        status: "ACTIVE",
        page: 1,
        pageSize: 10000,
      });
      const activeProducts = result.rows.filter(
        (product) => product.status === "ACTIVE",
      );
      const articles = [
        ...new Set(activeProducts.map((product) => product.article)),
      ];
      const sizes = [...new Set(activeProducts.map((product) => product.size))];
      const appendMissing = (
        saved: string[],
        available: string[],
        compare: (a: string, b: string) => number,
      ) => [
        ...saved.filter((value) => available.includes(value)),
        ...available.filter((value) => !saved.includes(value)).sort(compare),
      ];
      setRateListHierarchy((current) => ({
        articleOrder: appendMissing(current.articleOrder, articles, (a, b) =>
          a.localeCompare(b, undefined, { numeric: true }),
        ),
        sizeOrder: appendMissing(current.sizeOrder, sizes, (a, b) =>
          a.localeCompare(b, undefined, { numeric: true }),
        ),
      }));
    } catch (error) {
      push(
        "error",
        "Hierarchy Failed",
        error instanceof Error
          ? error.message
          : "Could not load active products.",
      );
    } finally {
      setHierarchyLoading(false);
    }
  };

  const saveHierarchy = async () => {
    setHierarchySaving(true);
    try {
      const settings = await api.getSettings();
      await api.saveSettings({
        ...settings,
        "rate-list.hierarchy": JSON.stringify(rateListHierarchy),
      });
      push(
        "success",
        "Hierarchy Saved",
        "New rate lists will use this article and size order.",
      );
      setHierarchyEditorOpen(false);
    } catch (error) {
      push(
        "error",
        "Hierarchy Failed",
        error instanceof Error ? error.message : "Could not save hierarchy.",
      );
    } finally {
      setHierarchySaving(false);
    }
  };

  const moveHierarchyItem = (
    key: keyof RateListHierarchy,
    index: number,
    direction: -1 | 1,
  ) => {
    setRateListHierarchy((current) => {
      const values = [...current[key]];
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= values.length) return current;
      [values[index], values[nextIndex]] = [values[nextIndex], values[index]];
      return { ...current, [key]: values };
    });
  };

  return (
    <div className="page product-list-page">
      <div className="product-catalogue-header">
        <div>
          <h1>Products</h1>
          <p>Browse and manage your product catalogue</p>
        </div>
        <div className="product-header-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setRateListOpen(true)}
          >
            Generate Rate List
          </button>
          <button
            type="button"
            className="btn btn-primary product-add-button"
            onClick={() => onNavigate("product-form")}
          >
            + Add Product
          </button>
        </div>
      </div>

      {/* ── toolbar: search + filter button ─────────────────────────── */}
      <div className="product-catalogue-toolbar">
        <div className="search-wrap product-list-search">
          <svg
            className="search-icon"
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden="true"
          >
            <path
              fillRule="evenodd"
              d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z"
              clipRule="evenodd"
            />
          </svg>
          <input
            type="search"
            aria-label="Search products"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search products, articles, sizes..."
          />
        </div>

        {/* filter button */}
        <div
          className="party-filter-wrap"
          ref={filterRef}
          style={{ position: "relative" }}
        >
          <button
            type="button"
            className={`btn btn-secondary party-filter-btn${activeFilterCount > 0 ? " party-filter-btn--active" : ""}`}
            onClick={() => setFilterOpen((prev) => !prev)}
            aria-expanded={filterOpen}
            aria-haspopup="true"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="13"
              height="13"
              viewBox="0 0 20 20"
              fill="currentColor"
              aria-hidden="true"
            >
              <path
                fillRule="evenodd"
                d="M3 5a1 1 0 011-1h12a1 1 0 010 2H4a1 1 0 01-1-1zm2 4a1 1 0 011-1h8a1 1 0 010 2H6a1 1 0 01-1-1zm2 4a1 1 0 011-1h4a1 1 0 010 2H8a1 1 0 01-1-1z"
                clipRule="evenodd"
              />
            </svg>
            Filters
            {activeFilterCount > 0 && (
              <span className="party-filter-badge">{activeFilterCount}</span>
            )}
          </button>

          {filterOpen && (
            <div
              className="party-filter-panel product-filter-panel"
              role="dialog"
              aria-label={copy.filters.filterOptions}
            >
              {/* Status */}
              <div className="party-filter-panel__field-label">{copy.columns.status}</div>
              <div
                className="party-filter-status-group"
                style={{ marginBottom: 14 }}
              >
                {(["ACTIVE", "ALL", "DISABLED"] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={`party-filter-status-btn${status === s ? " selected" : ""}`}
                    onClick={() => setStatus(s)}
                  >
                    {s === "ALL"
                      ? "All"
                      : s.charAt(0) + s.slice(1).toLowerCase()}
                  </button>
                ))}
              </div>

              {/* Type */}
              <div className="party-filter-panel__field-label">{copy.columns.type}</div>
              <div
                className="party-filter-status-group"
                style={{ marginBottom: 14 }}
              >
                {(["ALL", "NORMAL", "B_TYPE"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    className={`party-filter-status-btn${typeFilter === t ? " selected" : ""}`}
                    onClick={() => setTypeFilter(t)}
                  >
                    {t === "ALL" ? "All" : t === "NORMAL" ? "A-Type" : "B-Type"}
                  </button>
                ))}
              </div>

              {/* Stock */}
              <div className="party-filter-panel__field-label">Stock</div>
              <div
                className="party-filter-status-group"
                style={{ marginBottom: 14, flexWrap: "wrap" }}
              >
                {(
                  [
                    { val: "ALL", label: copy.filters.all },
                    { val: "IN_STOCK", label: "In Stock" },
                    { val: "LOW_STOCK", label: "Low" },
                    { val: "OUT_OF_STOCK", label: "Out" },
                  ] as const
                ).map(({ val, label }) => (
                  <button
                    key={val}
                    type="button"
                    className={`party-filter-status-btn${stockFilter === val ? " selected" : ""}`}
                    onClick={() => setStockFilter(val)}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {/* Main Group combobox */}
              <label className="party-filter-panel__field-label" htmlFor="product-filter-main-group">Main Group</label>
              <div
                className="city-combobox party-filter-combobox"
                style={{ marginBottom: 12 }}
              >
                <span className="city-search-icon" aria-hidden="true">
                  ⌕
                </span>
                <input
                  type="text"
                  id="product-filter-main-group"
                  className="form-input"
                  value={mainGroupId ? selectedMainGroupName : mainGroupQuery}
                  onChange={(e) => {
                    if (mainGroupId) setMainGroupId("");
                    setMainGroupQuery(e.target.value);
                    setMainGroupMenuOpen(true);
                    setMainGroupHighlight(0);
                  }}
                  onFocus={(e) => {
                    e.currentTarget.select();
                    setMainGroupMenuOpen(true);
                  }}
                  onBlur={() =>
                    window.setTimeout(() => setMainGroupMenuOpen(false), 120)
                  }
                  onKeyDown={mainGroupKeyDown}
                  placeholder="All main groups"
                  role="combobox"
                  aria-expanded={mainGroupMenuOpen}
                  aria-autocomplete="list"
                  autoComplete="off"
                />
                {mainGroupId && (
                  <button
                    type="button"
                    className="party-combobox-clear"
                    aria-label="Clear main group"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setMainGroupId("");
                      setMainGroupQuery("");
                    }}
                  >
                    ×
                  </button>
                )}
                {mainGroupMenuOpen && (
                  <div className="city-options" role="listbox">
                    {filteredMainGroupOptions.length === 0 ? (
                      <div className="city-options-empty">{copy.empty.noGroups}</div>
                    ) : (
                      filteredMainGroupOptions.map((g, idx) => (
                        <button
                          key={g.id}
                          type="button"
                          className={`city-option${idx === mainGroupHighlight || g.id === mainGroupId ? " highlighted" : ""}`}
                          role="option"
                          aria-selected={g.id === mainGroupId}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => {
                            setMainGroupId(g.id);
                            setMainGroupQuery("");
                            setMainGroupMenuOpen(false);
                            setMainGroupHighlight(0);
                          }}
                        >
                          {g.groupName}
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>

              {/* Product Group combobox */}
              <label className="party-filter-panel__field-label" htmlFor="product-filter-product-group">
                Product Group
              </label>
              <div
                className="city-combobox party-filter-combobox"
                style={{ marginBottom: 12 }}
              >
                <span className="city-search-icon" aria-hidden="true">
                  ⌕
                </span>
                <input
                  type="text"
                  id="product-filter-product-group"
                  className="form-input"
                  value={
                    productGroupId
                      ? selectedProductGroupName
                      : productGroupQuery
                  }
                  onChange={(e) => {
                    if (productGroupId) setProductGroupId("");
                    setProductGroupQuery(e.target.value);
                    setProductGroupMenuOpen(true);
                    setProductGroupHighlight(0);
                  }}
                  onFocus={(e) => {
                    e.currentTarget.select();
                    setProductGroupMenuOpen(true);
                  }}
                  onBlur={() =>
                    window.setTimeout(() => setProductGroupMenuOpen(false), 120)
                  }
                  onKeyDown={productGroupKeyDown}
                  placeholder="All product groups"
                  role="combobox"
                  aria-expanded={productGroupMenuOpen}
                  aria-autocomplete="list"
                  autoComplete="off"
                />
                {productGroupId && (
                  <button
                    type="button"
                    className="party-combobox-clear"
                    aria-label="Clear product group"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setProductGroupId("");
                      setProductGroupQuery("");
                    }}
                  >
                    ×
                  </button>
                )}
                {productGroupMenuOpen && (
                  <div className="city-options" role="listbox">
                    {filteredProductGroupOptions.length === 0 ? (
                      <div className="city-options-empty">{copy.empty.noGroups}</div>
                    ) : (
                      filteredProductGroupOptions.map((g, idx) => (
                        <button
                          key={g.id}
                          type="button"
                          className={`city-option${idx === productGroupHighlight || g.id === productGroupId ? " highlighted" : ""}`}
                          role="option"
                          aria-selected={g.id === productGroupId}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => {
                            setProductGroupId(g.id);
                            setProductGroupQuery("");
                            setProductGroupMenuOpen(false);
                            setProductGroupHighlight(0);
                          }}
                        >
                          {g.groupName}
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>

              {/* Article Series combobox */}
              <label className="party-filter-panel__field-label" htmlFor="product-filter-series">
                Article Series
              </label>
              <div className="city-combobox party-filter-combobox">
                <span className="city-search-icon" aria-hidden="true">
                  ⌕
                </span>
                <input
                  type="text"
                  id="product-filter-series"
                  className="form-input"
                  value={articleSeriesId ? selectedSeriesName : seriesQuery}
                  onChange={(e) => {
                    if (articleSeriesId) setArticleSeriesId("");
                    setSeriesQuery(e.target.value);
                    setSeriesMenuOpen(true);
                    setSeriesHighlight(0);
                  }}
                  onFocus={(e) => {
                    e.currentTarget.select();
                    setSeriesMenuOpen(true);
                  }}
                  onBlur={() =>
                    window.setTimeout(() => setSeriesMenuOpen(false), 120)
                  }
                  onKeyDown={seriesKeyDown}
                  placeholder="All article series"
                  role="combobox"
                  aria-expanded={seriesMenuOpen}
                  aria-autocomplete="list"
                  autoComplete="off"
                />
                {articleSeriesId && (
                  <button
                    type="button"
                    className="party-combobox-clear"
                    aria-label="Clear article series"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setArticleSeriesId("");
                      setSeriesQuery("");
                    }}
                  >
                    ×
                  </button>
                )}
                {seriesMenuOpen && (
                  <div className="city-options" role="listbox">
                    {filteredSeriesOptions.length === 0 ? (
                      <div className="city-options-empty">No series found</div>
                    ) : (
                      filteredSeriesOptions.map((s, idx) => (
                        <button
                          key={s.id}
                          type="button"
                          className={`city-option${idx === seriesHighlight || s.id === articleSeriesId ? " highlighted" : ""}`}
                          role="option"
                          aria-selected={s.id === articleSeriesId}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => {
                            setArticleSeriesId(s.id);
                            setSeriesQuery("");
                            setSeriesMenuOpen(false);
                            setSeriesHighlight(0);
                          }}
                        >
                          {s.name}
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>

              {/* Clear all */}
              {activeFilterCount > 0 && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  style={{
                    width: "100%",
                    marginTop: 12,
                    fontSize: "0.75rem",
                    color: "var(--chrome-muted)",
                  }}
                  onClick={() => {
                    setStatus("ACTIVE");
                    setMainGroupId("");
                    setMainGroupQuery("");
                    setProductGroupId("");
                    setProductGroupQuery("");
                    setArticleSeriesId("");
                    setSeriesQuery("");
                    setTypeFilter("ALL");
                    setStockFilter("ALL");
                    setFilterOpen(false);
                  }}
                >
                  Clear all filters
                </button>
              )}
            </div>
          )}
        </div>

        <span className="text-muted text-small product-result-count">
          {filteredRows.length} products
        </span>
      </div>

      {/* ── active filter chips ──────────────────────────────────────── */}
      {activeFilterCount > 0 && (
        <div className="party-filter-chips" style={{ marginBottom: 12 }}>
          {status !== "ACTIVE" && (
            <span className="party-chip">
              {status === "ALL" ? "All status" : "Disabled"}
              <button
                type="button"
                className="party-chip__remove"
                onClick={() => setStatus("ACTIVE")}
            aria-label="Remove status filter"
              >
                ×
              </button>
            </span>
          )}
          {typeFilter !== "ALL" && (
            <span className="party-chip">
              {typeFilter === "NORMAL" ? "A-Type" : "B-Type"}
              <button
                type="button"
                className="party-chip__remove"
                onClick={() => setTypeFilter("ALL")}
            aria-label="Remove type filter"
              >
                ×
              </button>
            </span>
          )}
          {mainGroupId && (
            <span className="party-chip">
              Main: {selectedMainGroupName}
              <button
                type="button"
                className="party-chip__remove"
                onClick={() => {
                  setMainGroupId("");
                  setMainGroupQuery("");
                }}
            aria-label="Remove main group filter"
              >
                ×
              </button>
            </span>
          )}
          {productGroupId && (
            <span className="party-chip">
              Group: {selectedProductGroupName}
              <button
                type="button"
                className="party-chip__remove"
                onClick={() => {
                  setProductGroupId("");
                  setProductGroupQuery("");
                }}
            aria-label="Remove product group filter"
              >
                ×
              </button>
            </span>
          )}
          {articleSeriesId && (
            <span className="party-chip">
              Series: {selectedSeriesName}
              <button
                type="button"
                className="party-chip__remove"
                onClick={() => {
                  setArticleSeriesId("");
                  setSeriesQuery("");
                }}
            aria-label="Remove series filter"
              >
                ×
              </button>
            </span>
          )}
          {stockFilter !== "ALL" && (
            <span className="party-chip">
              {stockFilter === "IN_STOCK"
                ? "In Stock"
                : stockFilter === "LOW_STOCK"
                  ? "Low Stock"
                  : "Out of Stock"}
              <button
                type="button"
                className="party-chip__remove"
                onClick={() => setStockFilter("ALL")}
            aria-label="Remove stock filter"
              >
                ×
              </button>
            </span>
          )}
        </div>
      )}

      <div className="table-container">
        <table className="data-table product-management-table">
          <thead>
            <tr>
              <th>{copy.columns.code}</th>
              <th className="product-table-product">{copy.columns.product}</th>
              <th>{copy.columns.article}</th>
              <th>{copy.columns.type}</th>
              <th>Sizes</th>
              <th>Price</th>
              <th>{copy.columns.status}</th>
              <th style={{ width: 155 }}>{copy.columns.actions}</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={8}><StateView kind="loading" compact /></td>
              </tr>
            ) : loadError ? (
              <tr>
                <td colSpan={8}><StateView kind="error" compact message={loadError} onRetry={() => void fetchProducts()} /></td>
              </tr>
            ) : filteredRows.length === 0 ? (
              <tr>
                <td colSpan={8}>
                  {products.length === 0
                    ? <StateView kind="empty" compact title={copy.products.emptyTitle} hint={copy.products.emptyHint} />
                    : <StateView kind="empty" compact title={copy.products.noMatch} hint="Try adjusting your search or filters." />}
                </td>
              </tr>
            ) : (
              pageRows.map((row) => {
                const product = row.product;
                const details = articleDetails.get(product.article) ?? {
                  sizes: [product.size],
                  colors: [],
                  stock: 0,
                };
                const stockRows =
                  inventoryByArticleSize.get(
                    `${product.article}|||${product.size}`,
                  ) ?? [];
                const stock = stockRows.reduce((sum, r) => sum + r.quantity, 0);
                const stockStatus = getStockStatus(stock, product.status);
                const stockBadgeClass = stockStatusBadgeClass[stockStatus];
                const stockLabel = stockStatusLabel(stockStatus);
                return (
                  <tr
                    key={row.key}
                    className="product-management-row"
                    onDoubleClick={() => setSelectedProduct(row)}
                  >
                    <td>
                      <span
                        className="cell-mono"
                        style={{ color: "var(--neutral-600)", fontSize: "0.78rem" }}
                      >
                        {product.productCode ?? "-"}
                      </span>
                    </td>
                    <td className="product-table-product">
                      <div className="product-table-identity">
                        <div className="product-table-image">
                          {articleImages[product.article] ? (
                            <img
                              src={articleImages[product.article]}
                              alt={`${product.article} product`}
                            />
                          ) : (
                            <span>{copy.empty.noImage}</span>
                          )}
                        </div>
                        <div style={{ minWidth: 0 }}>
                          <strong
                            className="cell-primary"
                            style={{
                              display: "block",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                              fontSize: "0.88rem",
                            }}
                          >
                            {row.label}
                          </strong>
                          <small
                            style={{
                              display: "block",
                              marginTop: 2,
                              color: "var(--chrome-muted)",
                              fontSize: "0.74rem",
                            }}
                          >
                            {product.groupName ||
                              product.mainGroupName ||
                              "Unclassified"}
                          </small>
                        </div>
                      </div>
                    </td>

                    <td>
                      <strong className="cell-mono">{product.article}</strong>
                    </td>

                    <td>
                      <span
                        className={`product-type-badge ${row.type === "B_TYPE" ? "b-type" : "normal"}`}
                      >
                        {row.type === "B_TYPE" ? "B" : "A"}
                      </span>
                    </td>
                    <td>
                      <div className="product-size-list">
                        <span>{product.size}</span>
                      </div>
                    </td>
                    <td className="product-price-value">
                      {row.price ? `PKR ${row.price.toFixed(2)}` : "-"}
                    </td>
                    <td>
                      <span className={`badge ${stockBadgeClass}`}>
                        {stockLabel}
                      </span>
                    </td>
                    <td>
                      <div className="party-row-actions">
                        <button
                          type="button"
                          className="btn btn-sm btn-secondary"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleEdit(product.id);
                          }}
                        >{copy.actions.edit}</button>
                        {product.status === "ACTIVE" ? (
                          <button
                            type="button"
                            className="btn btn-sm btn-danger"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDisableClick(product);
                            }}
                          >
                            Disable
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-sm btn-success"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleEnableClick(product);
                            }}
                          >
                            Enable
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {filteredRows.length > 0 && (
        <div className="pagination">
          <button
            type="button"
            className="btn btn-sm"
            disabled={page === 1}
            onClick={() => setPage(1)}
          >
            First
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={page === 1}
            onClick={() => setPage((v) => v - 1)}
          >
            Previous
          </button>
          <span className="page-info">
            Page {page} of {pageCount}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            disabled={page === pageCount}
            onClick={() => setPage((v) => v + 1)}
          >
            Next
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={page === pageCount}
            onClick={() => setPage(pageCount)}
          >
            Last
          </button>
        </div>
      )}

      {selectedProduct && (
        <ProductDetailModal
          product={selectedProduct.product}
          sellingType={selectedProduct.type}
          articleSizes={articleProducts}
          colors={articleDetails.get(selectedProduct.product.article)?.colors ?? []}
          totalStockCartons={articleDetails.get(selectedProduct.product.article)?.stock ?? 0}
          imageUrl={articleImages[selectedProduct.product.article] ?? null}
          stockRowsFor={(article, size) =>
            inventoryByArticleSize.get(`${article}|||${size}`) ?? []
          }
          onClose={closeProductDetail}
          onEdit={(productId) => {
            closeProductDetail();
            handleEdit(productId);
          }}
        />
      )}

      {confirmDialog.show && (
        <div
          className="member-modal-backdrop"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) handleCancelConfirm();
          }}
        >
          <section
            className="member-modal product-add-modal"
            role="dialog"
            aria-modal="true"
          >
            <div className="member-modal-header">
              <div className="member-modal-identity">
                <div>
                  <h2>
                    {confirmDialog.action === "disable"
                      ? "Confirm Disable"
                      : "Confirm Enable"}
                  </h2>
                </div>
              </div>
              <button
                type="button"
                className="member-modal-close"
                aria-label={copy.common.close}
                onClick={handleCancelConfirm}
              >
                ×
              </button>
            </div>
            <p
              style={{
                margin: "16px 0 6px",
                color: "var(--text-2)",
                fontSize: "0.88rem",
              }}
            >
              {confirmDialog.action === "disable" ? (
                <>
                  Are you sure you want to disable{" "}
                  <strong>{confirmDialog.productName}</strong>?
                </>
              ) : (
                <>
                  Are you sure you want to re-enable{" "}
                  <strong>{confirmDialog.productName}</strong>?
                </>
              )}
            </p>
            <p
              style={{
                margin: "0 0 18px",
                color: "var(--text-3)",
                fontSize: "0.78rem",
              }}
            >
              {confirmDialog.action === "disable"
                ? "The product will be hidden from active lists."
                : "The product will become active and visible again."}
            </p>
            <div className="member-modal-actions">
              <span />
              <button
                type="button"
                className="btn btn-secondary"
                onClick={handleCancelConfirm}
              >{copy.common.cancel}</button>
              <button
                type="button"
                className={
                  confirmDialog.action === "disable"
                    ? "btn btn-danger"
                    : "btn btn-success"
                }
                onClick={() => void handleConfirmAction()}
              >
                {confirmDialog.action === "disable" ? "Disable" : "Enable"}
              </button>
            </div>
          </section>
        </div>
      )}

      {rateListOpen && (
        <div
          className="member-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !rateListGenerating)
              setRateListOpen(false);
          }}
        >
          <section
            className="member-modal rate-list-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="rate-list-title"
          >
            <div className="member-modal-header">
              <div>
                <h2 id="rate-list-title">
                  {hierarchyEditorOpen
                    ? "Set Rate List Hierarchy"
                    : "Generate Rate List"}
                </h2>
                <p className="rate-list-modal-subtitle">
                  {hierarchyEditorOpen
                    ? "Move articles and sizes into the order used by every new rate list."
                    : "Create a professional PDF from enabled products."}
                </p>
              </div>
              <button
                type="button"
                className="member-modal-close"
                aria-label={copy.common.close}
                disabled={rateListGenerating || hierarchySaving}
                onClick={() => setRateListOpen(false)}
              >
                ×
              </button>
            </div>
            {hierarchyEditorOpen ? (
              <>
                {hierarchyLoading ? (
                  <p className="rate-list-hierarchy-loading">
                    Loading active articles and sizes...
                  </p>
                ) : (
                  <div className="rate-list-hierarchy-grid">
                    {["articleOrder", "sizeOrder"].map((key) => {
                      const hierarchyKey = key as keyof RateListHierarchy;
                      return (
                        <div className="rate-list-hierarchy-section" key={key}>
                          <div className="rate-list-label">
                            {hierarchyKey === "articleOrder"
                              ? "Article order"
                              : "Size order"}
                          </div>
                          <div className="rate-list-hierarchy-list">
                            {rateListHierarchy[hierarchyKey].map(
                              (value, index) => (
                                <div
                                  className="rate-list-hierarchy-row"
                                  key={value}
                                >
                                  <span>{value}</span>
                                  <span className="rate-list-hierarchy-controls">
                                    <button
                                      type="button"
                                      aria-label={`Move ${value} up`}
                                      disabled={index === 0}
                                      onClick={() =>
                                        moveHierarchyItem(
                                          hierarchyKey,
                                          index,
                                          -1,
                                        )
                                      }
                                    >
                                      ↑
                                    </button>
                                    <button
                                      type="button"
                                      aria-label={`Move ${value} down`}
                                      disabled={
                                        index ===
                                        rateListHierarchy[hierarchyKey].length -
                                          1
                                      }
                                      onClick={() =>
                                        moveHierarchyItem(
                                          hierarchyKey,
                                          index,
                                          1,
                                        )
                                      }
                                    >
                                      ↓
                                    </button>
                                  </span>
                                </div>
                              ),
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                <div className="member-modal-actions rate-list-modal-actions">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={hierarchySaving}
                    onClick={() => setHierarchyEditorOpen(false)}
                  >{copy.common.back}</button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={hierarchyLoading || hierarchySaving}
                    onClick={() => void saveHierarchy()}
                  >
                    {hierarchySaving ? "Saving..." : "Save Hierarchy"}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="rate-list-modal-section">
                  <div className="rate-list-label">Rate List Type</div>
                  <div className="rate-list-type-grid">
                    {(
                      [
                        {
                          value: "PICTURES",
                          label: "Rate List by Pictures",
                          description:
                            "Picture, article, size and current rate",
                        },
                        {
                          value: "DIFFERENCE",
                          label: "Rate List by Difference",
                          description:
                            "Current rate with available previous rate",
                        },
                      ] as const
                    ).map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        className={`rate-list-type-option${rateListFormat === option.value ? " selected" : ""}`}
                        onClick={() => setRateListFormat(option.value)}
                      >
                        <strong>{option.label}</strong>
                        <span>{option.description}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="rate-list-modal-section">
                  <div className="rate-list-label">Include Selling Type</div>
                  <div className="rate-list-scope-grid">
                    {(
                      [
                        { value: "ALL", label: copy.filters.all },
                        { value: "A_TYPE", label: "A-Type" },
                        { value: "B_TYPE", label: "B-Type" },
                      ] as const
                    ).map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        className={`rate-list-scope-option${rateListType === option.value ? " selected" : ""}`}
                        onClick={() => setRateListType(option.value)}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="member-modal-actions rate-list-modal-actions">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={rateListGenerating}
                    onClick={() => void openHierarchyEditor()}
                  >
                    Set Article &amp; Size Hierarchy
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={rateListGenerating}
                    onClick={() => setRateListOpen(false)}
                  >{copy.common.cancel}</button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={rateListGenerating}
                    onClick={() => void handleGenerateRateList()}
                  >
                    {rateListGenerating ? "Generating..." : "Generate PDF"}
                  </button>
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
};
