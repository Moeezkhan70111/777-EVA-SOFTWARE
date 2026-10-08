import React, { useCallback, useEffect, useRef } from "react";
import type { AppRoute } from "../../app/routes";
import { copy } from "../../config/copy";
import { STORE_OPERATORS, type StoreOperator } from "./storeOperators";
import { StoreOperatorCard } from "./StoreOperatorCard";
import { StoreTopBar } from "./StoreTopBar";

// Store Station — the store operator's front door. One question, two big answers:
//
//   open the app → "What is your job today?" → Move In  or  Move Out
//
// Nothing happens to stock here; the page only sends the operator to their side of the store.

interface StoreHomePageProps {
  onNavigate: (route: AppRoute) => void;
}

/** True while the operator is typing somewhere, so a scanner burst can never pick a job. */
const isTyping = (target: EventTarget | null): boolean =>
  target instanceof HTMLInputElement ||
  target instanceof HTMLTextAreaElement ||
  target instanceof HTMLSelectElement ||
  (target instanceof HTMLElement && target.isContentEditable);

export const StoreHomePage: React.FC<StoreHomePageProps> = ({ onNavigate }) => {
  const cardRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const choose = useCallback((operator: StoreOperator) => onNavigate(operator.route), [onNavigate]);

  // Move In is focused on arrival, so Enter alone opens the usual job.
  useEffect(() => {
    // preventScroll: on a short window, focusing must not scroll the heading away.
    cardRefs.current[0]?.focus({ preventScroll: true });
  }, []);

  // 1 / 2 pick a card outright; ← → move between them; Enter opens the focused one.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) return;
      const byKey = STORE_OPERATORS.find((operator) => operator.key === event.key);
      if (byKey) {
        event.preventDefault();
        choose(byKey);
        return;
      }
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
      event.preventDefault();
      const focused = cardRefs.current.findIndex((card) => card === document.activeElement);
      const step = event.key === "ArrowRight" ? 1 : -1;
      const count = STORE_OPERATORS.length;
      cardRefs.current[focused === -1 ? 0 : (focused + step + count) % count]?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [choose]);

  return (
    <div className="so-page">
      {/* Who is signed in is already shown at the foot of the sidebar. */}
      <StoreTopBar />

      <main className="so-stage">
        <div className="so-hero">
          <h1 className="so-hero-title">{copy.store.title}</h1>
          <h2 className="so-question">{copy.store.question}</h2>
        </div>

        <div className="so-cards" role="group" aria-label={copy.store.question}>
          {STORE_OPERATORS.map((operator, index) => (
            <StoreOperatorCard
              key={operator.direction}
              operator={operator}
              onSelect={choose}
              buttonRef={(element) => {
                cardRefs.current[index] = element;
              }}
            />
          ))}
        </div>

        <p className="so-hint">{copy.store.keyHint}</p>
      </main>
    </div>
  );
};
