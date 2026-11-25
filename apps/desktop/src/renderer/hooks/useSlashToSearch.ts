import { useEffect } from "react";

/**
 * "/" anywhere but a text field goes to the search, as on most search pages (the paradox of the active user: people
 * use what they already know). Written for Pending Orders, shared when the Customer Ledger needed it too (R1).
 */
export const useSlashToSearch = (input: React.RefObject<HTMLInputElement | null>) => {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      const typing = target?.closest("input, textarea, select, [contenteditable='true']");
      if (event.key !== "/" || typing || event.ctrlKey || event.metaKey || event.altKey) return;
      event.preventDefault();
      input.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [input]);
};
