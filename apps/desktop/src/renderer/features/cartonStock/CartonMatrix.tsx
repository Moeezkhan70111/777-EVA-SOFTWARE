import React, { useId } from "react";
import { cartonsToDozens, colorToUrdu, type CartonMatrixArticle } from "@erp/domain";
import { ColorSwatch } from "../../components/shared/ColorSwatch";
import { copy } from "../../config/copy";
import { useColorDictionary } from "../colorTranslation/colorDictionaryStore";
import { cellText } from "../upperStock/upperStock";

// One article's cartons in store: its name in a block on the left, then Size down the side, its own
// colours across the top, and a Total per size. No grand total and no total per colour: the owner's
// design. The table scrolls sideways inside the card when there are more colours than fit, the Size
// and Total columns held in place.

const text = copy.cartonStock;

/** The store counts cartons; the floor reads dozens (1 carton = half a dozen, owner 11 Nov 2026). */
const dozenCell = (cartons: number): string => cellText(cartonsToDozens(cartons));

export const CartonMatrix: React.FC<{ article: CartonMatrixArticle }> = ({ article }) => {
  const headingId = useId();
  const colors = useColorDictionary();
  return (
    <section className="cs-article" aria-labelledby={headingId}>
      <h2 className="cs-article-name" id={headingId}>{article.article}</h2>
      <div className="cs-table-scroll" role="region" aria-label={text.tableLabel(article.article)} tabIndex={0}>
        <table className="cs-table">
          <thead>
            <tr>
              <th scope="col" className="cs-size">{text.sizeInDozens}</th>
              {article.colours.map((colour) => {
                // Shown in Urdu from the shared colour list (docs/45), in English when the list does not name it.
                // Only the label changes: the column, its figures and the swatch still go by the stored English.
                const urdu = colorToUrdu(colour, colors);
                return (
                  <th scope="col" key={colour} title={colour}>
                    <span className="cs-colour">
                      <ColorSwatch color={colour} className="cs-dot" />
                      {urdu ? <span className="urdu-text" lang="ur" dir="rtl">{urdu}</span> : colour}
                    </span>
                  </th>
                );
              })}
              <th scope="col" className="cs-total">{text.total}</th>
            </tr>
          </thead>
          <tbody>
            {article.rows.map((row) => (
              <tr key={row.key}>
                <th scope="row" className="cs-size"><span className="cs-size-pill">{row.size}</span></th>
                {row.quantities.map((quantity, column) => (
                  <td key={article.colours[column]}>{dozenCell(quantity)}</td>
                ))}
                <td className="cs-total"><span className="cs-total-pill">{dozenCell(row.total)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
};
