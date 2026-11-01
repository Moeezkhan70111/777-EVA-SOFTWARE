import React, { useEffect, useState } from "react";
import { copy } from "../../config/copy";
import { useDesktopApi } from "../../hooks/useDesktopApi";
import { useNotifications } from "../../state/NotificationsContext";
import { useSession } from "./SessionContext";

// After the switch to cloud accounts the cloud has no roles, and an admin cannot approve anyone with
// a role it does not know. This offers, once, to copy this computer's roles up (docs/41 section 6).
// It shows only while there is something to copy: under cloud accounts, before the cloud has roles.

export const CloudRoleCopyCard = () => {
  const api = useDesktopApi();
  const { token, isAdmin } = useSession();
  const { push } = useNotifications();
  const [count, setCount] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isAdmin || token === null || typeof api.getRoleCopyOffer !== "function") return;
    let live = true;
    api
      .getRoleCopyOffer(token)
      .then((offer) => {
        if (live && offer.accepted) setCount(offer.count);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [api, isAdmin, token]);

  if (!isAdmin || token === null || count === 0) return null;

  const copyUp = async () => {
    setBusy(true);
    try {
      const result = await api.copyRolesToCloud?.(token);
      if (result?.accepted) {
        setCount(0);
        push("success", copy.cloudAccounts.roleCopiedTitle, copy.cloudAccounts.roleCopiedBody);
      } else {
        push("error", copy.cloudAccounts.roleCopyFailed, result?.reason ?? copy.cloudAccounts.statusFailed);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card cloud-accounts-card" aria-labelledby="cloud-role-copy-title">
      <h2 className="card-title" id="cloud-role-copy-title">
        {copy.cloudAccounts.roleCopyTitle}
      </h2>
      <p>{copy.cloudAccounts.roleCopyBody(count)}</p>
      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void copyUp()}>
        {busy ? copy.cloudAccounts.roleCopying : copy.cloudAccounts.roleCopyButton(count)}
      </button>
    </section>
  );
};
