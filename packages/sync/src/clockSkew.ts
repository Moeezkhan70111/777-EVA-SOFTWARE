// HOW FAR THIS COMPUTER'S CLOCK IS FROM THE CLOUD'S.
//
// PC2's clock once ran 22 hours out, in October, and nothing said so. A wrong time zone warns by
// name, but a machine can be on the right zone with the wrong time. Every reply from the cloud
// carries the time in its Date header, so the check costs nothing extra: it is read off the replies
// a sync pass was getting anyway. No reply, no reading, so a computer working offline says nothing.
//
// A reply takes a moment and the header is in whole seconds, so a reading is good to a few seconds.
// The limit is far above that and far below a clock anyone should trust.

export const CLOCK_SKEW_LIMIT_MS = 5 * 60_000;

const MS_PER_MINUTE = 60_000;

export const CLOCK_DIRECTION = { AHEAD: "AHEAD", BEHIND: "BEHIND" } as const;
export type ClockDirection = (typeof CLOCK_DIRECTION)[keyof typeof CLOCK_DIRECTION];

export interface ClockSkew {
  readonly direction: ClockDirection;
  readonly minutes: number;
}

/** This computer's clock minus the server's, or null when the header says no usable time. */
export function measureClockSkew(serverDate: string | null, localMs: number): number | null {
  if (serverDate === null) return null;
  const serverMs = Date.parse(serverDate);
  return Number.isNaN(serverMs) ? null : localMs - serverMs;
}

/** The skew when it is past the limit, in the words a warning needs. Null when there is nothing to say. */
export function clockSkewOverLimit(skewMs: number | null): ClockSkew | null {
  if (skewMs === null || Math.abs(skewMs) < CLOCK_SKEW_LIMIT_MS) return null;
  return {
    direction: skewMs > 0 ? CLOCK_DIRECTION.AHEAD : CLOCK_DIRECTION.BEHIND,
    minutes: Math.round(Math.abs(skewMs) / MS_PER_MINUTE),
  };
}
