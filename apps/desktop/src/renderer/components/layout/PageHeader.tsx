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

interface PageHeaderProps {
  title: string;
  /** The right-hand side: the bell and the profile (HeaderActions), and anything a page adds. */
  actions?: React.ReactNode;
}

export const PageHeader: React.FC<PageHeaderProps> = ({ title, actions }) => (
  <header className="page-head">
    <img className="page-head-logo" src={BRAND_LOGO_URL} alt={copy.app.brandLine} />
    <h1 className="page-head-title">{title}</h1>
    <div className="page-head-actions">{actions}</div>
  </header>
);
