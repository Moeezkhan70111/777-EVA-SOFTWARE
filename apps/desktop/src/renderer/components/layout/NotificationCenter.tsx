import React, { useEffect, useRef, useState } from "react";
import { copy } from "../../config/copy";
import { useNotifications, type NoticeItem } from "../../state/NotificationsContext";
import { NoticeIsland } from "./NoticeIsland";
import { playNoticeSound } from "./noticeSound";

// NOTICES AS AN ISLAND (owner, 27 Nov 2026: the Dynamic Island idea, made clean, drawn by our own NoticeIsland).
// NotificationsContext stays the one way the app raises a notice; the island shows the NEWEST open one and says how
// many wait behind it. A new notice takes the island; when the shown one goes, the next comes back. A notice that
// waits for an answer never holds back the ones after it.
//
// When the last notice goes, it stays on the island a moment longer so the island can close back into itself
// instead of vanishing (27 Nov 2026, "make the transition smooth").
//
// A new notice opens with its chime (noticeSound.ts, 27 Nov 2026): once per notice, when it first takes the island;
// not when a keyed notice is re-pushed with new words, and not when one waiting behind comes back.

/** Every notice closes by itself after this long, whatever it says (owner, 26 Nov 2026). */
export const NOTICE_SHOWN_MS = 4000;
/** How long the island takes to shrink back into its pill and fade (theme.css, .island.is-closing). */
export const ISLAND_CLOSING_MS = 560;

export const NotificationCenter: React.FC = () => {
  const { notices, dismiss } = useNotifications();
  const newest = notices[0];
  const [last, setLast] = useState<NoticeItem | null>(null);
  const heard = useRef(new Set<string>());

  useEffect(() => {
    if (!newest || heard.current.has(newest.id)) return;
    heard.current.add(newest.id);
    playNoticeSound(newest.kind);
  }, [newest]);

  useEffect(() => {
    if (newest) {
      setLast(newest);
      return undefined;
    }
    const timer = window.setTimeout(() => setLast(null), ISLAND_CLOSING_MS);
    return () => window.clearTimeout(timer);
  }, [newest]);

  const shown = newest ?? last;
  return (
    <section className="island-dock" aria-label={copy.notices.regionLabel} aria-live="polite">
      {shown ? (
        <NoticeIsland notice={shown} ms={NOTICE_SHOWN_MS} waiting={Math.max(0, notices.length - 1)} closing={!newest} onClose={dismiss} />
      ) : null}
    </section>
  );
};
