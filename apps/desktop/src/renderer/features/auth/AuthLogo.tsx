import { BRAND_LOGO_URL } from "../../config/branding";
import React from "react";
import { copy } from "../../config/copy";

export const AuthLogo = () => (
  <img src={BRAND_LOGO_URL} alt={copy.app.brandLine} className="auth-logo-img" />
);
