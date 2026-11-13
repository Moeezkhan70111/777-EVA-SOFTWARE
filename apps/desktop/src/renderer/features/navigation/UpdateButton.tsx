import React from "react";
import { useUpdateNow } from "../../hooks/useUpdateNow";
import { RAIL_ICONS } from "./NavIcons";
import { RailLink } from "./RailLink";
import { updateButtonView, type UpdateBadge } from "./updateButtonView";

// "Update" in the rail, under the sync indicator: check GitHub now, and if a newer version is there, download it and
// restart into it (hooks/useUpdateNow.ts). It also shows the automatic update as it happens: "Update available",
// "Downloading 45%", "Restart to update", "Download failed — Retry" (updateButtonView.ts). The label says what it is
// doing, in words, so nobody presses it twice; on the slim rail a small mark on the icon says the same.

const BADGE_CLASS: Record<UpdateBadge, string> = {
  PROGRESS: "nav-update-badge is-progress",
  READY: "nav-update-badge is-ready",
  FAILED: "nav-update-badge is-failed",
};

export const UpdateButton: React.FC = () => {
  const { press, status, run, available } = useUpdateNow();
  if (!available) return null;
  const view = updateButtonView(press, status);
  const badge = view.badge === null ? undefined : <span className={BADGE_CLASS[view.badge]}>{view.badgeText}</span>;
  return (
    <RailLink
      icon={RAIL_ICONS.update}
      label={view.label}
      tip={view.tip}
      className={`nav-update${view.badge === "READY" ? " is-ready" : ""}`}
      badge={badge}
      onClick={run}
    />
  );
};
