import React, { useId } from "react";
import { cartonsToDozens, colorToUrdu, type CartonMatrixArticle, type ColorDictionary } from "@erp/domain";
import { ColorSwatch } from "../../components/shared/ColorSwatch";
import { copy } from "../../config/copy";
import { useColorDictionary } from "../colorTranslation/colorDictionaryStore";
import { cellText } from "../upperStock/upperStock";
import { colourBands, type CartonLayout } from "./cartonMatrixLayout";

// One article's cartons in store: its name in a block on the left, then Size down the side, its own
// colours across the top, and a Total per size. No grand total and no total per colour: the owner's
// design. Nothing scrolls sideways: colours that do not fit continue in a band underneath, with the
// sizes repeated, and the Total stays on the last band (cartonMatrixLayout).

const text = copy.cartonStock;

/** The store counts cartons; the floor reads dozens (1 carton = half a dozen, owner 11 Nov 2026). */
const dozenCell = (cartons: number): string => cellText(cartonsToDozens(cartons));

interface BandProps {
  article: CartonMatrixArticle;
  /** The colour columns this band shows. */
  columns: number[];
  /** "Colors 1–7 of 14" above the band; only when the article needs more than one. */
  caption: string | null;
  withTotal: boolean;
  layout: CartonLayout;
  colors: ColorDictionary;
}

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

const Band: React.FC<BandProps> = ({ article, columns, caption, withTotal, layout, colors }) => (
  <table className="cs-table cs-band">
    {caption ? <caption className="cs-band-caption">{caption}</caption> : null}
    <colgroup>
      <col style={{ width: layout.sizeWidth }} />
      {columns.map((column) => (
        <col key={article.colours[column]} />
      ))}
      {withTotal ? <col style={{ width: layout.totalWidth }} /> : null}
    </colgroup>
    <thead>
      <tr>
        <th scope="col" className="cs-size">{text.sizeInDozens}</th>
        {columns.map((column) => (
          <ColourHead key={article.colours[column]} colour={article.colours[column] ?? ""} colors={colors} />
        ))}
        {withTotal ? <th scope="col" className="cs-total">{text.total}</th> : null}
      </tr>
    </thead>
    <tbody>
      {article.rows.map((row) => (
        <tr key={row.key}>
          <th scope="row" className="cs-size"><span className="cs-size-pill">{row.size}</span></th>
          {columns.map((column) => (
            <td key={article.colours[column]}>{dozenCell(row.quantities[column] ?? 0)}</td>
          ))}
          {withTotal ? <td className="cs-total"><span className="cs-total-pill">{dozenCell(row.total)}</span></td> : null}
        </tr>
      ))}
    </tbody>
  </table>
);

export const CartonMatrix: React.FC<{ article: CartonMatrixArticle; layout: CartonLayout }> = ({ article, layout }) => {
  const headingId = useId();
  const colors = useColorDictionary();
  const bands = colourBands(article.colours.length, layout.maxColours);
  const count = article.colours.length;
  return (
    <section className="cs-article" aria-labelledby={headingId}>
      <h2 className="cs-article-name" id={headingId}>{article.article}</h2>
      <div className="cs-table-scroll" role="region" aria-label={text.tableLabel(article.article)}>
        {bands.map((columns, index) => (
          <Band
            key={columns[0] ?? index}
            article={article}
            columns={columns}
            caption={bands.length > 1 ? text.colourBand((columns[0] ?? 0) + 1, (columns.at(-1) ?? 0) + 1, count) : null}
            withTotal={index === bands.length - 1}
            layout={layout}
            colors={colors}
          />
        ))}
      </div>
    </section>
  );
};
