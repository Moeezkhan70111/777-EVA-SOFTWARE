import React from "react";

/**
 * One top-level sidebar row with a picture: Dashboard, a page that stands on its own, the rail's
 * own controls. While the rail is slim only the picture shows; data-tip names it (useRailTooltip).
 */
export const RailLink: React.FC<{
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  onClick: () => void;
  className?: string;
  /** For a toggle (the pin): its state, announced as pressed. */
  pressed?: boolean;
  /** The tooltip, when it should say more than the label. */
  tip?: string;
}> = ({ icon, label, active = false, onClick, className, pressed, tip }) => (
  <button
    type="button"
    className={`nav-top-btn${active ? " active" : ""}${className ? ` ${className}` : ""}`}
    aria-current={active ? "page" : undefined}
    aria-pressed={pressed}
    data-tip={tip ?? label}
    onClick={onClick}
  >
    <span className="nav-top-icon" aria-hidden="true">{icon}</span>
    <span className="nav-top-label">{label}</span>
  </button>
);
