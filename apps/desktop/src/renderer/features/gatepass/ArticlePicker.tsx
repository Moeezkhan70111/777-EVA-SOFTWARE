import React, { useState } from "react";
import { copy } from "../../config/copy";
import { SearchSelect } from "./SearchSelect";
import type { ArticleOption } from "./gatepassDraft";

// "+ Add Article": a small search that appears on demand, lists every article + size the
// store holds, and hands the chosen one back. Picking closes it; Escape or clicking away
// closes it without a choice.

interface ArticlePickerProps {
  options: ArticleOption[];
  disabled?: boolean;
  onPick: (key: string) => void;
}

export const ArticlePicker: React.FC<ArticlePickerProps> = ({ options, disabled, onPick }) => {
  const [open, setOpen] = useState(false);

  return (
    <div className="gp-picker">
      {/* Opens only: clicking away or Escape closes, so a second click on the button never re-toggles it. */}
      <button type="button" className="btn btn-secondary btn-sm gp-picker-btn" disabled={disabled} aria-expanded={open} onClick={() => setOpen(true)} data-testid="gatepass-add-article">
        <span aria-hidden="true">+</span> {copy.gatepass.addArticle}
      </button>
      {open && (
        <div className="gp-picker-pop" data-testid="gatepass-article-picker">
          <SearchSelect
            id="gp-article-search"
            label={copy.gatepass.addArticleLabel}
            hideLabel
            autoOpen
            placeholder={copy.gatepass.articlePlaceholder}
            options={options}
            value=""
            emptyText={copy.gatepass.articleNoMatch}
            onChange={(key) => {
              if (!key) return;
              setOpen(false);
              onPick(key);
            }}
            onDismiss={() => setOpen(false)}
          />
        </div>
      )}
    </div>
  );
};
