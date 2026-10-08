import React from "react";
import { copy } from "../../config/copy";
import { StoreTopBar } from "../store/StoreTopBar";

// Create Gatepass and the Gatepass List were built to sit under the navbar, and a Munshi has
// no navbar. This frame gives them what the navbar used to: the logo, the page's name, and a
// way back to the station. The pages themselves are untouched and keep working unchanged for
// everyone who does have a navbar.

interface MunshiFrameProps {
  /** The page's name, from PAGE_TITLES, so one place names every screen. */
  title: string;
  onHome: () => void;
  children: React.ReactNode;
}

export const MunshiFrame: React.FC<MunshiFrameProps> = ({ title, onHome, children }) => (
  <div className="so-page so-page--wide so-screen so-screen--in">
    <StoreTopBar title={title} subtitle={copy.munshi.role} back={{ label: copy.munshi.home, onClick: onHome }} />
    <main className="so-wide-body">{children}</main>
  </div>
);
