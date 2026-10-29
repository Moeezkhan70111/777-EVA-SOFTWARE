import React from "react";
import { copy } from "../../../config/copy";
import { HandMovePanel } from "../HandMovePanel";

/** Manual Entry: material that came without labels, typed in rather than scanned. */
export const ManualEntry: React.FC<{ token: string }> = ({ token }) => (
  <div className="si-manual-open">
    <header className="si-manual-head">
      <h2 className="si-manual-title">{copy.moveOut.manualInTitle}</h2>
    </header>
    <HandMovePanel direction="IN" token={token} />
  </div>
);
