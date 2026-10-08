import { NAV_PERMISSION_MODULES } from "../../components/layout/Navbar";

/** Human label for a permission code, from the navigation's module/child catalogue. */
export const describePerm = (code: string): string => {
  for (const module of NAV_PERMISSION_MODULES) {
    if (module.id === code) return module.label;
    for (const [childId, childLabel] of module.children) {
      if (childId === code) return childLabel;
    }
  }
  return code;
};
