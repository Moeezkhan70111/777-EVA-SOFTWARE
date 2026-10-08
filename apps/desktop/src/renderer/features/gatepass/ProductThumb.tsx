import React from "react";
import { copy } from "../../config/copy";

interface ProductThumbProps {
  article: string;
  /** Data URL from the product image store; `null` when none exists; `undefined` while looking. */
  src: string | null | undefined;
  small?: boolean;
}

/** The article's picture, or an honest "Image not found" — never a stand-in that looks real. */
export const ProductThumb: React.FC<ProductThumbProps> = ({ article, src, small }) => (
  <div className={`gp-thumb${small ? " gp-thumb--sm" : ""}`}>
    {src ? (
      <img src={src} alt={`${article} product`} className="gp-thumb-img" />
    ) : (
      <span className="gp-thumb-missing">{src === null ? copy.gatepass.imageNotFound : ""}</span>
    )}
  </div>
);
