// Rally mode: players alternate quick jjinjas and each one must beat the last on one axis.
// The first player who can't escalate loses the rally.

import type { Features } from "./scoring.js";

export interface Axis {
  id: "higher" | "lower" | "longer";
  emoji: string;
  title: string;
  verb: string; // announcer word on success
  unit: string;
  measure: (f: Features) => number | null; // null = no usable value
  beats: (value: number, target: number) => boolean;
  format: (value: number) => string;
}

export interface RallyResult {
  rally: true;
  ok: boolean;
  value: number | null;
  display: string; // e.g. "312 Hz"
  comment: string;
  say: string; // announcer line
}

const HALF_SEMITONE = Math.pow(2, 0.5 / 12);
const pick = <T>(arr: T[]) => arr[Math.floor(Math.random() * arr.length)];

function percentile(xs: number[], p: number) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))];
}

const voiced = (f: Features) => f.pitch.filter((p) => p > 0);

export const AXES: Axis[] = [
  {
    id: "higher",
    emoji: "⬆️",
    title: "Rally: go HIGHER",
    verb: "Higher!",
    unit: "Hz",
    // 90th percentile ignores one-frame pitch glitches
    measure: (f) => (voiced(f).length >= 3 ? percentile(voiced(f), 0.9) : null),
    beats: (v, t) => v >= t * HALF_SEMITONE,
    format: (v) => `${Math.round(v)} Hz`,
  },
  {
    id: "lower",
    emoji: "⬇️",
    title: "Rally: go LOWER",
    verb: "Lower!",
    unit: "Hz",
    measure: (f) => (voiced(f).length >= 3 ? percentile(voiced(f), 0.1) : null),
    beats: (v, t) => v <= t / HALF_SEMITONE,
    format: (v) => `${Math.round(v)} Hz`,
  },
  {
    id: "longer",
    emoji: "➡️",
    title: "Rally: go LONGER",
    verb: "Longer!",
    unit: "s",
    measure: (f) => (voiced(f).length >= 3 ? f.duration : null),
    beats: (v, t) => v >= t + 0.1,
    format: (v) => `${v.toFixed(2)} s`,
  },
];

export function pickAxis(): Axis {
  return pick(AXES);
}

export function hintFor(axis: Axis, target: number | null) {
  if (target == null) {
    return axis.id === "longer"
      ? "First jjinja sets the bar (up to 8s). Don't use it all at once!"
      : "First jjinja sets the bar. Then each one must beat the last!";
  }
  const word = axis.id === "higher" ? "higher than" : axis.id === "lower" ? "lower than" : "longer than";
  return `Next jjinja must go ${word} ${axis.format(target)}`;
}

export function playRally(axis: Axis, target: number | null, f: Features | null): RallyResult {
  const silent = !f || f.duration < 0.2 || f.peakDb < -55;
  const value = silent ? null : axis.measure(f!);
  if (value == null) {
    return {
      rally: true,
      ok: false,
      value: null,
      display: f ? "No jjinja" : "Too slow",
      comment: f ? "We couldn't hear a jjinja. That's a fail!" : "Out of time. Rally lost!",
      say: f ? "Failed!" : "Too slow!",
    };
  }
  const ok = target == null || axis.beats(value, target);
  return {
    rally: true,
    ok,
    value,
    display: axis.format(value),
    comment: ok
      ? target == null
        ? "The bar is set. Beat it!"
        : pick(["Escalation!", "It keeps going!", "Can they top that?", "The tension!"])
      : `Needed to beat ${axis.format(target!)}. Rally lost!`,
    say: ok ? (target == null ? "Beat that!" : axis.verb) : "Failed!",
  };
}
