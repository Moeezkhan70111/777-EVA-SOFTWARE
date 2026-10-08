import React, { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import type { InventoryRow, ProductRow } from "../../types/desktopApi";
import { copy } from "../../config/copy";
import { formatDozens, formatWholeMoney } from "../../app/format";
import { ProductDetailSizeTable } from "./ProductDetailSizeTable";

export type SellingType = "NORMAL" | "B_TYPE";

interface ProductDetailModalProps {
  product: ProductRow;
  sellingType: SellingType;
  /** Every size of this article (one row per size). */
  articleSizes: ProductRow[];
  /** Distinct physical colours on hand across the whole article. */
  colors: string[];
  /** On-hand cartons across the whole article. */
  totalStockCartons: number;
  imageUrl: string | null;
  stockRowsFor: (article: string, size: string) => InventoryRow[];
  onClose: () => void;
  onEdit: (productId: string) => void;
}

// Summary tile only — whole rupees, like the ledger pages; exact prices are in the table.
const priceRange = (sizes: ProductRow[]): string => {
  const prices = sizes.map((row) => row.sellingPrice).filter((price): price is number => price !== null);
  if (prices.length === 0) return "—";
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  return min === max ? formatWholeMoney(min) : `${formatWholeMoney(min)} – ${formatWholeMoney(max)}`;
};

const classification = (product: ProductRow): string[] =>
  [product.mainGroupName, product.groupName, product.articleSeriesName].filter(
    (name): name is string => Boolean(name),
  );

/**
 * Article popup opened from the product list. The image card lands first, then the
 * details card slides out from behind it (see `.product-detail-*` in theme.css).
 * Rendered into <body> so it sits above the navbar instead of inside .page-content's
 * lower stacking context.
 */
export const ProductDetailModal: React.FC<ProductDetailModalProps> = ({
  product, sellingType, articleSizes, colors, totalStockCartons, imageUrl, stockRowsFor, onClose, onEdit,
}) => {
  const labels = copy.products.detail;
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const crumbs = classification(product);

  // Escape closes the popup; `data-suppress-esc` stops the app-level Escape → home shortcut.
  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return createPortal(
    <div className="product-detail-backdrop" data-suppress-esc="1" onClick={onClose}>
      <div
        className="product-detail-stage"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <figure className="product-detail-hero">
          <span className={`product-type-badge product-detail-hero-badge ${sellingType === "B_TYPE" ? "b-type" : "normal"}`}>
            {sellingType === "B_TYPE" ? labels.sellingTypeB : labels.sellingTypeA}
          </span>
          {imageUrl ? (
            <img src={imageUrl} alt={`${product.article} product`} />
          ) : (
            <span className="product-detail-hero-empty">{copy.empty.noImage}</span>
          )}
          {product.productCode && (
            <figcaption className="product-detail-hero-code">
              <span>{labels.productCode}</span>
              <strong>{product.productCode}</strong>
            </figcaption>
          )}
        </figure>

        <section className="product-detail-card">
          <button
            type="button"
            ref={closeRef}
            className="product-detail-close"
            aria-label={labels.closeAria}
            onClick={onClose}
          >
            ×
          </button>

          <header className="product-detail-heading product-detail-reveal">
            <span className="product-detail-eyebrow">{labels.eyebrow}</span>
            <h2 id={titleId}>{product.article}</h2>
            <div className="product-detail-crumbs">
              {crumbs.length === 0 ? (
                <span className="product-detail-crumb">{labels.unclassified}</span>
              ) : (
                crumbs.map((crumb) => <span key={crumb} className="product-detail-crumb">{crumb}</span>)
              )}
            </div>
          </header>

          <dl className="product-detail-stats product-detail-reveal">
            <div><dt>{labels.sizes}</dt><dd>{articleSizes.length}</dd></div>
            <div><dt>{labels.colors}</dt><dd>{colors.length}</dd></div>
            <div>
              <dt>{labels.totalStock}</dt>
              <dd>{formatDozens(totalStockCartons)} <small>{labels.dozen}</small></dd>
            </div>
            <div><dt>{labels.priceRange}</dt><dd>{priceRange(articleSizes)}</dd></div>
          </dl>

          <div className="product-detail-table-wrap product-detail-reveal">
            <ProductDetailSizeTable sizes={articleSizes} stockRowsFor={stockRowsFor} />
          </div>

          {product.description && (
            <div className="product-detail-description product-detail-reveal">
              <span>{copy.columns.description}</span>
              <p>{product.description}</p>
            </div>
          )}

          <footer className="product-detail-actions product-detail-reveal">
            <button type="button" className="btn btn-secondary" onClick={() => onEdit(product.id)}>
              {labels.editProduct}
            </button>
            <button type="button" className="btn btn-primary" onClick={onClose}>
              {copy.common.close}
            </button>
          </footer>
        </section>
      </div>
    </div>,
    document.body,
  );
};
