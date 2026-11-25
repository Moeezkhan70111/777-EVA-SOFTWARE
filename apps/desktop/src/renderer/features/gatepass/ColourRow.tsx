import React from "react";
import { ColorSwatch } from "../../components/shared/ColorSwatch";
import { copy } from "../../config/copy";
import { dozensText, type DraftArticle, type DraftColour } from "./gatepassDraft";

// One colour of an article + size on a STORED Gatepass, read-only:
//
//   Colour │ In Store at creation │ Gatepass Qty │ Moved out │ Outstanding
//
// A gatepass being written is typed in its article's grid instead (ArticleGridCard, 25 Nov 2026).

const testId = (prefix: string, article: DraftArticle, colour: DraftColour) => `${prefix}-${article.article}-${colour.colour}-${article.size}`;

const ColourCell: React.FC<{ colour: string }> = ({ colour }) => (
  <td className="gp-colour-cell">
    <span className="gp-colour-name">
      <ColorSwatch color={colour} />
      {colour}
    </span>
  </td>
);

type LineProgress = NonNullable<DraftColour["progress"]>;

/** What is left for the store on this line: a number, or a badge once nothing is. Issued cartons are never "moved out". */
const OutstandingCell: React.FC<{ progress: LineProgress; quantity: number }> = ({ progress, quantity }) => {
  if (progress.issuedDirectly > 0 && progress.issuedDirectly >= quantity) {
    return <span className="badge badge-ok">{copy.gatepass.issuedDirectly}</span>;
  }
  if (progress.outstanding <= 0) return <span className="badge badge-ok">{copy.gatepass.allMovedOut}</span>;
  return <>{dozensText(progress.outstanding)}</>;
};

/**
 * A stored document: the creation snapshot, the quantity, what Store Move Out has scanned out, and what
 * is left to scan. Cartons issued directly (no QR, docs/42) are shown as issued, never as scanned.
 */
const DocumentRow: React.FC<{ article: DraftArticle; colour: DraftColour }> = ({ article, colour }) => {
  const progress = colour.progress ?? { dispatchedFromStore: 0, issuedDirectly: 0, outstanding: colour.check.value ?? 0 };
  const done = progress.outstanding <= 0;
  return (
    <tr className={done ? "is-done" : undefined}>
      <ColourCell colour={colour.colour} />
      <td className="num gp-colour-avail" data-testid={testId("available", article, colour)}>
        {dozensText(colour.currentStock)}
      </td>
      <td className="num gp-colour-qty">
        <strong className="gp-qty-value" data-testid={testId("qty", article, colour)}>
          {dozensText(colour.check.value ?? 0)}
        </strong>
      </td>
      <td className="num" data-testid={testId("moved-out", article, colour)}>
        {dozensText(progress.dispatchedFromStore)}
        {progress.issuedDirectly > 0 ? ` · ${copy.gatepass.issuedDirectlyNote(dozensText(progress.issuedDirectly))}` : null}
      </td>
      <td className="num" data-testid={testId("outstanding", article, colour)}>
        <OutstandingCell progress={progress} quantity={colour.check.value ?? 0} />
      </td>
    </tr>
  );
};

export const ColourRow: React.FC<{ article: DraftArticle; colour: DraftColour }> = ({ article, colour }) => <DocumentRow article={article} colour={colour} />;
