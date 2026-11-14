import React, { useId } from "react";
import { cartonsToDozens, colorToUrdu, type CartonMatrixArticle, type ColorDictionary } from "@erp/domain";
import { ColorSwatch } from "../../components/shared/ColorSwatch";
import { SidewaysScrollArea } from "../../components/shared/SidewaysScrollArea";
import { copy } from "../../config/copy";
import { useColorDictionary } from "../colorTranslation/colorDictionaryStore";
import { cellText } from "../upperStock/upperStock";
import type { CartonLayout } from "./cartonMatrixLayout";

// One article's cartons in store: its name in a block on the left, then Size down the side, its own
// colours across the top, a Total per size, and a Total row along the bottom: each colour added up and the article's
// grand total in the corner (owner, 13 Nov 2026). When there are more colours than fit, the table scrolls sideways inside the card, the Size
// and Total columns held in place, and the card says so plainly (SidewaysScrollArea).

const text = copy.cartonStock;

/** The store counts cartons; the floor reads dozens (1 carton = half a dozen, owner 11 Nov 2026). */
const dozenCell = (cartons: number): string => cellText(cartonsToDozens(cartons));

/** The same figure in dozens where nothing is a dash: 0 reads "0" (the Total Carton Stock card). */
export const dozenFigure = (cartons: number): string => (cartons === 0 ? "0" : dozenCell(cartons));

const ColourHead: React.FC<{ colour: string; colors: ColorDictionary }> = ({ colour, colors }) => {
  // Shown in Urdu from the shared colour list (docs/45), in English when the list does not name it.
  // Only the label changes: the column, its figures and the swatch still go by the stored English.
  const urdu = colorToUrdu(colour, colors);
  return (
    <th scope="col" className="cs-colour-head" title={colour}>
      <span className="cs-colour">
        <ColorSwatch color={colour} className="cs-dot" />
        {urdu ? <span className="urdu-text" lang="ur" dir="rtl">{urdu}</span> : colour}
      </span>
    </th>
  );
};

const MatrixTable: React.FC<{ article: CartonMatrixArticle; layout: CartonLayout }> = ({ article, layout }) => {
  const colors = useColorDictionary();
  return (
    <table className="cs-table">
      <colgroup>
        <col style={{ width: layout.sizeWidth }} />
        {article.colours.map((colour) => (
          <col key={colour} />
        ))}
        <col style={{ width: layout.totalWidth }} />
      </colgroup>
      <thead>
        <tr>
          <th scope="col" className="cs-size">{text.sizeInDozens}</th>
          {article.colours.map((colour) => (
            <ColourHead key={colour} colour={colour} colors={colors} />
          ))}
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
      <tfoot>
        <tr className="cs-grand">
          <th scope="row" className="cs-size">{text.total}</th>
          {article.colourTotals.map((quantity, column) => (
            <td key={article.colours[column]}>{dozenCell(quantity)}</td>
          ))}
          <td className="cs-total"><span className="cs-total-pill cs-grand-pill">{dozenCell(article.total)}</span></td>
        </tr>
      </tfoot>
    </table>
  );
};

interface CartonMatrixProps {
  article: CartonMatrixArticle;
  layout: CartonLayout;
  /** The table's accessible name. Carton Stock's own when not given. */
  tableLabel?: (article: string) => string;
  /** A control under the article's name (the Manual Production page's Edit). None on Carton Stock. */
  action?: React.ReactNode;
}

export const CartonMatrix: React.FC<CartonMatrixProps> = ({ article, layout, tableLabel = text.tableLabel, action }) => {
  const headingId = useId();
  const name = <h2 className="cs-article-name" id={headingId}>{article.article}</h2>;
  return (
    <section className="cs-article" aria-labelledby={headingId}>
      {action ? <div className="cs-article-head">{name}<div className="cs-article-action">{action}</div></div> : name}
      <SidewaysScrollArea label={tableLabel(article.article)} colourCount={article.colours.length}
        pinnedStart={layout.sizeWidth} pinnedEnd={layout.totalWidth}>
        <MatrixTable article={article} layout={layout} />
      </SidewaysScrollArea>
    </section>
  );
};
