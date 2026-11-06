import React, { useId, useState } from "react";
import type { UpperMatrixArticle } from "@erp/domain";
import { ColorSwatch } from "../../components/shared/ColorSwatch";
import { copy } from "../../config/copy";
import { NAV_ICONS, RAIL_ICONS } from "../navigation/NavIcons";
import { categoryLabel, cellText, stockPillText } from "./upperStock";

// One article's stock on its own card: its name, its kind and what it holds across the head, then
// Size down the side, its own colours across the top, a Total per size, and one grand total. There
// is deliberately no total per colour. The head stays when the card is folded shut, so an article
// and its total can still be read with the table away.
//
// The table scrolls sideways inside its own box when an article has more colours than fit, with
// the Size and Total columns held in place, so a figure can always be read against its size and
// the totals never leave the screen.

export const UpperMatrix: React.FC<{ article: UpperMatrixArticle }> = ({ article }) => {
  const headingId = useId();
  const tableId = useId();
  const [open, setOpen] = useState(true);
  const name = article.article || copy.upperStock.noArticle;
  return (
    <section className="us-article" aria-labelledby={headingId}>
      <div className="us-article-head">
        <span className="us-article-icon" aria-hidden="true">{NAV_ICONS.stock}</span>
        <h2 className="us-article-name" id={headingId}>{name}</h2>
        <span className="us-article-category">{categoryLabel(article.categoryName)}</span>
        <span className="us-article-stock">
          <span className="us-article-stock-icon" aria-hidden="true">{NAV_ICONS.stock}</span>
          {stockPillText(article.total, article.unitCode)}
        </span>
        <button
          type="button"
          className={`us-fold${open ? "" : " is-shut"}`}
          aria-expanded={open}
          aria-controls={tableId}
          aria-label={copy.upperStock.foldLabel(name)}
          onClick={() => setOpen((value) => !value)}
        >
          {RAIL_ICONS.chevronUp}
        </button>
      </div>
      <div id={tableId} className="us-table-scroll" role="region" aria-label={copy.upperStock.tableLabel(name)} tabIndex={0} hidden={!open}>
        <table className="us-table">
          <thead>
            <tr>
              <th scope="col" className="us-size">{copy.upperStock.size}</th>
              {article.colours.map((colour) => (
                <th scope="col" key={colour}>
                  <span className="us-colour">
                    {colour ? <ColorSwatch color={colour} className="us-swatch" /> : null}
                    {colour || copy.upperStock.noColour}
                  </span>
                </th>
              ))}
              <th scope="col" className="us-total">{copy.upperStock.total}</th>
            </tr>
          </thead>
          <tbody>
            {article.rows.map((row) => (
              <tr key={row.key}>
                <th scope="row" className="us-size">
                  <span className="us-size-pill">
                    {row.size || copy.upperStock.noSize}
                    {row.type ? <span className="us-type">{row.type}</span> : null}
                  </span>
                </th>
                {row.quantities.map((quantity, column) => (
                  <td key={article.colours[column]}>{cellText(quantity)}</td>
                ))}
                <td className="us-total">{cellText(row.total)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" className="us-grand-label" colSpan={article.colours.length + 1}>
                <span className="us-grand-text">{copy.upperStock.grandTotal(article.unitCode)}</span>
              </th>
              <td className="us-grand">{cellText(article.total)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
};
