import React from "react";
import { copy } from "../../config/copy";
import { useUpdateNow, type UpdateNowState } from "../../hooks/useUpdateNow";
import { RAIL_ICONS } from "./NavIcons";
import { RailLink } from "./RailLink";

// "Update" in the rail, under the sync indicator: check GitHub now, and if a newer version is there, download it and
// restart into it (hooks/useUpdateNow.ts). The label says what it is doing, in words, so nobody presses it twice.

const labelFor = (state: UpdateNowState): string => {
  switch (state.kind) {
    case "CHECKING": return copy.nav.rail.updateChecking;
    case "DOWNLOADING": return state.percent === null ? copy.nav.rail.updateDownloading : copy.nav.rail.updatePercent(Math.round(state.percent));
    case "INSTALLING": return copy.nav.rail.updateInstalling;
    default: return copy.nav.rail.update;
  }
};

export const UpdateButton: React.FC = () => {
  const { state, run, available } = useUpdateNow();
  if (!available) return null;
  return (
    <RailLink icon={RAIL_ICONS.update} label={labelFor(state)} tip={copy.nav.rail.updateHint} className="nav-update" onClick={run} />
  );
};
