import React, { useState } from "react";
import { SearchableCombobox } from "../../components/shared/SearchableCombobox";
import { copy } from "../../config/copy";
import { articlesOf, sizesOf, type ProductChoice } from "./productChoices";

// ARTICLE → SIZE → COLOUR, from the active products. Shared by the two screens that put cartons on the
// figure: Manual Production and the carton adjustment. Only colours the product already has are offered.

const text = copy.manualProduction;

export const FormField: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="mpr-field">
    <span className="input-label" aria-hidden="true">{label}</span>
    {children}
  </div>
);

export interface ProductPick {
  article: string;
  articleSizeId: string;
  color: string;
  /** The chosen article and size, or null until a size is chosen. */
  product: ProductChoice | null;
  sizes: ProductChoice[];
  chooseArticle: (value: string) => void;
  chooseSize: (value: string) => void;
  chooseColor: (value: string) => void;
}

export const useProductPick = (products: readonly ProductChoice[]): ProductPick => {
  const [article, setArticle] = useState("");
  const [articleSizeId, setArticleSizeId] = useState("");
  const [color, setColor] = useState("");
  const sizes = sizesOf(products, article);
  return {
    article,
    articleSizeId,
    color,
    sizes,
    product: sizes.find((choice) => choice.articleSizeId === articleSizeId) ?? null,
    chooseArticle: (value) => {
      setArticle(value);
      setArticleSizeId("");
      setColor("");
    },
    chooseSize: (value) => {
      setArticleSizeId(value);
      setColor("");
    },
    chooseColor: setColor,
  };
};

export const ProductFields: React.FC<{ products: readonly ProductChoice[]; pick: ProductPick }> = ({ products, pick }) => (
  <>
    <FormField label={text.articleLabel}>
      <SearchableCombobox dropdown ariaLabel={text.articleLabel} placeholder={text.chooseArticle} value={pick.article}
        options={articlesOf(products).map((name) => ({ value: name, label: name }))} onChange={pick.chooseArticle} />
    </FormField>
    <FormField label={text.sizeLabel}>
      <SearchableCombobox dropdown ariaLabel={text.sizeLabel} placeholder={text.chooseSize} value={pick.articleSizeId}
        options={pick.sizes.map((choice) => ({ value: choice.articleSizeId, label: choice.size }))} onChange={pick.chooseSize} />
    </FormField>
    <FormField label={text.colorLabel}>
      <SearchableCombobox dropdown ariaLabel={text.colorLabel} placeholder={text.chooseColor} value={pick.color}
        emptyLabel={text.noColors} options={(pick.product?.colors ?? []).map((name) => ({ value: name, label: name }))} onChange={pick.chooseColor} />
    </FormField>
  </>
);
