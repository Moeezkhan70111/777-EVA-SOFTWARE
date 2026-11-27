import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { copy } from "../../config/copy";
import type { NoticeItem } from "../../state/NotificationsContext";

// THE NOTICE ISLAND, OUR OWN (owner, 27 Nov 2026: "keep the idea of the Dynamic Island but make it more clean and good
// looking"; then "make the transition smooth"). One deep-navy pill at the top centre: the kind as a mark and a word
// (never colour alone, R18), the title, the message, its one next step as a white pill ("Make Bill") and ×, ringed by
// the time left. Drawn here with CSS only: no package.
//
// SMOOTH (27 Nov 2026): it appears as a small resting pill and GROWS into the notice, width and height together,
// the words fading in as it opens; on closing the words fade, it SHRINKS back into the pill, then fades away
// (NotificationCenter keeps the last notice for that). While notices follow one another it stays open and its size
// glides to fit each one, the words cross-fading, so nothing snaps.
//
// It closes a notice by itself after four seconds (owner, 26 Nov 2026). Pointing at it or tabbing into it holds the
// time, so a notice being read or acted on never vanishes under the hand.

const words = copy.notices;

const MARKS: Record<NoticeItem["kind"], string> = { success: "✓", error: "✕", warning: "!", info: "i" };
/** The resting pill the island grows out of and shrinks back into, as the iPhone’s does (theme.css, .island). */
const RESTING = { width: 128, height: 36 } as const;

/** Four seconds that stop while held, and carry on from where they stopped. */
const useHeldTimer = (ms: number, onDone: () => void) => {
  const remaining = useRef(ms);
  const startedAt = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const done = useRef(onDone);
  done.current = onDone;
  const [held, setHeld] = useState(false);

  const run = useCallback(() => {
    startedAt.current = Date.now();
    timer.current = window.setTimeout(() => done.current(), remaining.current);
  }, []);
  useEffect(() => { run(); return () => window.clearTimeout(timer.current); }, [run]);

  const hold = () => {
    if (held) return;
    window.clearTimeout(timer.current);
    remaining.current -= Date.now() - startedAt.current;
    setHeld(true);
  };
  const release = () => {
    if (!held) return;
    setHeld(false);
    run();
  };
  return { held, hold, release };
};

/** The size the words need, so the island can glide to it. Null until measured (jsdom never measures). */
const useNaturalSize = () => {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const measure = () => setSize({ width: element.offsetWidth, height: element.offsetHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, size };
};

interface ContentProps {
  notice: NoticeItem;
  ms: number;
  waiting: number;
  onClose: () => void;
}

/** One notice's words and buttons, with its own four seconds. A new notice is a new one of these, fading in. */
const IslandContent: React.FC<ContentProps> = ({ notice, ms, waiting, onClose }) => {
  const timer = useHeldTimer(ms, onClose);
  const { action } = notice;
  return (
    <div className={timer.held ? "island-content is-held" : "island-content"} style={{ "--island-ms": `${ms}ms` } as React.CSSProperties}
      role={notice.kind === "error" ? "alert" : undefined}
      onMouseEnter={timer.hold} onMouseLeave={timer.release} onFocus={timer.hold} onBlur={timer.release}>
      <span className="island-mark" aria-hidden="true">{MARKS[notice.kind]}</span>
      <div className="island-body">
        <p className="island-title"><span className="island-kind">{words.kinds[notice.kind]}</span>{notice.title}</p>
        {notice.message ? <p className="island-message">{notice.message}</p> : null}
      </div>
      {waiting > 0 ? <span className="island-more">{words.waiting(waiting)}</span> : null}
      {action ? (
        <button type="button" className="island-action" onClick={() => { action.onClick(); onClose(); }}>{action.label}</button>
      ) : null}
      <button type="button" className="island-close" aria-label={words.close(notice.title)} onClick={onClose}>
        <svg className="island-ring" viewBox="0 0 36 36" aria-hidden="true"><circle cx="18" cy="18" r="16" pathLength="100" /></svg>
        <span aria-hidden="true">×</span>
      </button>
    </div>
  );
};

interface NoticeIslandProps {
  notice: NoticeItem;
  /** How long a notice stays when nobody holds it. */
  ms: number;
  /** Open notices waiting behind this one. */
  waiting: number;
  /** The last notice has gone: the island closes back into itself. */
  closing: boolean;
  onClose: (id: string) => void;
}

/** Open one frame after it appears, so it grows out of the resting pill; shut again while it closes. */
const useOpened = (closing: boolean): boolean => {
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    if (closing) {
      setOpened(false);
      return undefined;
    }
    let inner = 0;
    const outer = requestAnimationFrame(() => { inner = requestAnimationFrame(() => setOpened(true)); });
    return () => { cancelAnimationFrame(outer); cancelAnimationFrame(inner); };
  }, [closing]);
  return opened;
};

export const NoticeIsland: React.FC<NoticeIslandProps> = ({ notice, ms, waiting, closing, onClose }) => {
  const natural = useNaturalSize();
  const opened = useOpened(closing);
  const size = opened && natural.size ? natural.size : RESTING;
  const classes = ["island", opened ? "is-open" : "", closing ? "is-closing" : ""].filter(Boolean).join(" ");
  return (
    <div className={classes} data-kind={notice.kind} style={{ width: size.width, height: size.height }} aria-hidden={closing || undefined}>
      <div ref={natural.ref} className="island-measure">
        <IslandContent key={notice.id} notice={notice} ms={ms} waiting={waiting} onClose={() => onClose(notice.id)} />
      </div>
    </div>
  );
};
