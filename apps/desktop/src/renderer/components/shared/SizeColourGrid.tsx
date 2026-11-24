import React, { useRef } from "react";
import { ColorSwatch } from "./ColorSwatch";
import { SidewaysScrollArea } from "./SidewaysScrollArea";

// ONE ARTICLE AS A GRID: sizes down the side, colours across, one cell for every colour of every size, so the whole
// article is typed at once (owner, 13 Nov 2026). Written for Stock Adjustment; shared when Manual Production needed
// the same grid (R1). This draws the table, pins the Size column while the colours scroll sideways, and moves
// between boxes: Arrow Up and Down go to the same colour on the size above or below, Enter is the page's "add".
//
// WHAT IS IN A CELL is the page's own: `renderCell` returns the <td>. An input in it joins the keyboard moves by
// spreading the `box` it is given (data-row, data-column, onKeyDown).

/** The pinned Size column's width, for the sideways-scroll fades. */
const SIZE_COLUMN_WIDTH = 96;

export interface GridSize {
  readonly id: string;
  readonly size: string;
}

/** What an input in a cell spreads to take part in the arrow keys and Enter. */
export interface GridBoxProps {
  "data-row": number;
  "data-column": number;
  onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
}

interface SizeColourGridProps {
  /** The table's accessible name, e.g. "SK6 quantities". */
  label: string;
  sizeHeader: string;
  sizes: readonly GridSize[];
  colours: readonly string[];
  /** Enter in any box. */
  onEnter: () => void;
  renderCell: (size: GridSize, colour: string, box: GridBoxProps) => React.ReactNode;
  /** Something beside a colour's name in its heading, e.g. a button that takes the colour off (Enter Orders). */
  renderColourAction?: (colour: string) => React.ReactNode;
  /** A last row under the sizes, e.g. each colour's total (Enter Orders). Its cells are the page's own <td>s. */
  footer?: { label: string; renderCell: (colour: string) => React.ReactNode };
  /** How a colour's name reads in its heading, e.g. in Urdu (ColourName, the order pages). The stored English by default. */
  renderColourName?: (colour: string) => React.ReactNode;
}

export const SizeColourGrid: React.FC<SizeColourGridProps> = ({ label, sizeHeader, sizes, colours, onEnter, renderCell, renderColourAction, footer, renderColourName }) => {
  const tableRef = useRef<HTMLTableElement>(null);

  const keyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") { event.preventDefault(); onEnter(); return; }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const { row, column } = event.currentTarget.dataset;
    const next = Number(row) + (event.key === "ArrowDown" ? 1 : -1);
    const target = tableRef.current?.querySelector<HTMLInputElement>(`input[data-row="${String(next)}"][data-column="${String(column)}"]`);
    if (target) { event.preventDefault(); target.focus(); target.select(); }
  };

  return (
    <SidewaysScrollArea label={label} colourCount={colours.length} pinnedStart={SIZE_COLUMN_WIDTH}>
      <table ref={tableRef} className="data-table sa-grid">
        <thead>
          <tr>
            <th scope="col" className="sa-grid-size">{sizeHeader}</th>
            {colours.map((colour) => (
              <th scope="col" key={colour} className="sa-grid-colour">
                <span className="sa-grid-colour-name"><ColorSwatch color={colour} />{renderColourName ? renderColourName(colour) : colour}{renderColourAction?.(colour)}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sizes.map((size, row) => (
            <tr key={size.id}>
              <th scope="row" className="sa-grid-size">{size.size}</th>
              {colours.map((colour, column) => (
                <React.Fragment key={colour}>{renderCell(size, colour, { "data-row": row, "data-column": column, onKeyDown: keyDown })}</React.Fragment>
              ))}
            </tr>
          ))}
        </tbody>
        {footer ? (
          <tfoot>
            <tr className="sa-grid-foot">
              <th scope="row" className="sa-grid-size">{footer.label}</th>
              {colours.map((colour) => (
                <React.Fragment key={colour}>{footer.renderCell(colour)}</React.Fragment>
              ))}
            </tr>
          </tfoot>
        ) : null}
      </table>
    </SidewaysScrollArea>
  );
};
