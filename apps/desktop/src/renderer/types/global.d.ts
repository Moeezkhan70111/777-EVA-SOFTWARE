import type { DesktopApi } from "./desktopApi";

declare global {
  interface Window {
    desktop: {
      versions: {
        node: string;
        chrome: string;
        electron: string;
      };
      api: DesktopApi;
    };
  }
}

export {};
