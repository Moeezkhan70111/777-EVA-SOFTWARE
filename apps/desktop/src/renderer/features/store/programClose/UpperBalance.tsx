import React from "react";
import { copy } from "../../../config/copy";
import type { ReconciliationLine } from "../../../types/desktopApi";
import { upperBalance, upperDraftProblem, type UpperDraft } from "./upperDraft";

// The line's balance, as it is typed:
//
//   Remaining to account for          6 pairs
//   Cut size upper — back in stock    2
//   Cut size pairs — back in stock    3
//   Claimed — deducted on the ledger  1
//   Unresolved                        0          ✓ All 6 pairs accounted for
//
// Said in words, never by colour alone: the last line names what is still wrong.

const text = copy.programClose;

export const UpperBalance: React.FC<{ line: ReconciliationLine; name: string; draft: UpperDraft }> = ({ line, name, draft }) => {
  const balance = upperBalance(line, draft);
  const problem = upperDraftProblem(line, draft);
  const rows: Array<[string, number]> = [
    [text.balCutUpper, balance.cutSizeUppers],
    [text.balCutPairs, balance.cutSizePairs],
    [text.balClaimed, balance.claimed],
  ];
  return (
    <div className="mur-balance">
      <table className="mur-balance-table" aria-label={text.balanceTitle(name)}>
        <tbody>
          <tr className="mur-balance-total">
            <th scope="row">{text.balRemaining}</th>
            <td>{text.pairs(balance.remaining)}</td>
          </tr>
          {rows.map(([label, pairs]) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              <td>{Number.isFinite(pairs) ? pairs : "—"}</td>
            </tr>
          ))}
          <tr className="mur-balance-unresolved">
            <th scope="row">{text.balUnresolved}</th>
            <td>{Number.isFinite(balance.unresolved) ? balance.unresolved : "—"}</td>
          </tr>
        </tbody>
      </table>
      <p className={`mur-line-status${problem ? "" : " is-ok"}`} role="status">
        {problem ? `⚠ ${problem}` : `✓ ${text.allAccounted(balance.remaining)}`}
      </p>
    </div>
  );
};
