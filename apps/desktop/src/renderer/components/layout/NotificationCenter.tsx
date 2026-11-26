import React, { useEffect, useRef } from "react";
import { Toaster, dynaura, type CustomTheme, type DismissReason, type ToastOptions } from "dynaura";
import { useNotifications, type NoticeItem } from "../../state/NotificationsContext";

// NOTICES AS A DYNAMIC ISLAND (owner, 26 Nov 2026): the dynaura package (pinned 0.2.2, reviewed before it was added:
// no network, no eval, text only ever written as text) draws a notice as a black pill at the top centre that springs
// open into the message and back. NotificationsContext stays the one way the app raises a notice, and keeps every
// notice that is open; this hands the island the NEWEST of them:
//
//   a new notice     → it takes the island (the one it replaces stays open in the context)
//   a notice updated → updated in place (a keyed notice re-pushed by a poll)
//   the shown one goes (its timer, or a tap, swipe, Escape or Dismiss) → the next open notice comes back
//
// The island holds one notice at a time, so it shows the newest rather than queueing: a notice that waits for an
// answer must never hold back the ones after it: it returns once they are gone, then closes in its own four seconds.
// Every island closes by itself after four seconds (owner, 26 Nov 2026), and with it the notice; a tap, swipe, Escape or
// Dismiss closes it sooner.

/** Every island closes by itself after this long, whatever it says (owner, 26 Nov 2026). A thin bar shows the time left. */
export const NOTICE_ISLAND_MS = 4000;

/** The island in our theme: every colour is one of the island tokens in theme.css (R3), nothing set here. */
const THEME: CustomTheme = {
  background: "var(--island-bg)",
  foreground: "var(--island-fg)",
  muted: "var(--island-muted)",
  ring: "var(--island-ring)",
  button: "var(--island-button)",
  success: "var(--island-success)",
  error: "var(--island-error)",
  warning: "var(--island-warning)",
  info: "var(--island-info)",
  loading: "var(--island-loading)",
};

const optionsOf = (notice: NoticeItem, onHandDismiss: (id: string) => void): ToastOptions => ({
  id: notice.id,
  title: notice.title,
  description: notice.message,
  // Four seconds, then it closes and leaves the list (a timeout counts as closed, like a tap).
  duration: NOTICE_ISLAND_MS,
  button: notice.action ? { title: notice.action.label, onClick: notice.action.onClick } : undefined,
  // One button only, like the iPhone's: the next step that fits. Closing is a tap, a swipe up or Escape.
  onClick: notice.action ? undefined : () => dynaura.dismiss(notice.id, "button"),
  // "api" is ours: replaced by a newer notice, or taken down because the context closed it. Anything else was a hand.
  onDismiss: (reason: DismissReason) => { if (reason !== "api") onHandDismiss(notice.id); },
});

/** What a notice says: a re-pushed keyed notice with the same words is not shown again. */
const signatureOf = (notice: NoticeItem): string => JSON.stringify([notice.id, notice.kind, notice.title, notice.message ?? "", notice.action?.label ?? ""]);

export const NotificationCenter: React.FC = () => {
  const { notices, dismiss } = useNotifications();
  const shown = useRef<{ id: string; signature: string } | null>(null);
  const newest = notices[0] ?? null;

  // dynaura keeps its notice in one store for the whole window, beyond this component: start and end with it empty, so a
  // notice from before (another account, an earlier mount) can never reappear on a fresh island.
  useEffect(() => {
    dynaura.clear();
    return () => { dynaura.clear(); shown.current = null; };
  }, []);

  useEffect(() => {
    if (newest === null) {
      if (shown.current) dynaura.dismiss(shown.current.id, "api");
      shown.current = null;
      return;
    }
    const signature = signatureOf(newest);
    if (shown.current?.signature === signature) return;
    const sameNotice = shown.current?.id === newest.id;
    shown.current = { id: newest.id, signature };
    if (sameNotice) dynaura.update(newest.id, { ...optionsOf(newest, dismiss), type: newest.kind });
    else dynaura[newest.kind](optionsOf(newest, dismiss));
  }, [newest, dismiss]);

  return <Toaster position="top-center" theme={THEME} haptics={false} swipe="up" />;
};
