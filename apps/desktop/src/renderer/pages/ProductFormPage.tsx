import React, { useCallback, useEffect, useRef, useState } from "react";
import type { AppRoute } from "../app/routes";
import { useDesktopApi } from "../hooks/useDesktopApi";
import type { ProductRow, ProductGroup, MainGroup, ProductTypeRow, ProductSubGroupRow } from "../types/desktopApi";
import { useNotifications } from "../state/NotificationsContext";
import { computeBTypePrice, fromPaisa, isValidContractorRatePaisa, toPaisa } from "@erp/domain";
import { copy } from "../config/copy";
import { PackingItemDialog } from "../features/products/PackingItemDialog";
import { PackingRateBreakdown } from "../features/products/PackingRateBreakdown";
import {
  packingItemsError,
  packingItemsToSend,
  packingTotalRupees,
  type PackingRateItem,
} from "../features/products/packingRateItems";

const fileToPngDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const src = String(reader.result ?? "");
      if (!src.startsWith("data:image/")) { reject(new Error("Unsupported image format.")); return; }
      try {
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d");
        if (context) {
          const image = new Image();
          let settled = false;
          const complete = () => {
            if (settled) return;
            settled = true;
            try {
              canvas.width = image.width || 1;
              canvas.height = image.height || 1;
              context.drawImage(image, 0, 0);
              resolve(canvas.toDataURL("image/png"));
            } catch { resolve(src.replace(/^data:image\/[a-zA-Z0-9+.-]+;/, "data:image/png;")); }
          };
          image.onload = complete;
          image.onerror = () => { if (!settled) { settled = true; resolve(canvas.toDataURL("image/png")); } };
          image.src = src;
          setTimeout(complete, 10);
        } else {
          resolve(src.replace(/^data:image\/[a-zA-Z0-9+.-]+;/, "data:image/png;"));
        }
      } catch { resolve(src.replace(/^data:image\/[a-zA-Z0-9+.-]+;/, "data:image/png;")); }
    };
    reader.onerror = () => reject(new Error("Could not read the selected image."));
    reader.readAsDataURL(file);
  });

interface ProductFormData {
  article: string;
  size: string;
  costPrice: string;
  sellingPrice: string;
  bTypePrice: string;
  productCode: string;
  mainGroupId: string;
  productGroupId: string;
  articleSeriesId: string;
  productTypeId: string;
  productSubGroupId: string;
}

/**
 * The product's STANDARD contractor rates, per DOZEN, as typed.
 *
 * Set here the way the sale price is, and used as the DEFAULT when a machine program prices this
 * article (docs/28). The program then owns its own copy, so changing the standard later never
 * rewrites a day already priced.
 *
 * An EMPTY box is "not set", not zero: a product nobody has priced shows as "Not priced" on a
 * program, while a typed 0 means that job is not paid for this article.
 */
type ContractorRateForm = { machine: string; packing: string; printing: string };

const CONTRACTOR_RATE_JOBS: ReadonlyArray<{ key: keyof ContractorRateForm; label: string }> = [
  { key: "machine", label: copy.machineProgram.machineRate },
  { key: "packing", label: copy.machineProgram.packingRate },
  { key: "printing", label: copy.machineProgram.printingRate },
];

/** Paisa as stored → what the box shows. Null stays an empty box. */
const rateBoxValue = (paisa: number | null | undefined): string =>
  paisa == null ? "" : String(fromPaisa(paisa));

/** What the save sends: rupees, or null for a box left empty. */
const rateToSend = (typed: string): number | null => {
  const text = typed.trim();
  if (text === "") return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
};

/** Why the rates cannot be saved, or null. The rule itself is the domain's. */
const contractorRateError = (rates: ContractorRateForm): string | null => {
  for (const { key } of CONTRACTOR_RATE_JOBS) {
    const text = rates[key].trim();
    if (text === "") continue;
    const value = Number(text);
    if (!Number.isFinite(value)) return copy.machineProgram.rateNotANumber;
    if (!isValidContractorRatePaisa(toPaisa(value))) return copy.machineProgram.rateOutOfRange;
  }
  return null;
};

interface ArticleSeries { id: string; name: string; }

interface ProductFormPageProps {
  productId?: string;
  onNavigate: (route: AppRoute) => void;
}

