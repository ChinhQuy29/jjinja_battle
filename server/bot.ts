// Jjinja Bot: a stand-in opponent for when nobody else is in the random queue.
// It produces believable voice features, so the normal grader scores it.

import type { Features } from "./scoring.js";
import type { Axis } from "./rally.js";

const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const contour = (from: number, to: number, n = 50) => Array.from({ length: n }, (_, i) => Math.round(from * Math.pow(to / from, i / (n - 1))));

export const BOT_NAME = "Jjinja Bot";

// "Thinking" time before the bot answers, so its turn feels human.
export function botDelayMs() {
  return rand(2200, 3800);
}

export function botFeatures(): Features {
  const start = rand(150, 260);
  const rise = rand(-3, 11); // semitones; usually rises like the meme, sometimes flops
  const duration = rand(0.6, 2.4);
  return {
    duration,
    peakDb: rand(-25, -6),
    syllables: Math.random() < 0.75 ? 2 : Math.random() < 0.5 ? 1 : 3,
    attack: rand(4, 18),
    pitch: contour(start, start * Math.pow(2, rise / 12), Math.round(duration * 40)),
  };
}

// In a rally the bot's stamina fades the longer the rally goes.
export function botRallyFeatures(axis: Axis, target: number | null, exchanges: number): Features {
  const succeed = target == null || Math.random() < 0.85 - 0.08 * exchanges;
  let hz = 200;
  let duration = rand(0.8, 1.5);

  if (axis.id === "longer") {
    if (target != null) duration = Math.min(7.9, succeed ? target + rand(0.15, 0.6) : target - rand(0, 0.3));
  } else if (axis.id === "higher") {
    hz = target == null ? rand(220, 340) : target * Math.pow(2, (succeed ? rand(0.7, 2.5) : -rand(0, 1)) / 12);
  } else {
    hz = target == null ? rand(140, 200) : target / Math.pow(2, (succeed ? rand(0.7, 2.5) : -rand(0, 1)) / 12);
  }

  return {
    duration: Math.max(0.3, duration),
    peakDb: rand(-20, -8),
    syllables: 2,
    attack: rand(6, 14),
    pitch: Array(Math.round(Math.max(0.3, duration) * 40)).fill(Math.round(hz)),
  };
}
