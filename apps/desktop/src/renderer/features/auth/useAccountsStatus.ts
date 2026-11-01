import { useCallback, useEffect, useState } from "react";
import type { AccountsStatus, DesktopApi } from "../../types/desktopApi";

// Which accounts this computer uses (docs/41), read from the main process. Four states (R12): the
// switch card shows nothing while loading, a retry on error, and decides from the status otherwise.

export type AccountsStatusState =
  | { readonly kind: "loading" }
  | { readonly kind: "error" }
  | { readonly kind: "ready"; readonly status: AccountsStatus };

export const useAccountsStatus = (api: DesktopApi): { state: AccountsStatusState; reload: () => void } => {
  const [state, setState] = useState<AccountsStatusState>({ kind: "loading" });

  const reload = useCallback(() => {
    setState({ kind: "loading" });
    const read = api.getAccountsStatus;
    if (typeof read !== "function") {
      setState({ kind: "error" });
      return;
    }
    read()
      .then((status) => setState({ kind: "ready", status }))
      .catch(() => setState({ kind: "error" }));
  }, [api]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { state, reload };
};
