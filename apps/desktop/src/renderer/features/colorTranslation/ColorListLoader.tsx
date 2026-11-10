import React from "react";
import { copy } from "../../config/copy";
import { useColorTranslations } from "./useColorTranslations";

// Keeps the shared colour dictionary current for the whole signed-in session: read once at sign-in and again
// whenever the list changes here or arrives from another computer. Draws nothing. A failed read leaves the last
// good dictionary (or the seeded one) in place; the Color Translation page shows the failure with a Retry.
//
// Keyed by the session in App, so signing in as someone else reads the list again under that person.

export const ColorListLoader: React.FC = () => {
  useColorTranslations(copy.colorTranslation.failed);
  return null;
};
