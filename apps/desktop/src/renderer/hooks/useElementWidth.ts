import { useEffect, useState } from "react";

// The width of an element, kept up to date as the window or the sidebar changes size. Pass the
// returned ref to the element; it may appear later (after loading) and is watched from then on.
// 0 until measured, and where ResizeObserver does not exist.

export const useElementWidth = <T extends HTMLElement>() => {
  const [node, setNode] = useState<T | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    if (!node || typeof ResizeObserver !== "function") return undefined;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(Math.floor(entry.contentRect.width));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);

  return [setNode, width] as const;
};
