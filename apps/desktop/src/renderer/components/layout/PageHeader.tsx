import React from "react";
import { BRAND_LOGO_URL } from "../../config/branding";
import { copy } from "../../config/copy";

// THE PAGE HEADER — the Store page's header (0.4.1), drawn once for every screen:
//
//   [777 SEVEN]                    STORE                     [bell] [avatar]
//
// Three columns, the outer two equal, so the title stays centred on the page area whatever sits
// beside it. The Store page draws it at the top of its own sky; every other screen gets it from
// the app shell, over the shell's ground.
//
// ONE LOGO ON SCREEN. The logo here shows while the sidebar is slim and fades out as the sidebar
// opens, where the sidebar's own logo fades in (theme.css, .page-head-logo). It keeps its column,
// so the title never moves.

//
// THE WAY BACK (owner, 14 Nov 2026): every page but the Dashboard has a "Back to Dashboard" button beside the logo,
// set apart from it by a thin rule, so the Dashboard is one press away wherever the sidebar is (or is not). It stays
// when the logo steps aside. A left arrow, not a Dashboard picture, so it reads as "go back" at a glance; narrow
// screens show the arrow alone and the button keeps its name (owner, 23 Nov 2026).

interface PageHeaderProps {
  title: string;
  /** The right-hand side: the bell and the profile (HeaderActions), and anything a page adds. */
  actions?: React.ReactNode;
  /** Goes back to the Dashboard. Absent on the Dashboard itself. */
  onDashboard?: () => void;
}

const BackArrowIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M19 12H5M11 6l-6 6 6 6" />
  </svg>
);

export const PageHeader: React.FC<PageHeaderProps> = ({ title, actions, onDashboard }) => (
  <header className="page-head">
    <div className="page-head-start">
      <img className="page-head-logo" src={BRAND_LOGO_URL} alt={copy.app.brandLine} />
      {onDashboard ? (
        <button type="button" className="page-head-home" aria-label={copy.nav.backToDashboard.label} onClick={onDashboard}>
          <span className="page-head-home-icon"><BackArrowIcon /></span>
          <span className="page-head-home-text" aria-hidden="true">
            <span className="page-head-home-lead">{copy.nav.backToDashboard.lead}</span>
            <span className="page-head-home-target">{copy.nav.backToDashboard.target}</span>
          </span>
        </button>
      ) : null}
    </div>
    <div className="page-head-mid">
      <h1 className="page-head-title">{title}</h1>
    </div>
    <div className="page-head-actions">{actions}</div>
  </header>
);
