import { useCallback, useEffect, useState } from "react";
import { toIsoDate } from "../utils/dates";

// A date filter that MEANS "today" until somebody picks another day (owner, 24 Nov 2026: "I have to refresh to see
// changes in the customer ledger"). The accounts computer is left open overnight: a "to" or "as of" date set once, when
// the page opened, stayed on yesterday, so every voucher dated today was outside it — however many syncs arrived —
// until a refresh set it again.
//
// So the date follows the business day (Asia/Karachi, toIsoDate): it is checked every minute and whenever the window
// comes back into view, and moves on at midnight. Once the operator picks another day it stays on that day; picking
// today again follows the calendar again.

const CHECK_EVERY_MS = 60_000;

export const useTodayFollowingDate = (): readonly [string, (date: string) => void] => {
  const [today, setToday] = useState(() => toIsoDate());
  const [chosen, setChosen] = useState<string | null>(null);

  useEffect(() => {
    const check = () => setToday((current) => {
      const now = toIsoDate();
      return now === current ? current : now;
    });
    const timer = window.setInterval(check, CHECK_EVERY_MS);
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, []);

  const choose = useCallback((date: string) => setChosen(date === toIsoDate() ? null : date), []);
  return [chosen ?? today, choose] as const;
};
