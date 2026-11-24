import { flushSync } from "react-dom";

/** The element the transition starts from, and the name it shares with where it lands. */
export interface SharedElement {
  readonly element: HTMLElement | null;
  readonly name: string;
}

/**
 * Runs a screen change as a View Transition, so a shared element moves from where it was to where it lands: on Enter
 * Orders the article picker becomes the new article's band (owner, 24 Nov 2026).
 *
 * The source carries the shared name ONLY for the moment of the transition: a `view-transition-name` makes its own
 * stacking layer, and left on the picker it kept the picker's list under the article bands (owner, 24 Nov 2026). The
 * landing element carries the same name in CSS while it exists (.ord-vt-article).
 *
 * The update is flushed at once (flushSync), so the browser captures the new screen right after it. Where the API is
 * missing (tests, an older engine) or the operator asked for less motion, the update simply runs: nothing about the
 * order depends on the animation.
 */
export const withViewTransition = (update: () => void, from?: SharedElement): void => {
  const reduceMotion = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduceMotion || typeof document.startViewTransition !== "function") {
    update();
    return;
  }
  const source = from?.element ?? null;
  if (source && from) source.style.viewTransitionName = from.name;
  document.startViewTransition(() => {
    if (source) source.style.viewTransitionName = "";
    flushSync(update);
  });
};
