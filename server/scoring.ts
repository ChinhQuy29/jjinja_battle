// Vibes-based prototype scoring. Features are computed in the browser (public/features.js)
// and are untrusted, so everything is clamped. A sprinkle of randomness is intentional.

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

export function grade(f: Features): Score {
  const voiced = f.pitch.filter((p) => p > 0);

  if (f.duration < 0.2 || f.peakDb < -50 || voiced.length < 3) {
    return {
      total: Math.round(clamp(5 + jitter(5), 0, 100)),
      pronunciation: Math.round(clamp(5 + jitter(5), 0, 100)),
      tone: Math.round(clamp(5 + jitter(5), 0, 100)),
      funny: Math.round(clamp(10 + jitter(8), 0, 100)),
      comment: pick([
        "Was that a jjinja or did your mic sneeze?",
        "We heard nothing. Jjinja? Jjinja-ly nothing.",
        "Silence is golden. Your score is not.",
      ]),
    };
  }

  // Pronunciation: two syllables (jjin-ja), a sharp tense onset (ㅉ), sensible length.
  const sylFit = f.syllables === 2 ? 1 : f.syllables === 1 || f.syllables === 3 ? 0.65 : 0.35;
  const attackFit = clamp(f.attack / 12, 0, 1);
  const lenFit = f.duration >= 0.4 && f.duration <= 2.8 ? 1 : 0.5;
  const pronunciation = 100 * (0.5 * sylFit + 0.3 * attackFit + 0.2 * lenFit) + jitter(10);

  // Tone: the meme lives on the rising "jjin-JAAA?" question ending.
  const n = voiced.length;
  const start = median(voiced.slice(0, Math.max(1, Math.floor(n * 0.4))));
  const end = median(voiced.slice(Math.floor(n * 0.7)));
  const rise = start > 0 && end > 0 ? semitones(start, end) : 0;
  const riseFit = rise <= 0 ? clamp(0.25 + rise / 20, 0, 0.25) : clamp(0.25 + rise / 8, 0, 1);
  const tone = 100 * riseFit + jitter(8);

  // Funny: big pitch swings, a long dramatic stretch, commitment (volume), and chaos.
  const lo = Math.min(...voiced);
  const hi = Math.max(...voiced);
  const range = semitones(lo, hi);
  const rangeFit = clamp(range / 14, 0, 1);
  const stretchFit = clamp((f.duration - 0.4) / 1.8, 0, 1);
  const loudFit = clamp((f.peakDb + 40) / 35, 0, 1);
  const funny = 100 * (0.4 * rangeFit + 0.3 * stretchFit + 0.15 * loudFit + 0.15 * Math.random()) + jitter(12);

  const p = Math.round(clamp(pronunciation, 0, 100));
  const t = Math.round(clamp(tone, 0, 100));
  const fu = Math.round(clamp(funny, 0, 100));
  const total = Math.round(clamp(0.35 * p + 0.35 * t + 0.3 * fu, 0, 100));

  return { total, pronunciation: p, tone: t, funny: fu, comment: comment(total, p, t, fu, rise) };
}

function comment(total: number, p: number, t: number, fu: number, rise: number): string {
  if (total >= 85) return pick(["JJINJA?! That was certified viral.", "Seoul just felt that.", "The algorithm is already pushing this one."]);
  if (rise < 0) return pick(["That went DOWN. Jjinja is a question, not a confession.", "You said it like you already knew. Rise at the end!"]);
  const worst = Math.min(p, t, fu);
  if (worst === t) return pick(["Needs more 'JAAA?' at the end.", "Flat like a Seoul subway map. More drama!"]);
  if (worst === p) return pick(["That ㅉ was more of a 'ch'. Squeeze it!", "Close, but it sounded like 'chinchilla'."]);
  if (total < 40) return pick(["Your grandma could jjinja better.", "That was a jjin-nah."]);
  return pick(["Solid jjinja. Not legendary, but solid.", "A respectable 'really?'. Now make it unhinged.", "Your friend is sweating."]);
}

export function timeoutScore(): Score {
  return { total: 0, pronunciation: 0, tone: 0, funny: 0, comment: "Ran out of time. Jjinja?" };
}
