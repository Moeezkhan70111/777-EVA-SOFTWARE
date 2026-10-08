import { useEffect } from "react";
import { shortcutRouteMap, type AppRoute } from "./routes";

export const useRouteKeyboard = (
  setRoute: React.Dispatch<React.SetStateAction<AppRoute>>,
  onBackup: () => void,
  onEscape: () => void,
) => {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key.toLowerCase() === "b") {
        event.preventDefault();
        onBackup();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        onEscape();
        return;
      }
      // Zoom in: Ctrl++ (Ctrl+Shift+=) or Ctrl+= (numpad/unshifted)
      if (event.ctrlKey && (event.key === "+" || event.key === "=")) {
        event.preventDefault();
        const zoom = (window as Window & { desktop?: { zoom?: { getLevel: () => number; setLevel: (l: number) => void } } }).desktop?.zoom;
        if (zoom) zoom.setLevel(Math.min(zoom.getLevel() + 1, 9));
        return;
      }
      // Zoom out: Ctrl+-
      if (event.ctrlKey && event.key === "-") {
        event.preventDefault();
        const zoom = (window as Window & { desktop?: { zoom?: { getLevel: () => number; setLevel: (l: number) => void } } }).desktop?.zoom;
        if (zoom) zoom.setLevel(Math.max(zoom.getLevel() - 1, -9));
        return;
      }
      // Zoom reset: Ctrl+0
      if (event.ctrlKey && event.key === "0") {
        event.preventDefault();
        const zoom = (window as Window & { desktop?: { zoom?: { getLevel: () => number; setLevel: (l: number) => void } } }).desktop?.zoom;
        if (zoom) zoom.setLevel(0);
        return;
      }
      const route = shortcutRouteMap[event.key.toUpperCase()];
      if (route) {
        event.preventDefault();
        setRoute(route);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [setRoute, onBackup, onEscape]);
};
