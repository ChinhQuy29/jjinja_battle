// Vibes-based prototype scoring. Features are computed in the browser (public/features.js)
// and are untrusted, so everything is clamped. A sprinkle of randomness is intentional.

import { getChallenge, type Measures } from "./challenges.js";

export interface Features {
  duration: number; // seconds of voiced audio span
  peakDb: number; // loudest frame, dBFS
  syllables: number; // energy peaks
  attack: number; // onset sharpness, dB per 10ms
  pitch: number[]; // Hz per frame over the voiced span, 0 = unvoiced
}

export interface Score {
  total: number;
  pronunciation: number;
  tone: number;
  funny: number;
  label: string; // name of the Tone bar for the round's challenge
  comment: string;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const num = (v: unknown, fallback = 0) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const jitter = (amount: number) => (Math.random() * 2 - 1) * amount;
const pick = <T>(arr: T[]) => arr[Math.floor(Math.random() * arr.length)];

export function sanitize(raw: any): Features {
  const pitch = Array.isArray(raw?.pitch) ? raw.pitch.slice(0, 400).map((p: unknown) => clamp(num(p), 0, 2000)) : [];
  return {
    duration: clamp(num(raw?.duration), 0, 10),
    peakDb: clamp(num(raw?.peakDb, -100), -100, 0),
    syllables: clamp(Math.round(num(raw?.syllables)), 0, 20),
    attack: clamp(num(raw?.attack), 0, 60),
    pitch,
  };
}

const semitones = (a: number, b: number) => 12 * Math.log2(b / a);

function median(xs: number[]) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export function measure(f: Features): Measures {
  const voiced = f.pitch.filter((p) => p > 0);
  const n = voiced.length;
  const start = median(voiced.slice(0, Math.max(1, Math.floor(n * 0.4))));
  const end = median(voiced.slice(Math.floor(n * 0.7)));
  return {
    duration: f.duration,
    peakDb: f.peakDb,
    rise: n >= 3 && start > 0 && end > 0 ? semitones(start, end) : 0,
    range: n >= 3 ? semitones(Math.min(...voiced), Math.max(...voiced)) : 0,
    medianHz: median(voiced),
    attackFit: clamp(f.attack / 12, 0, 1),
    loudFit: clamp((f.peakDb + 40) / 35, 0, 1),
    stretchFit: clamp((f.duration - 0.4) / 1.8, 0, 1),
  };
}

export function grade(f: Features, challengeId: unknown = "classic"): Score {
  const challenge = getChallenge(challengeId);
  const voicedCount = f.pitch.filter((p) => p > 0).length;
  const silent = f.duration < 0.2 || f.peakDb < -55 || (!challenge.allowUnvoiced && voicedCount < 3);

  if (silent) {
    return {
      total: Math.round(clamp(5 + jitter(5), 0, 100)),
      pronunciation: Math.round(clamp(5 + jitter(5), 0, 100)),
      tone: Math.round(clamp(5 + jitter(5), 0, 100)),
      funny: Math.round(clamp(10 + jitter(8), 0, 100)),
      label: challenge.label,
      comment: pick([
        "Was that a jjinja or did your mic sneeze?",
        "We heard nothing. Jjinja? Jjinja-ly nothing.",
        "Silence is golden. Your score is not.",
      ]),
    };
  }

  const m = measure(f);

  // Pronunciation: two syllables (jjin-ja), a sharp tense onset (ㅉ), sensible length.
  const sylFit = f.syllables === 2 ? 1 : f.syllables === 1 || f.syllables === 3 ? 0.65 : 0.35;
  const lenFit = f.duration >= 0.4 && f.duration <= 2.8 ? 1 : 0.5;
  const pronunciation = 100 * (0.5 * sylFit + 0.3 * m.attackFit + 0.2 * lenFit) + jitter(10);

  // Tone: whatever this round's challenge asks for.
  const toneFit = clamp(challenge.tone(m), 0, 1);
  const tone = 100 * toneFit + jitter(8);

  // Funny: big pitch swings, a long dramatic stretch, commitment, and chaos.
  const rangeFit = clamp(m.range / 14, 0, 1);
  const commitment = challenge.id === "whisper" ? toneFit : m.loudFit;
  const funny = 100 * (0.4 * rangeFit + 0.3 * m.stretchFit + 0.15 * commitment + 0.15 * Math.random()) + jitter(12);

  const p = Math.round(clamp(pronunciation, 0, 100));
  const t = Math.round(clamp(tone, 0, 100));
  const fu = Math.round(clamp(funny, 0, 100));
  const total = Math.round(clamp(0.35 * p + 0.35 * t + 0.3 * fu, 0, 100));

  return { total, pronunciation: p, tone: t, funny: fu, label: challenge.label, comment: comment(total, p, t, fu, m.rise, challenge) };
}

function comment(total: number, p: number, t: number, fu: number, rise: number, challenge: ReturnType<typeof getChallenge>): string {
  if (total >= 85) return pick(["JJINJA?! That was certified viral.", "Seoul just felt that.", ...challenge.good]);
  if (t >= 70 && Math.random() < 0.6) return pick(challenge.good);
  if (challenge.id === "classic" && rise < 0) {
    return pick(["That went DOWN. Jjinja is a question, not a confession.", "You said it like you already knew. Rise at the end!"]);
  }
  const worst = Math.min(p, t, fu);
  if (worst === t) return pick(challenge.bad);
  if (worst === p) return pick(["That ㅉ was more of a 'ch'. Squeeze it!", "Close, but it sounded like 'chinchilla'."]);
  if (total < 40) return pick(["Your grandma could jjinja better.", "That was a jjin-nah."]);
  return pick(["Solid jjinja. Not legendary, but solid.", "A respectable 'really?'. Now make it unhinged.", "Your friend is sweating."]);
}

export function timeoutScore(challengeId: unknown = "classic"): Score {
  return { total: 0, pronunciation: 0, tone: 0, funny: 0, label: getChallenge(challengeId).label, comment: "Ran out of time. Jjinja?" };
}
