import React from "react";
import { computeBTypePrice } from "@erp/domain";
import type { InventoryRow, ProductRow } from "../../types/desktopApi";
import { copy } from "../../config/copy";
import { formatDozens, formatMoney } from "../../app/format";
import { ColorSwatch } from "../shared/ColorSwatch";
import { getStockStatus, stockStatusBadgeClass, stockStatusLabel } from "./stockStatus";

interface ProductDetailSizeTableProps {
  /** Every size of the article, one ProductRow per size. */
  sizes: ProductRow[];
  /** On-hand rows (one per colour) for a given article + size. */
  stockRowsFor: (article: string, size: string) => InventoryRow[];
}

const uniqueColors = (rows: InventoryRow[]): string[] =>
  [...new Set(rows.map((row) => row.color).filter(Boolean))];

const sumCartons = (rows: InventoryRow[]): number =>
  rows.reduce((sum, row) => sum + row.quantity, 0);

const priceCell = (value: number | null): string => (value === null ? "—" : formatMoney(value));

const bTypeCell = (sellingPrice: number | null): string => {
  const result = computeBTypePrice(sellingPrice);
  return result.ok ? formatMoney(result.price) : "—";
};

/** Per-size breakdown inside the product detail popup: colours, stock and A/B prices. */
export const ProductDetailSizeTable: React.FC<ProductDetailSizeTableProps> = ({ sizes, stockRowsFor }) => {
  const labels = copy.products.detail;
  return (
    <table className="product-detail-table">
      <thead>
        <tr>
          <th scope="col">{copy.columns.size}</th>
          <th scope="col">{labels.colors}</th>
          <th scope="col">{labels.stock}</th>
          <th scope="col" className="is-numeric">{labels.priceA}</th>
          <th scope="col" className="is-numeric">{labels.priceB}</th>
        </tr>
      </thead>
      <tbody>
        {sizes.map((sizeProduct) => {
          const rows = stockRowsFor(sizeProduct.article, sizeProduct.size);
          const colors = uniqueColors(rows);
          const stock = sumCartons(rows);
          const status = getStockStatus(stock, sizeProduct.status);
          return (
            <tr key={sizeProduct.id}>
              <th scope="row">{sizeProduct.size}</th>
              <td>
                {colors.length === 0 ? (
                  <span className="product-detail-muted">—</span>
                ) : (
                  <span className="product-detail-colors">
                    {colors.map((color) => (
                      <span key={color} className="product-detail-color">
                        <ColorSwatch color={color} />
                        {color}
                      </span>
                    ))}
                  </span>
                )}
              </td>
              <td>
                <span className="product-detail-stock">
                  <strong>{formatDozens(stock)}</strong> {labels.dozen}
                  <span className={`badge ${stockStatusBadgeClass[status]}`}>{stockStatusLabel(status)}</span>
                </span>
              </td>
              <td className="is-numeric">{priceCell(sizeProduct.sellingPrice)}</td>
              <td className="is-numeric">{bTypeCell(sizeProduct.sellingPrice)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
};
