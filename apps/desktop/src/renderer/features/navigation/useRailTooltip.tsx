import React, { useCallback, useState } from "react";
import { createPortal } from "react-dom";

// The slim rail's name tags. Each row carries its name in data-tip; one listener on the rail
// finds the row under the pointer, and one tooltip is drawn beside the rail's right edge.
//
// PORTALLED to the body, because the rail's list scrolls and so clips anything that pokes out of
// it on either axis. Purely visual: every row already carries its name as text (the label, only
// faded out while the rail is slim), so a screen reader never needs the tooltip.

interface Tip {
  label: string;
  top: number;
  left: number;
}

const TIP_GAP_PX = 10;

export const useRailTooltip = (enabled: boolean) => {
  const [tip, setTip] = useState<Tip | null>(null);

  const onMouseOver = useCallback((event: React.MouseEvent<HTMLElement>) => {
    const target = event.target instanceof Element ? event.target : null;
    const row = target?.closest<HTMLElement>("[data-tip]");
    if (!row || !event.currentTarget.contains(row)) {
      setTip(null);
      return;
    }
    const rowRect = row.getBoundingClientRect();
    const railRect = event.currentTarget.getBoundingClientRect();
    setTip({ label: row.dataset.tip ?? "", top: rowRect.top + rowRect.height / 2, left: railRect.right + TIP_GAP_PX });
  }, []);

  const hide = useCallback(() => setTip(null), []);

  const tooltip =
    enabled && tip
      ? createPortal(
          <div className="rail-tooltip" role="presentation" style={{ top: `${String(Math.round(tip.top))}px`, left: `${String(Math.round(tip.left))}px` }}>
            {tip.label}
          </div>,
          document.body
        )
      : null;

  return { onMouseOver, hide, tooltip };
};
