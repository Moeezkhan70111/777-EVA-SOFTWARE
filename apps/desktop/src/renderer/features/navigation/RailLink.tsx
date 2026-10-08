import React from "react";

/** One top-level sidebar row with a picture: Dashboard, a page that stands on its own, Select Job. */
export const RailLink: React.FC<{ icon: React.ReactNode; label: string; active: boolean; onClick: () => void }> = ({
  icon,
  label,
  active,
  onClick,
}) => (
  <button
    type="button"
    className={`nav-top-btn${active ? " active" : ""}`}
    aria-current={active ? "page" : undefined}
    onClick={onClick}
  >
    <span className="nav-top-icon" aria-hidden="true">{icon}</span>
    <span className="nav-top-label">{label}</span>
  </button>
);
