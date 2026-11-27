import type { NoticeKind } from "../../state/NotificationsContext";

// THE ISLAND'S SOUND (owner, 27 Nov 2026: "add sound effect on it"). A short, soft chime when a new notice opens the
// island, a different one for each kind so the ear knows it before the eye:
//
//   success   two notes rising          warning   the same note twice
//   error     two notes falling, rounder info      one high note
//
// Made by Web Audio from plain tones: no sound file, no package, nothing fetched, so it works offline and in the
// Android/iOS app's web view alike (R7). Where there is no Web Audio (tests, an old web view) it simply stays silent;
// a sound never stops a notice from showing.

interface Note {
  /** Hz. */
  readonly pitch: number;
  /** Seconds after the first note. */
  readonly at: number;
  readonly wave: OscillatorType;
}

const CHIMES: Record<NoticeKind, readonly Note[]> = {
  success: [{ pitch: 659.25, at: 0, wave: "sine" }, { pitch: 987.77, at: 0.09, wave: "sine" }],
  error: [{ pitch: 440, at: 0, wave: "triangle" }, { pitch: 329.63, at: 0.12, wave: "triangle" }],
  warning: [{ pitch: 587.33, at: 0, wave: "sine" }, { pitch: 587.33, at: 0.14, wave: "sine" }],
  info: [{ pitch: 783.99, at: 0, wave: "sine" }],
};

/** Quiet: a cue, not an alarm. */
const PEAK_VOLUME = 0.07;
const ATTACK_S = 0.01;
const RING_S = 0.4;

let context: AudioContext | null = null;

const audio = (): AudioContext | null => {
  if (context) return context;
  const Constructor = typeof window === "undefined" ? undefined : window.AudioContext;
  if (!Constructor) return null;
  context = new Constructor();
  return context;
};

const play = (ctx: AudioContext, note: Note, start: number) => {
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = note.wave;
  oscillator.frequency.value = note.pitch;
  const begin = start + note.at;
  gain.gain.setValueAtTime(0.0001, begin);
  gain.gain.exponentialRampToValueAtTime(PEAK_VOLUME, begin + ATTACK_S);
  gain.gain.exponentialRampToValueAtTime(0.0001, begin + RING_S);
  oscillator.connect(gain).connect(ctx.destination);
  oscillator.start(begin);
  oscillator.stop(begin + RING_S + 0.02);
};

/** The chime for a notice of this kind. Silent, never failing, where sound cannot be made. */
export const playNoticeSound = (kind: NoticeKind): void => {
  try {
    const ctx = audio();
    if (!ctx) return;
    if (ctx.state === "suspended") void ctx.resume();
    for (const note of CHIMES[kind]) play(ctx, note, ctx.currentTime);
  } catch {
    // A sound is a courtesy: a device that cannot play it still shows the notice.
  }
};