export const ProductFormPage: React.FC<ProductFormPageProps> = ({ productId, onNavigate }) => {
  const api = useDesktopApi();
  const { push } = useNotifications();

  const [formData, setFormData] = useState<ProductFormData>({
    article: "", size: "", costPrice: "", sellingPrice: "", bTypePrice: "", productCode: "",
    mainGroupId: "", productGroupId: "", articleSeriesId: "", productTypeId: "", productSubGroupId: "",
  });
  const [rates, setRates] = useState<ContractorRateForm>({ machine: "", packing: "", printing: "" });
  // The packing rate as named attributes (BOX 50 + TAPE 30 + …). While there are any, the
  // packing box is their sum and cannot be typed into.
  const [packingItems, setPackingItems] = useState<PackingRateItem[]>([]);
  // Closed, or open on one attribute: `index` null adds a new one.
  const [packingDialog, setPackingDialog] = useState<{ index: number | null } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [uniqueArticles, setUniqueArticles] = useState<string[]>([]);
  const [uniqueSizes, setUniqueSizes] = useState<string[]>([]);
  const [mainGroups, setMainGroups] = useState<MainGroup[]>([]);
  const [productGroups, setProductGroups] = useState<ProductGroup[]>([]);
  const [articleSeries, setArticleSeries] = useState<ArticleSeries[]>([]);
  const [productTypes, setProductTypes] = useState<ProductTypeRow[]>([]);
  // Only the sub groups of the chosen product group: a sub group belongs to a group.
  const [productSubGroups, setProductSubGroups] = useState<ProductSubGroupRow[]>([]);
  const [articleImageUrl, setArticleImageUrl] = useState<string | null>(null);

  // combobox: article
  const [articleQuery, setArticleQuery] = useState("");
  const [articleMenuOpen, setArticleMenuOpen] = useState(false);
  const [articleHighlight, setArticleHighlight] = useState(0);

  // combobox: size
  const [sizeQuery, setSizeQuery] = useState("");
  const [sizeMenuOpen, setSizeMenuOpen] = useState(false);
  const [sizeHighlight, setSizeHighlight] = useState(0);
  const [mainGroupMenuOpen, setMainGroupMenuOpen] = useState(false);
  const [mainGroupHighlight, setMainGroupHighlight] = useState(0);

  // combobox: main group query (must be after menu/highlight state)
  const [mainGroupQuery, setMainGroupQuery] = useState("");

  // combobox: product group
  const [productGroupQuery, setProductGroupQuery] = useState("");
  const [productGroupMenuOpen, setProductGroupMenuOpen] = useState(false);
  const [productGroupHighlight, setProductGroupHighlight] = useState(0);

  // combobox: article series
  const [seriesQuery, setSeriesQuery] = useState("");
  const [seriesMenuOpen, setSeriesMenuOpen] = useState(false);
  const [seriesHighlight, setSeriesHighlight] = useState(0);

  // add-new mini modals
  const [showAddMainGroup, setShowAddMainGroup] = useState(false);
  const [showAddProductGroup, setShowAddProductGroup] = useState(false);
  const [showAddArticleSeries, setShowAddArticleSeries] = useState(false);
  const [showAddArticle, setShowAddArticle] = useState(false);
  const [showAddSize, setShowAddSize] = useState(false);
  const [newMainGroupName, setNewMainGroupName] = useState("");
  const [newProductGroupName, setNewProductGroupName] = useState("");
  const [newArticleSeriesName, setNewArticleSeriesName] = useState("");
  const [productTypeQuery, setProductTypeQuery] = useState("");
  const [productTypeMenuOpen, setProductTypeMenuOpen] = useState(false);
  const [productTypeHighlight, setProductTypeHighlight] = useState(0);
  const [productSubGroupQuery, setProductSubGroupQuery] = useState("");
  const [productSubGroupMenuOpen, setProductSubGroupMenuOpen] = useState(false);
  const [productSubGroupHighlight, setProductSubGroupHighlight] = useState(0);
  const [showAddProductType, setShowAddProductType] = useState(false);
  const [showAddProductSubGroup, setShowAddProductSubGroup] = useState(false);
  const [newProductTypeName, setNewProductTypeName] = useState("");
  const [newProductSubGroupName, setNewProductSubGroupName] = useState("");
  // FIX articles: products in this sub group have NO UPPER and are moulded from two soles.
  // A machine program for one then asks for the second sole instead of uppers (migration 067).
  const [newSubGroupHasNoUpper, setNewSubGroupHasNoUpper] = useState(false);
  const [newArticleName, setNewArticleName] = useState("");
  const [newSizeName, setNewSizeName] = useState("");

  // duplicate article+size confirmation (create flow only)
  const [showDuplicateConfirm, setShowDuplicateConfirm] = useState(false);
  const [duplicateMatch, setDuplicateMatch] = useState<ProductRow | null>(null);

  // ESC suppression: mount sentinel when any mini-modal is open
  const anyModalOpen = showAddMainGroup || showAddProductGroup || showAddArticleSeries || showAddProductType || showAddProductSubGroup || showAddArticle || showAddSize || showDuplicateConfirm;
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!anyModalOpen) return;
    const el = document.createElement("div");
    el.setAttribute("data-suppress-esc", "1");
    el.style.display = "none";
    document.body.appendChild(el);
    sentinelRef.current = el;
    return () => { el.remove(); sentinelRef.current = null; };
  }, [anyModalOpen]);

  // derived filtered lists
  const filteredArticles = uniqueArticles.filter((a) =>
    a.toLowerCase().includes(articleQuery.trim().toLowerCase()),
  );
  const filteredSizes = uniqueSizes.filter((s) =>
    s.toLowerCase().includes(sizeQuery.trim().toLowerCase()),
  );
  const filteredMainGroups = mainGroups.filter((g) =>
    g.groupName.toLowerCase().includes(mainGroupQuery.trim().toLowerCase()),
  );
  const filteredProductGroups = productGroups.filter((g) =>
    g.groupName.toLowerCase().includes(productGroupQuery.trim().toLowerCase()),
  );
  const filteredProductTypes = productTypes.filter((t) =>
    t.name.toLowerCase().includes(productTypeQuery.trim().toLowerCase()),
  );
  const filteredProductSubGroups = productSubGroups.filter((g) =>
    g.name.toLowerCase().includes(productSubGroupQuery.trim().toLowerCase()),
  );
  const filteredSeriesList = articleSeries.filter((s) =>
    s.name.toLowerCase().includes(seriesQuery.trim().toLowerCase()),
  );

  const selectedMainGroupName  = mainGroups.find((g) => g.id === formData.mainGroupId)?.groupName ?? "";
  const selectedProductGroupName = productGroups.find((g) => g.id === formData.productGroupId)?.groupName ?? "";
  const selectedSeriesName     = articleSeries.find((s) => s.id === formData.articleSeriesId)?.name ?? "";
  const selectedProductTypeName = productTypes.find((t) => t.id === formData.productTypeId)?.name ?? "";
  const selectedProductSubGroupName = productSubGroups.find((g) => g.id === formData.productSubGroupId)?.name ?? "";

  // data loading
  /**
   * Every dropdown's list, each applied on its own.
   *
   * allSettled, NOT all: these are five independent lists, and one of them failing must not
   * leave the form with no articles to pick either. One notice is raised however many failed,
   * because the operator fixes the connection once, not five times.
   */
  const loadGroupsAndArticles = useCallback(async () => {
    // Wrapped as well as settled: a bridge method that is missing entirely throws at the call
    // site, before allSettled ever sees a promise.
    try {
    const [articles, mGroups, pGroups, series, types] = await Promise.allSettled([
      api.listUniqueArticles(),
      api.listMainGroups(),
      api.listProductGroups(),
      api.listArticleSeries(),
      api.listProductTypes(),
    ]);
    if (articles.status === "fulfilled") setUniqueArticles(articles.value);
    if (mGroups.status === "fulfilled") setMainGroups(mGroups.value);
    if (pGroups.status === "fulfilled") setProductGroups(pGroups.value);
    if (series.status === "fulfilled") setArticleSeries(series.value.map((s) => ({ id: s.id, name: s.name })));
    if (types.status === "fulfilled") setProductTypes(types.value);
    if ([articles, mGroups, pGroups, series, types].some((result) => result.status === "rejected")) {
      push("error", copy.toast.loadFailed, "Could not load product data");
    }
    } catch {
      push("error", copy.toast.loadFailed, "Could not load product data");
    }
  }, [api, push]);

  /**
   * A sub group belongs to a product group, so the list follows the group that is chosen.
   * Clearing or changing the group clears the sub group with it — a sub group of a group the
   * product is no longer in would be a classification nobody chose.
   */
  useEffect(() => {
    let cancelled = false;
    if (!formData.productGroupId) {
      setProductSubGroups([]);
      return;
    }
    void api
      .listProductSubGroups(formData.productGroupId)
      .then((rows) => {
        if (!cancelled) setProductSubGroups(rows);
      })
      .catch(() => {
        if (!cancelled) setProductSubGroups([]);
      });
    return () => {
      cancelled = true;
    };
  }, [api, formData.productGroupId]);

  const loadArticleImage = useCallback(async (article: string) => {
    const name = article.trim();
    if (!name) { setArticleImageUrl(null); return; }
    try { setArticleImageUrl((await api.getProductImage(name)) ?? null); }
    catch { setArticleImageUrl(null); }
  }, [api]);

  useEffect(() => {
    void loadGroupsAndArticles();
    if (productId) {
      void loadProduct();
    } else {
      // auto-generate product code for new products
      void api.getNextProductCode().then((code) => {
        setFormData((prev) => ({ ...prev, productCode: code }));
      });
    }
  }, [productId]);
  useEffect(() => {
    if (!formData.article.trim()) { setArticleImageUrl(null); return; }
    void loadArticleImage(formData.article);
  }, [formData.article, loadArticleImage]);

  const loadProduct = async () => {
    if (!productId) return;
    try {
      setLoading(true);
      const product: ProductRow | null = await api.getProduct(productId);
      if (product) {
        setFormData({
          article: product.article, size: product.size,
          costPrice: product.costPrice?.toString() ?? "",
          sellingPrice: product.sellingPrice?.toString() ?? "",
          bTypePrice: (() => {
            const b = computeBTypePrice(product.sellingPrice ?? null);
            return b.ok ? String(b.price) : "";
          })(),
          productCode: product.productCode ?? "",
          mainGroupId: product.mainGroupId ?? "",
          productGroupId: product.groupId ?? "",
          articleSeriesId: product.articleSeriesId ?? "",
          productTypeId: product.productTypeId ?? "",
          productSubGroupId: product.productSubGroupId ?? "",
        });
        setRates({
          machine: rateBoxValue(product.machineRatePaisa),
          packing: rateBoxValue(product.packingRatePaisa),
          printing: rateBoxValue(product.printingRatePaisa),
        });
        setPackingItems(product.packingRateItems ?? []);
        const sizes = await api.listUniqueSizesByArticle(product.article);
        setUniqueSizes(sizes);
      } else {
        push("error", copy.toast.notFound, "Product not found");
      }
    } catch { push("error", copy.toast.loadFailed, "Could not load product details"); }
    finally { setLoading(false); }
  };

  // article / size — dropdown-select only. Typing in the field only searches
  // the existing list; the value is set by picking an item from the dropdown
  // (or via the "+" add-new popup), never by the raw typed text.
  const selectArticle = async (value: string) => {
    setFormData((prev) => ({ ...prev, article: value, size: "" }));
    setArticleQuery("");
    setArticleMenuOpen(false);
    setArticleHighlight(0);
    if (errors.article) setErrors((prev) => { const e = { ...prev }; delete e.article; return e; });
    if (value) {
      try {
        const [sizes, image] = await Promise.all([api.listUniqueSizesByArticle(value), api.getProductImage(value)]);
        setUniqueSizes(sizes); setArticleImageUrl(image || null);
      } catch { setUniqueSizes([]); setArticleImageUrl(null); }
    } else {
      setUniqueSizes([]); setArticleImageUrl(null);
    }
  };

  const selectSize = (value: string) => {
    setFormData((prev) => ({ ...prev, size: value }));
    setSizeQuery("");
    setSizeMenuOpen(false);
    setSizeHighlight(0);
    if (errors.size) setErrors((prev) => { const e = { ...prev }; delete e.size; return e; });
  };

  const handleInputChange = (field: keyof ProductFormData, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    if (errors[field]) setErrors((prev) => { const e = { ...prev }; delete e[field]; return e; });
  };

  /**
   * Every change to the packing attributes goes through here, so the packing box always shows
   * their sum. Removing the last one leaves the packing rate NOT SET, not 0.
   */
  const updatePackingItems = (next: PackingRateItem[]) => {
    setPackingItems(next);
    setRates((previous) => ({ ...previous, packing: next.length > 0 ? String(packingTotalRupees(next)) : "" }));
    if (errors.rates) setErrors((prev) => { const e = { ...prev }; delete e.rates; return e; });
  };

  const savePackingItem = (item: PackingRateItem) => {
    const index = packingDialog?.index ?? null;
    updatePackingItems(index === null ? [...packingItems, item] : packingItems.map((existing, i) => (i === index ? item : existing)));
    setPackingDialog(null);
  };

  // generic combobox keyboard factory
  const makeKeyDown = <T extends { id: string }>(
    menuOpen: boolean,
    setMenuOpen: (v: boolean) => void,
    highlight: number,
    setHighlight: React.Dispatch<React.SetStateAction<number>>,
    items: T[],
    onSelect: (item: T) => void,
  ) => (e: React.KeyboardEvent<HTMLInputElement>) => {
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
      // stop the global keyboard handler from navigating to dashboard
      e.stopPropagation();
      setMenuOpen(false);
    }
  };

  const articleKeyDown    = makeKeyDown(articleMenuOpen,      setArticleMenuOpen,      articleHighlight,      setArticleHighlight,      filteredArticles.map((a) => ({ id: a })), (item) => { void selectArticle(item.id); });
  const sizeKeyDown        = makeKeyDown(sizeMenuOpen,        setSizeMenuOpen,        sizeHighlight,        setSizeHighlight,        filteredSizes.map((s) => ({ id: s })),   (item) => { selectSize(item.id); });
  const mainGroupKeyDown   = makeKeyDown(mainGroupMenuOpen,   setMainGroupMenuOpen,   mainGroupHighlight,   setMainGroupHighlight,   filteredMainGroups,   (g) => { handleInputChange("mainGroupId", g.id); setMainGroupQuery(""); setMainGroupMenuOpen(false); setMainGroupHighlight(0); });
  const productGroupKeyDown = makeKeyDown(productGroupMenuOpen, setProductGroupMenuOpen, productGroupHighlight, setProductGroupHighlight, filteredProductGroups, (g) => { handleInputChange("productGroupId", g.id); setProductGroupQuery(""); setProductGroupMenuOpen(false); setProductGroupHighlight(0); });
  const seriesKeyDown      = makeKeyDown(seriesMenuOpen,      setSeriesMenuOpen,      seriesHighlight,      setSeriesHighlight,      filteredSeriesList,   (s) => { handleInputChange("articleSeriesId", s.id); setSeriesQuery(""); setSeriesMenuOpen(false); setSeriesHighlight(0); });
  const productTypeKeyDown = makeKeyDown(productTypeMenuOpen, setProductTypeMenuOpen, productTypeHighlight, setProductTypeHighlight, filteredProductTypes, (t) => { handleInputChange("productTypeId", t.id); setProductTypeQuery(""); setProductTypeMenuOpen(false); setProductTypeHighlight(0); });
  const productSubGroupKeyDown = makeKeyDown(productSubGroupMenuOpen, setProductSubGroupMenuOpen, productSubGroupHighlight, setProductSubGroupHighlight, filteredProductSubGroups, (g) => { handleInputChange("productSubGroupId", g.id); setProductSubGroupQuery(""); setProductSubGroupMenuOpen(false); setProductSubGroupHighlight(0); });

  // image upload
  const handleImageUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const articleName = formData.article.trim();
    if (!articleName) {
      push("error", "Article required", "Enter a product/article name before uploading an image");
      event.target.value = "";
      return;
    }
    try {
      const pngDataUrl = await fileToPngDataUrl(file);
      const result = await api.saveProductImage(articleName, pngDataUrl);
      if (!result.accepted) { push("error", "Image not saved", result.reason || "Could not save product image"); return; }
      setArticleImageUrl(pngDataUrl);
      push("success", "Image saved", `${articleName} image updated`);
    } catch { push("error", "Image failed", "Could not save product image"); }
    finally { event.target.value = ""; }
  };

  // add-new handlers
  const handleAddMainGroup = async () => {
    if (!newMainGroupName.trim()) return;
    try {
      const result = await api.createMainGroup({ groupName: newMainGroupName.trim().toUpperCase() });
      if (result.accepted) {
        await loadGroupsAndArticles();
        handleInputChange("mainGroupId", result.groupId || "");
        setShowAddMainGroup(false); setNewMainGroupName("");
      } else { push("error", copy.toast.failed, result.reason || "Failed to create group"); }
    } catch { push("error", copy.toast.failed, "Error creating group"); }
  };

  const handleAddProductGroup = async () => {
    if (!newProductGroupName.trim()) return;
    try {
      const result = await api.createProductGroup({ groupName: newProductGroupName.trim().toUpperCase() });
      if (result.accepted) {
        await loadGroupsAndArticles();
        handleInputChange("productGroupId", result.groupId || "");
        setShowAddProductGroup(false); setNewProductGroupName("");
      } else { push("error", copy.toast.failed, result.reason || "Failed to create group"); }
    } catch { push("error", copy.toast.failed, "Error creating group"); }
  };

  const handleAddArticleSeries = async () => {
    if (!newArticleSeriesName.trim()) return;
    try {
      const result = await api.createArticleSeries({ name: newArticleSeriesName.trim().toUpperCase() });
      if (result.accepted) {
        await loadGroupsAndArticles();
        handleInputChange("articleSeriesId", result.id || "");
        setShowAddArticleSeries(false); setNewArticleSeriesName("");
      } else { push("error", copy.toast.failed, result.reason || "Failed to create article series"); }
    } catch { push("error", copy.toast.failed, "Error creating article series"); }
  };

  const handleAddProductType = async () => {
    if (!newProductTypeName.trim()) return;
    try {
      const result = await api.createProductType({ name: newProductTypeName.trim().toUpperCase() });
      if (result.accepted) {
        await loadGroupsAndArticles();
        handleInputChange("productTypeId", result.id || "");
        setShowAddProductType(false); setNewProductTypeName("");
      } else { push("error", copy.toast.failed, result.reason || "Failed to create product type"); }
    } catch { push("error", copy.toast.failed, "Error creating product type"); }
  };

  /** A sub group needs the group it goes under, so this is only reachable with one chosen. */
  const handleAddProductSubGroup = async () => {
    if (!newProductSubGroupName.trim() || !formData.productGroupId) return;
    try {
      const result = await api.createProductSubGroup({
        productGroupId: formData.productGroupId,
        name: newProductSubGroupName.trim().toUpperCase(),
        hasNoUpper: newSubGroupHasNoUpper,
      });
      if (result.accepted) {
        setProductSubGroups(await api.listProductSubGroups(formData.productGroupId));
        handleInputChange("productSubGroupId", result.id || "");
        setShowAddProductSubGroup(false); setNewProductSubGroupName(""); setNewSubGroupHasNoUpper(false);
      } else { push("error", copy.toast.failed, result.reason || "Failed to create product sub group"); }
    } catch { push("error", copy.toast.failed, "Error creating product sub group"); }
  };

  const handleAddArticle = () => {
    const value = newArticleName.trim().toUpperCase();
    if (!value) return;
    setUniqueArticles((prev) => (prev.includes(value) ? prev : [...prev, value].sort()));
    void selectArticle(value);
    setShowAddArticle(false);
    setNewArticleName("");
  };

  const handleAddSize = () => {
    const value = newSizeName.trim().toUpperCase();
    if (!value) return;
    setUniqueSizes((prev) => (prev.includes(value) ? prev : [...prev, value].sort()));
    selectSize(value);
    setShowAddSize(false);
    setNewSizeName("");
  };

  // form submit
  const validateForm = (): boolean => {
    const newErrors: Record<string, string> = {};
    if (!formData.article.trim()) newErrors.article = "Product name/article is required";
    if (!formData.size.trim()) newErrors.size = "Size is required";
    const rateError = contractorRateError(rates) ?? packingItemsError(packingItems);
    if (rateError) newErrors.rates = rateError;
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const saveProduct = async () => {
    try {
      setLoading(true);
      const payload = {
        article: formData.article.trim().toUpperCase(),
        size: formData.size.trim().toUpperCase(),
        costPrice: formData.costPrice ? Number(formData.costPrice) : undefined,
        sellingPrice: formData.sellingPrice ? Number(formData.sellingPrice) : undefined,
        machineRate: rateToSend(rates.machine),
        packingRate: rateToSend(rates.packing),
        printingRate: rateToSend(rates.printing),
        // Always sent, so removing the last attribute clears the saved breakdown too. The main
        // process works the packing rate out from these again; it never trusts the sum above.
        packingRateItems: packingItemsToSend(packingItems),
        mainGroupId: formData.mainGroupId || undefined,
        productGroupId: formData.productGroupId || undefined,
        articleSeriesId: formData.articleSeriesId || undefined,
        productTypeId: formData.productTypeId || undefined,
        productSubGroupId: formData.productSubGroupId || undefined,
        // No productCode: the field above is a read-only preview, and the code is allocated
        // when the product is written. Sending the preview back is what let two forms opened
        // together save the same code.
        color: "",
        description: undefined,
        status: "ACTIVE",
      };
      if (productId) {
        await api.updateProduct(productId, payload);
        push("success", "Product Updated", formData.article);
      } else {
        await api.createProduct(payload);
        push("success", "Product Created", formData.article);
      }
      onNavigate("product-list");
      // The main process says WHY it refused — a duplicate, a missing group, a locked product.
      // Swallowing that left the operator with "Error processing product" and nothing to act on.
    } catch (error) { push("error", copy.toast.failed, error instanceof Error ? error.message : "Error processing product"); }
    finally { setLoading(false); }
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!validateForm()) return;

    // Only relevant when creating a brand-new product: warn before silently
    // overwriting an existing article+size instead of creating a duplicate.
    if (!productId) {
      try {
        const existing = await api.listProducts({ search: formData.article.trim(), status: "ALL", pageSize: 200 });
        const match = existing.rows.find(
          (row) =>
            row.article.trim().toUpperCase() === formData.article.trim().toUpperCase() &&
            row.size.trim() === formData.size.trim(),
        );
        if (match) {
          setDuplicateMatch(match);
          setShowDuplicateConfirm(true);
          return;
        }
      } catch { /* if the check itself fails, fall through and let save proceed as before */ }
    }

    await saveProduct();
  };

  // helper to render a city-style combobox for the classification section
  const renderCombobox = (opts: {
    id: string;
    label: string;
    selectedId: string;
    selectedName: string;
    query: string;
    onQueryChange: (v: string) => void;
    menuOpen: boolean;
    setMenuOpen: (v: boolean) => void;
    highlight: number;
    items: Array<{ id: string; name?: string; groupName?: string }>;
    onSelect: (item: { id: string }) => void;
    onClear: () => void;
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
    onAdd: () => void;
    addLabel: string;
    /** Shut until something it depends on is chosen (a sub group needs its group). */
    disabled?: boolean;
    /** What to say in the box while it is shut, so the reason is on screen, not guessed. */
    disabledHint?: string;
  }) => {
    const displayItems = opts.items.map((i) => ({ id: i.id, label: i.name ?? i.groupName ?? "" }));
    return (
      <div className="form-group">
        <label htmlFor={opts.id}>{opts.label}</label>
        <div className="input-with-button">
          <div className="city-combobox" style={{ flex: 1 }}>
            <span className="city-search-icon" aria-hidden="true">⌕</span>
            <input
              id={opts.id}
              type="text"
              className="form-input input-upper"
              value={opts.selectedId ? opts.selectedName : opts.query}
              onChange={(e) => {
                if (opts.selectedId) opts.onClear();
                opts.onQueryChange(e.target.value.toUpperCase());
                opts.setMenuOpen(true);
              }}
              onFocus={(e) => { if (opts.disabled) return; e.currentTarget.select(); opts.setMenuOpen(true); }}
              onBlur={() => window.setTimeout(() => opts.setMenuOpen(false), 120)}
              onKeyDown={opts.onKeyDown}
              placeholder={opts.disabled ? (opts.disabledHint ?? "Not available yet") : "Search or select…"}
              disabled={opts.disabled}
              role="combobox"
              aria-expanded={opts.menuOpen}
              aria-autocomplete="list"
              autoComplete="off"
            />
            {opts.selectedId && (
              <button
                type="button"
                className="party-combobox-clear"
                aria-label={`Clear ${opts.label}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={opts.onClear}
              >
                ×
              </button>
            )}
            {opts.menuOpen && !opts.disabled && (
              <div className="city-options" role="listbox">
                {displayItems.length === 0
                  ? <div className="city-options-empty">No results found</div>
                  : displayItems.map((item, idx) => (
                    <button
                      key={item.id}
                      type="button"
                      className={`city-option${(idx === opts.highlight || item.id === opts.selectedId) ? " highlighted" : ""}`}
                      role="option"
                      aria-selected={item.id === opts.selectedId}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => opts.onSelect(item)}
                    >
                      {item.label}
                    </button>
                  ))
                }
              </div>
            )}
          </div>
          <button
            type="button"
            className="btn btn-icon"
            title={opts.addLabel}
            aria-label={opts.addLabel}
            onClick={opts.onAdd}
            disabled={opts.disabled}
          >
            +
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="page product-form-page">
      <div className="party-form-heading">
        <h1>{productId ? "Edit Product" : "Create New Product"}</h1>
        <button type="button" className="product-back-link" onClick={() => onNavigate("product-list")}>
          <span aria-hidden="true">←</span> Back to List
        </button>
      </div>

      <form onSubmit={(e) => void handleSubmit(e)} className="product-form product-form-layout">

        {/* ── column 1: main + pricing stacked ───────────────────────────── */}
        <div className="product-form-main">

          <section className="party-form-card form-section">
            <h2>Product Information</h2>

            {/* Product Code — read-only, auto-generated */}
            <div className="form-group party-code-field">
              <label htmlFor="productCode">Product Code</label>
              <input
                id="productCode"
                type="text"
                className="form-input"
                value={formData.productCode || "Generating..."}
                readOnly
                aria-readonly="true"
              />
              <span className="field-help">Automatically generated unique identifier</span>
            </div>

            <div className="form-row">

              {/* ── Article combobox (dropdown-select only) ── */}
              <div className="form-group">
                <label htmlFor="article">Product Name / Article <span className="required-mark">*</span></label>
                <div className="input-with-button">
                <div className="city-combobox" style={{ flex: 1 }}>
                  <span className="city-search-icon" aria-hidden="true">⌕</span>
                  <input
                    id="article"
                    type="text"
                    className={`form-input input-upper${errors.article ? " error" : ""}`}
                    value={formData.article ? formData.article : articleQuery}
                    onChange={(e) => {
                      if (formData.article) void selectArticle("");
                      setArticleQuery(e.target.value.toUpperCase());
                      setArticleMenuOpen(true);
                      setArticleHighlight(0);
                    }}
                    onFocus={(e) => { e.currentTarget.select(); setArticleMenuOpen(true); }}
                    onBlur={() => window.setTimeout(() => setArticleMenuOpen(false), 120)}
                    onKeyDown={articleKeyDown}
                    placeholder="Search or select…"
                    role="combobox"
                    aria-expanded={articleMenuOpen}
                    aria-autocomplete="list"
                    autoComplete="off"
                    required
                  />
                  {formData.article && (
                    <button
                      type="button"
                      className="party-combobox-clear"
                      aria-label="Clear article"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => { void selectArticle(""); setArticleQuery(""); }}
                    >×</button>
                  )}
                  {articleMenuOpen && (
                    <div className="city-options" role="listbox">
                      {filteredArticles.length === 0
                        ? <div className="city-options-empty">No results found</div>
                        : filteredArticles.map((a, idx) => (
                          <button
                            key={a}
                            type="button"
                            className={`city-option${(idx === articleHighlight || a === formData.article) ? " highlighted" : ""}`}
                            role="option"
                            aria-selected={a === formData.article}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => void selectArticle(a)}
                          >{a}</button>
                        ))
                      }
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  className="btn btn-icon"
                  title="Add new article"
                  onClick={() => setShowAddArticle(true)}
                >
                  +
                </button>
                </div>
                {errors.article && <span className="error-message">{errors.article}</span>}
              </div>

              {/* ── Size combobox (dropdown-select only) ── */}
              <div className="form-group">
                <label htmlFor="size">{copy.columns.size}<span className="required-mark">*</span></label>
                <div className="input-with-button">
                <div className={`city-combobox${!formData.article ? " city-combobox--disabled" : ""}`} style={{ flex: 1 }}>
                  <span className="city-search-icon" aria-hidden="true">⌕</span>
                  <input
                    id="size"
                    type="text"
                    className={`form-input input-upper${errors.size ? " error" : ""}`}
                    value={formData.size ? formData.size : sizeQuery}
                    onChange={(e) => {
                      if (formData.size) selectSize("");
                      setSizeQuery(e.target.value.toUpperCase());
                      setSizeMenuOpen(true);
                      setSizeHighlight(0);
                    }}
                    onFocus={(e) => { if (formData.article) { e.currentTarget.select(); setSizeMenuOpen(true); } }}
                    onBlur={() => window.setTimeout(() => setSizeMenuOpen(false), 120)}
                    onKeyDown={sizeKeyDown}
                    placeholder={formData.article ? "Search or select…" : "Select article first"}
                    disabled={!formData.article}
                    role="combobox"
                    aria-expanded={sizeMenuOpen}
                    aria-autocomplete="list"
                    autoComplete="off"
                    required
                  />
                  {formData.size && (
                    <button
                      type="button"
                      className="party-combobox-clear"
                      aria-label="Clear size"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => { selectSize(""); setSizeQuery(""); }}
                    >×</button>
                  )}
                  {sizeMenuOpen && formData.article && (
                    <div className="city-options" role="listbox">
                      {filteredSizes.length === 0
                        ? <div className="city-options-empty">No results found</div>
                        : filteredSizes.map((s, idx) => (
                          <button
                            key={s}
                            type="button"
                            className={`city-option${(idx === sizeHighlight || s === formData.size) ? " highlighted" : ""}`}
                            role="option"
                            aria-selected={s === formData.size}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => selectSize(s)}
                          >{s}</button>
                        ))
                      }
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  className="btn btn-icon"
                  title="Add new size"
                  disabled={!formData.article}
                  onClick={() => setShowAddSize(true)}
                >
                  +
                </button>
                </div>
                {errors.size && <span className="error-message">{errors.size}</span>}
              </div>

            </div>
          </section>

          <section className="party-form-card form-section">
            <h2>Pricing</h2>
            <div className="pricing-fields">
              <div className="form-group">
                <label htmlFor="sellingPrice">Sale Price (A-Type)</label>
                <input
                  id="sellingPrice"
                  type="text"
                  inputMode="decimal"
                  className="form-input"
                  value={formData.sellingPrice}
                  onChange={(e) => {
                    const raw = e.target.value;
                    if (raw !== "" && !/^\d*\.?\d*$/.test(raw)) return;
                    const numeric = raw === "" ? null : Number(raw);
                    const newCost =
                      numeric !== null && !Number.isNaN(numeric) && numeric >= 50
                        ? String(numeric - 50)
                        : "";
                    const bResult = computeBTypePrice(numeric);
                    const newBType = bResult.ok ? String(bResult.price) : "";
                    setFormData((prev) => ({
                      ...prev,
                      sellingPrice: raw,
                      costPrice: newCost,
                      bTypePrice: newBType,
                    }));
                  }}
                  placeholder="Enter sale price"
                />
              </div>

              <div className="form-group">
                <label htmlFor="costPrice">
                  Purchase Cost
                  <span style={{ fontWeight: 400, color: "var(--neutral-400)", fontSize: "0.7rem", marginLeft: 6 }}>
                    (sale − 50)
                  </span>
                </label>
                <input
                  id="costPrice"
                  type="text"
                  inputMode="decimal"
                  className="form-input"
                  value={formData.costPrice}
                  onChange={(e) => {
                    const raw = e.target.value;
                    if (raw !== "" && !/^\d*\.?\d*$/.test(raw)) return;
                    handleInputChange("costPrice", raw);
                  }}
                  placeholder="Enter purchase cost"
                />
              </div>

              <div className="form-group">
                <label htmlFor="bTypePrice">
                  B-Type Price
                  <span style={{ fontWeight: 400, color: "var(--neutral-400)", fontSize: "0.7rem", marginLeft: 6 }}>
                    (auto)
                  </span>
                </label>
                <input
                  id="bTypePrice"
                  type="text"
                  inputMode="decimal"
                  className="form-input"
                  value={formData.bTypePrice}
                  onChange={(e) => {
                    const raw = e.target.value;
                    if (raw !== "" && !/^\d*\.?\d*$/.test(raw)) return;
                    handleInputChange("bTypePrice", raw);
                  }}
                  placeholder="Enter B-type price"
                />
              </div>
            </div>
            {formData.sellingPrice && (
              <div className="pricing-derived-note">
                <span>A-Type</span>
                <strong>Rs. {formData.sellingPrice}</strong>
                {formData.bTypePrice && <><span style={{ margin: "0 4px", opacity: 0.4 }}>·</span><span>B-Type</span><strong>Rs. {formData.bTypePrice}</strong></>}
                {[formData.article.trim(), formData.size.trim(), productGroups.find((g) => g.id === formData.productGroupId)?.groupName ?? ""].filter(Boolean).join(" ") && (
                  <small style={{ marginLeft: "auto" }}>
                    {[formData.article.trim(), formData.size.trim(), productGroups.find((g) => g.id === formData.productGroupId)?.groupName ?? ""].filter(Boolean).join(" ")}
                  </small>
                )}
              </div>
            )}
          </section>

          {/* ── Contractor pricing ────────────────────────────────────────────
              What this product's work is normally paid: machine, packing and printing per
              DOZEN. Master data, set here like the sale price, and used as the DEFAULT when a
              machine program prices the article (docs/28). An empty box is NOT SET, not zero. */}
          <section className="party-form-card form-section">
            <h2>{copy.machineProgram.pricingTitle}</h2>
            <p className="form-section-note">{copy.products.contractorPricingNote}</p>
            <div className="pricing-fields">
              {CONTRACTOR_RATE_JOBS.map(({ key, label }) => {
                // The packing rate is the sum of its attributes once it has any.
                const fromAttributes = key === "packing" && packingItems.length > 0;
                const rateInput = (
                  <input
                    id={`rate-${key}`}
                    type="text"
                    inputMode="decimal"
                    className="form-input"
                    value={rates[key]}
                    readOnly={fromAttributes}
                    aria-readonly={fromAttributes || undefined}
                    onChange={(event) => {
                      const raw = event.target.value;
                      if (raw !== "" && !/^\d*\.?\d*$/.test(raw)) return;
                      setRates((previous) => ({ ...previous, [key]: raw }));
                    }}
                    placeholder="0.00"
                  />
                );
                return (
                  <div className="form-group" key={key}>
                    <label htmlFor={`rate-${key}`}>
                      {label}
                      <span className="label-hint">({copy.machineProgram.perDozen})</span>
                    </label>
                    {key === "packing" ? (
                      <div className="input-with-button">
                        {rateInput}
                        <button
                          type="button"
                          className="btn btn-icon"
                          title={copy.products.packingItems.add}
                          aria-label={copy.products.packingItems.add}
                          onClick={() => setPackingDialog({ index: null })}
                        >
                          +
                        </button>
                      </div>
                    ) : rateInput}
                    {fromAttributes && <span className="field-help">{copy.products.packingItems.sumOf(packingItems.length)}</span>}
                  </div>
                );
              })}
            </div>
            <PackingRateBreakdown
              items={packingItems}
              onEdit={(index) => setPackingDialog({ index })}
              onRemove={(index) => updatePackingItems(packingItems.filter((_, i) => i !== index))}
            />
            {errors.rates && <span className="error-message">{errors.rates}</span>}
          </section>
        </div>

        {/* ── column 2: image ─────────────────────────────────────────────── */}
        <aside className="party-form-card product-image-card form-section">
          <h2>Product Image</h2>
          <div className="product-image-dropzone">
            <div className="product-image-preview">
              {articleImageUrl
                ? <img src={articleImageUrl} alt={`${formData.article || "Product"} product image`} />
                : <div className="product-image-empty"><span aria-hidden="true">▧</span><span>{copy.empty.noImage}</span></div>
              }
            </div>
            <label htmlFor="productImageInput" className="btn btn-secondary product-upload-button">
              {articleImageUrl ? "Replace Image" : "Upload Image"}
            </label>
            <input id="productImageInput" type="file" accept="image/*" onChange={(e) => void handleImageUpload(e)} hidden />
          </div>
        </aside>

        {/* ── row 3: classification spanning both columns ──────────────────── */}
        <section className="party-form-card form-section classification-card">
          <h2>Classification</h2>
          <div className="form-row classification-card__row">
            {renderCombobox({
              id: "mainGroupId",
              label: "Main Group",
              selectedId: formData.mainGroupId,
              selectedName: selectedMainGroupName,
              query: mainGroupQuery,
              onQueryChange: setMainGroupQuery,
              menuOpen: mainGroupMenuOpen,
              setMenuOpen: setMainGroupMenuOpen,
              highlight: mainGroupHighlight,
              items: filteredMainGroups,
              onSelect: (item) => { handleInputChange("mainGroupId", item.id); setMainGroupQuery(""); setMainGroupMenuOpen(false); setMainGroupHighlight(0); },
              onClear: () => { handleInputChange("mainGroupId", ""); setMainGroupQuery(""); },
              onKeyDown: mainGroupKeyDown,
              onAdd: () => setShowAddMainGroup(true),
              addLabel: "Add new main group",
            })}

            {renderCombobox({
              id: "productGroupId",
              label: "Product Group",
              selectedId: formData.productGroupId,
              selectedName: selectedProductGroupName,
              query: productGroupQuery,
              onQueryChange: setProductGroupQuery,
              menuOpen: productGroupMenuOpen,
              setMenuOpen: setProductGroupMenuOpen,
              highlight: productGroupHighlight,
              items: filteredProductGroups,
              onSelect: (item) => { handleInputChange("productGroupId", item.id); setProductGroupQuery(""); setProductGroupMenuOpen(false); setProductGroupHighlight(0); },
              onClear: () => { handleInputChange("productGroupId", ""); setProductGroupQuery(""); },
              onKeyDown: productGroupKeyDown,
              onAdd: () => setShowAddProductGroup(true),
              addLabel: "Add new product group",
            })}

            {renderCombobox({
              id: "articleSeriesId",
              label: "Article Series",
              selectedId: formData.articleSeriesId,
              selectedName: selectedSeriesName,
              query: seriesQuery,
              onQueryChange: setSeriesQuery,
              menuOpen: seriesMenuOpen,
              setMenuOpen: setSeriesMenuOpen,
              highlight: seriesHighlight,
              items: filteredSeriesList,
              onSelect: (item) => { handleInputChange("articleSeriesId", item.id); setSeriesQuery(""); setSeriesMenuOpen(false); setSeriesHighlight(0); },
              onClear: () => { handleInputChange("articleSeriesId", ""); setSeriesQuery(""); },
              onKeyDown: seriesKeyDown,
              onAdd: () => setShowAddArticleSeries(true),
              addLabel: "Add new article series",
            })}

            {renderCombobox({
              id: "productTypeId",
              label: "Product Type",
              selectedId: formData.productTypeId,
              selectedName: selectedProductTypeName,
              query: productTypeQuery,
              onQueryChange: setProductTypeQuery,
              menuOpen: productTypeMenuOpen,
              setMenuOpen: setProductTypeMenuOpen,
              highlight: productTypeHighlight,
              items: filteredProductTypes,
              onSelect: (item) => { handleInputChange("productTypeId", item.id); setProductTypeQuery(""); setProductTypeMenuOpen(false); setProductTypeHighlight(0); },
              onClear: () => { handleInputChange("productTypeId", ""); setProductTypeQuery(""); },
              onKeyDown: productTypeKeyDown,
              onAdd: () => setShowAddProductType(true),
              addLabel: "Add new product type",
            })}

            {/* A sub group belongs to a product group, so this stays shut until one is chosen. */}
            {renderCombobox({
              id: "productSubGroupId",
              label: "Product Sub Group",
              selectedId: formData.productSubGroupId,
              selectedName: selectedProductSubGroupName,
              query: productSubGroupQuery,
              onQueryChange: setProductSubGroupQuery,
              menuOpen: productSubGroupMenuOpen,
              setMenuOpen: setProductSubGroupMenuOpen,
              highlight: productSubGroupHighlight,
              items: filteredProductSubGroups,
              onSelect: (item) => { handleInputChange("productSubGroupId", item.id); setProductSubGroupQuery(""); setProductSubGroupMenuOpen(false); setProductSubGroupHighlight(0); },
              onClear: () => { handleInputChange("productSubGroupId", ""); setProductSubGroupQuery(""); },
              onKeyDown: productSubGroupKeyDown,
              onAdd: () => setShowAddProductSubGroup(true),
              addLabel: "Add new product sub group",
              disabled: !formData.productGroupId,
              disabledHint: "Choose a Product Group first",
            })}
          </div>
        </section>

        {/* ── row 4: actions ───────────────────────────────────────────────── */}
        <div className="form-actions product-form-actions">
          <button type="button" className="btn btn-secondary" onClick={() => onNavigate("product-list")} disabled={loading}>{copy.common.cancel}</button>
          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? "Saving..." : productId ? "Update Product" : "Create Product"}
          </button>
        </div>
      </form>

      {/* ── Add Main Group modal ─────────────────────────────────────────── */}
      {showAddMainGroup && (
        <div
          className="member-modal-backdrop"
          role="presentation"
          onMouseDown={(e) => { if (e.target === e.currentTarget) { setShowAddMainGroup(false); setNewMainGroupName(""); } }}
        >
          <section className="member-modal product-add-modal" role="dialog" aria-modal="true" aria-labelledby="add-main-group-title">
            <div className="member-modal-header">
              <div className="member-modal-identity">
                <div>
                  <h2 id="add-main-group-title">Add Main Group</h2>
                </div>
              </div>
              <button type="button" className="member-modal-close" aria-label={copy.common.close} onClick={() => { setShowAddMainGroup(false); setNewMainGroupName(""); }}>×</button>
            </div>
            <div className="form-group" style={{ margin: "18px 0 6px" }}>
              <label htmlFor="newMainGroupName" className="input-label">Group Name <span className="required-mark">*</span></label>
              <input
                id="newMainGroupName"
                type="text"
                className="form-input input-upper"
                style={{ width: "100%" }}
                value={newMainGroupName}
                onChange={(e) => setNewMainGroupName(e.target.value.toUpperCase())}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); void handleAddMainGroup(); }
                  if (e.key === "Escape") { e.stopPropagation(); setShowAddMainGroup(false); setNewMainGroupName(""); }
                }}
                placeholder="Enter group name"
                autoFocus
              />
            </div>
            <div className="member-modal-actions">
              <span />
              <button type="button" className="btn btn-secondary" onClick={() => { setShowAddMainGroup(false); setNewMainGroupName(""); }}>{copy.common.cancel}</button>
              <button type="button" className="btn btn-primary" onClick={() => void handleAddMainGroup()} disabled={!newMainGroupName.trim()}>Create</button>
            </div>
          </section>
        </div>
      )}

      {/* ── Add Product Group modal ──────────────────────────────────────── */}
      {showAddProductGroup && (
        <div
          className="member-modal-backdrop"
          role="presentation"
          onMouseDown={(e) => { if (e.target === e.currentTarget) { setShowAddProductGroup(false); setNewProductGroupName(""); } }}
        >
          <section className="member-modal product-add-modal" role="dialog" aria-modal="true" aria-labelledby="add-product-group-title">
            <div className="member-modal-header">
              <div className="member-modal-identity">
                <div>
                  <h2 id="add-product-group-title">Add Product Group</h2>
                </div>
              </div>
              <button type="button" className="member-modal-close" aria-label={copy.common.close} onClick={() => { setShowAddProductGroup(false); setNewProductGroupName(""); }}>×</button>
            </div>
            <div className="form-group" style={{ margin: "18px 0 6px" }}>
              <label htmlFor="newProductGroupName" className="input-label">Group Name <span className="required-mark">*</span></label>
              <input
                id="newProductGroupName"
                type="text"
                className="form-input input-upper"
                style={{ width: "100%" }}
                value={newProductGroupName}
                onChange={(e) => setNewProductGroupName(e.target.value.toUpperCase())}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); void handleAddProductGroup(); }
                  if (e.key === "Escape") { e.stopPropagation(); setShowAddProductGroup(false); setNewProductGroupName(""); }
                }}
                placeholder="Enter group name"
                autoFocus
              />
            </div>
            <div className="member-modal-actions">
              <span />
              <button type="button" className="btn btn-secondary" onClick={() => { setShowAddProductGroup(false); setNewProductGroupName(""); }}>{copy.common.cancel}</button>
              <button type="button" className="btn btn-primary" onClick={() => void handleAddProductGroup()} disabled={!newProductGroupName.trim()}>Create</button>
            </div>
          </section>
        </div>
      )}

      {/* ── Add Article Series modal ─────────────────────────────────────── */}
      {showAddArticleSeries && (
        <div
          className="member-modal-backdrop"
          role="presentation"
          onMouseDown={(e) => { if (e.target === e.currentTarget) { setShowAddArticleSeries(false); setNewArticleSeriesName(""); } }}
        >
          <section className="member-modal product-add-modal" role="dialog" aria-modal="true" aria-labelledby="add-series-title">
            <div className="member-modal-header">
              <div className="member-modal-identity">
                <div>
                  <h2 id="add-series-title">Add Article Series</h2>
                </div>
              </div>
              <button type="button" className="member-modal-close" aria-label={copy.common.close} onClick={() => { setShowAddArticleSeries(false); setNewArticleSeriesName(""); }}>×</button>
            </div>
            <div className="form-group" style={{ margin: "18px 0 6px" }}>
              <label htmlFor="newArticleSeriesName" className="input-label">Series Name <span className="required-mark">*</span></label>
              <input
                id="newArticleSeriesName"
                type="text"
                className="form-input input-upper"
                style={{ width: "100%" }}
                value={newArticleSeriesName}
                onChange={(e) => setNewArticleSeriesName(e.target.value.toUpperCase())}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); void handleAddArticleSeries(); }
                  if (e.key === "Escape") { e.stopPropagation(); setShowAddArticleSeries(false); setNewArticleSeriesName(""); }
                }}
                placeholder="Enter series name"
                autoFocus
              />
            </div>
            <div className="member-modal-actions">
              <span />
              <button type="button" className="btn btn-secondary" onClick={() => { setShowAddArticleSeries(false); setNewArticleSeriesName(""); }}>{copy.common.cancel}</button>
              <button type="button" className="btn btn-primary" onClick={() => void handleAddArticleSeries()} disabled={!newArticleSeriesName.trim()}>{copy.common.save}</button>
            </div>
          </section>
        </div>
      )}

      {showAddProductType && (
        <div
          className="member-modal-backdrop"
          role="presentation"
          onMouseDown={(e) => { if (e.target === e.currentTarget) { setShowAddProductType(false); setNewProductTypeName(""); } }}
        >
          <section className="member-modal product-add-modal" role="dialog" aria-modal="true" aria-labelledby="add-product-type-title">
            <div className="member-modal-header">
              <div className="member-modal-identity">
                <div>
                  <h2 id="add-product-type-title">Add Product Type</h2>
                </div>
              </div>
              <button type="button" className="member-modal-close" aria-label={copy.common.close} onClick={() => { setShowAddProductType(false); setNewProductTypeName(""); }}>×</button>
            </div>
            <div className="form-group" style={{ margin: "18px 0 6px" }}>
              <label htmlFor="newProductTypeName" className="input-label">Type Name <span className="required-mark">*</span></label>
              <input
                id="newProductTypeName"
                type="text"
                className="form-input input-upper"
                style={{ width: "100%" }}
                value={newProductTypeName}
                onChange={(e) => setNewProductTypeName(e.target.value.toUpperCase())}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); void handleAddProductType(); }
                  if (e.key === "Escape") { e.stopPropagation(); setShowAddProductType(false); setNewProductTypeName(""); }
                }}
                placeholder="Enter product type"
                autoFocus
              />
            </div>
            <div className="member-modal-actions">
              <span />
              <button type="button" className="btn btn-secondary" onClick={() => { setShowAddProductType(false); setNewProductTypeName(""); }}>{copy.common.cancel}</button>
              <button type="button" className="btn btn-primary" onClick={() => void handleAddProductType()} disabled={!newProductTypeName.trim()}>{copy.common.save}</button>
            </div>
          </section>
        </div>
      )}
      {showAddProductSubGroup && (
        <div
          className="member-modal-backdrop"
          role="presentation"
          onMouseDown={(e) => { if (e.target === e.currentTarget) { setShowAddProductSubGroup(false); setNewProductSubGroupName(""); setNewSubGroupHasNoUpper(false); } }}
        >
          <section className="member-modal product-add-modal" role="dialog" aria-modal="true" aria-labelledby="add-product-sub-group-title">
            <div className="member-modal-header">
              <div className="member-modal-identity">
                <div>
                  <h2 id="add-product-sub-group-title">Add Product Sub Group</h2>
                  <p className="member-modal-sub">{`Under ${selectedProductGroupName}`}</p>
                </div>
              </div>
              <button type="button" className="member-modal-close" aria-label={copy.common.close} onClick={() => { setShowAddProductSubGroup(false); setNewProductSubGroupName(""); setNewSubGroupHasNoUpper(false); }}>×</button>
            </div>
            <div className="form-group" style={{ margin: "18px 0 6px" }}>
              <label htmlFor="newProductSubGroupName" className="input-label">Sub Group Name <span className="required-mark">*</span></label>
              <input
                id="newProductSubGroupName"
                type="text"
                className="form-input input-upper"
                style={{ width: "100%" }}
                value={newProductSubGroupName}
                onChange={(e) => setNewProductSubGroupName(e.target.value.toUpperCase())}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); void handleAddProductSubGroup(); }
                  if (e.key === "Escape") { e.stopPropagation(); setShowAddProductSubGroup(false); setNewProductSubGroupName(""); setNewSubGroupHasNoUpper(false); }
                }}
                placeholder="Enter sub group name"
                autoFocus
              />
            </div>
            <label className="product-fix-tick">
              <input
                type="checkbox"
                checked={newSubGroupHasNoUpper}
                onChange={(e) => setNewSubGroupHasNoUpper(e.target.checked)}
              />
              <span>
                <b>No upper — two sole colours</b>
                <small>For FIX articles, moulded from an outer and an inner sole. A machine program for one asks for the second sole instead of uppers.</small>
              </span>
            </label>
            <div className="member-modal-actions">
              <span />
              <button type="button" className="btn btn-secondary" onClick={() => { setShowAddProductSubGroup(false); setNewProductSubGroupName(""); setNewSubGroupHasNoUpper(false); }}>{copy.common.cancel}</button>
              <button type="button" className="btn btn-primary" onClick={() => void handleAddProductSubGroup()} disabled={!newProductSubGroupName.trim()}>{copy.common.save}</button>
            </div>
          </section>
        </div>
      )}
      {/* ── Add New Article modal ────────────────────────────────────────── */}
      {showAddArticle && (
        <div
          className="member-modal-backdrop"
          role="presentation"
          onMouseDown={(e) => { if (e.target === e.currentTarget) { setShowAddArticle(false); setNewArticleName(""); } }}
        >
          <section className="member-modal product-add-modal" role="dialog" aria-modal="true" aria-labelledby="add-article-title">
            <div className="member-modal-header">
              <div className="member-modal-identity">
                <div>
                  <h2 id="add-article-title">Add New Article</h2>
                </div>
              </div>
              <button type="button" className="member-modal-close" aria-label={copy.common.close} onClick={() => { setShowAddArticle(false); setNewArticleName(""); }}>×</button>
            </div>
            <div className="form-group" style={{ margin: "18px 0 6px" }}>
              <label htmlFor="newArticleName" className="input-label">Article Name <span className="required-mark">*</span></label>
              <input
                id="newArticleName"
                type="text"
                className="form-input input-upper"
                style={{ width: "100%" }}
                value={newArticleName}
                onChange={(e) => setNewArticleName(e.target.value.toUpperCase())}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); handleAddArticle(); }
                  if (e.key === "Escape") { e.stopPropagation(); setShowAddArticle(false); setNewArticleName(""); }
                }}
                placeholder="Enter article name"
                autoFocus
              />
            </div>
            <div className="member-modal-actions">
              <span />
              <button type="button" className="btn btn-secondary" onClick={() => { setShowAddArticle(false); setNewArticleName(""); }}>{copy.common.cancel}</button>
              <button type="button" className="btn btn-primary" onClick={handleAddArticle} disabled={!newArticleName.trim()}>Create</button>
            </div>
          </section>
        </div>
      )}

      {/* ── Add New Size modal ───────────────────────────────────────────── */}
      {showAddSize && (
        <div
          className="member-modal-backdrop"
          role="presentation"
          onMouseDown={(e) => { if (e.target === e.currentTarget) { setShowAddSize(false); setNewSizeName(""); } }}
        >
          <section className="member-modal product-add-modal" role="dialog" aria-modal="true" aria-labelledby="add-size-title">
            <div className="member-modal-header">
              <div className="member-modal-identity">
                <div>
                  <h2 id="add-size-title">Add New Size</h2>
                </div>
              </div>
              <button type="button" className="member-modal-close" aria-label={copy.common.close} onClick={() => { setShowAddSize(false); setNewSizeName(""); }}>×</button>
            </div>
            <div className="form-group" style={{ margin: "18px 0 6px" }}>
              <label htmlFor="newSizeName" className="input-label">{copy.columns.size}<span className="required-mark">*</span></label>
              <input
                id="newSizeName"
                type="text"
                className="form-input input-upper"
                style={{ width: "100%" }}
                value={newSizeName}
                onChange={(e) => setNewSizeName(e.target.value.toUpperCase())}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); handleAddSize(); }
                  if (e.key === "Escape") { e.stopPropagation(); setShowAddSize(false); setNewSizeName(""); }
                }}
                placeholder="Enter size"
                autoFocus
              />
            </div>
            <div className="member-modal-actions">
              <span />
              <button type="button" className="btn btn-secondary" onClick={() => { setShowAddSize(false); setNewSizeName(""); }}>{copy.common.cancel}</button>
              <button type="button" className="btn btn-primary" onClick={handleAddSize} disabled={!newSizeName.trim()}>Create</button>
            </div>
          </section>
        </div>
      )}

      {/* ── Add / Edit packing attribute ─────────────────────────────────── */}
      {packingDialog && (
        <PackingItemDialog
          item={packingDialog.index === null ? null : packingItems[packingDialog.index] ?? null}
          onSave={savePackingItem}
          onClose={() => setPackingDialog(null)}
        />
      )}

      {/* ── Duplicate Article+Size confirmation ──────────────────────────── */}
      {showDuplicateConfirm && duplicateMatch && (
        <div
          className="member-modal-backdrop"
          role="presentation"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setShowDuplicateConfirm(false); }}
        >
          <section className="member-modal product-add-modal" role="dialog" aria-modal="true" aria-labelledby="duplicate-product-title">
            <div className="member-modal-header">
              <div className="member-modal-identity">
                <div>
                  <h2 id="duplicate-product-title">Product Already Exists</h2>
                </div>
              </div>
              <button type="button" className="member-modal-close" aria-label={copy.common.close} onClick={() => setShowDuplicateConfirm(false)}>×</button>
            </div>
            <div style={{ margin: "18px 0 6px", fontSize: "0.9rem", color: "var(--neutral-700)", lineHeight: 1.5 }}>
              <p style={{ margin: 0 }}>
                <strong>{duplicateMatch.article} {duplicateMatch.size}</strong> already exists
                {duplicateMatch.productCode ? <> (Code: <strong>{duplicateMatch.productCode}</strong>)</> : null}
                {duplicateMatch.sellingPrice != null ? <> with a sale price of <strong>Rs. {duplicateMatch.sellingPrice}</strong></> : null}.
              </p>
              <p style={{ margin: "10px 0 0" }}>
                Do you want to edit the existing product with the details you entered? This will overwrite its current price and classification.
              </p>
            </div>
            <div className="member-modal-actions">
              <span />
              <button type="button" className="btn btn-secondary" onClick={() => setShowDuplicateConfirm(false)}>{copy.common.cancel}</button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => { setShowDuplicateConfirm(false); void saveProduct(); }}
              >
                Yes, Edit Existing Product
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
};
