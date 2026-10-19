// Round challenges: each one changes what "Tone" rewards and adds its own roasts.

export interface Measures {
  duration: number; // seconds
  peakDb: number; // dBFS
  rise: number; // semitones from start to end (negative = falling)
  range: number; // semitones between lowest and highest pitch
  medianHz: number; // typical pitch, 0 if unvoiced
  attackFit: number; // 0..1 sharp onset
  loudFit: number; // 0..1, -40 dB -> 0, -5 dB -> 1
  stretchFit: number; // 0..1, longer is more
}

export interface Challenge {
  id: string;
  title: string;
  emoji: string;
  hint: string;
  label: string; // what the Tone bar is called for this challenge
  allowUnvoiced?: boolean; // whispers have no pitch
  tone: (m: Measures) => number; // 0..1
  good: string[];
  bad: string[];
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
// flat = 0.25, +6 semitones = full marks, falling drops toward 0
const riseFit = (rise: number) => clamp01(0.25 + (rise <= 0 ? rise / 20 : rise / 8));
const fallFit = (rise: number, full: number) => clamp01(-rise / full);
const semitones = (a: number, b: number) => 12 * Math.log2(b / a);

export const CHALLENGES: Challenge[] = [
  {
    id: "classic",
    title: "Classic jjinja",
    emoji: "🗣️",
    hint: "Sharp JJIN, long rising JAAA?",
    label: "Tone",
    tone: (m) => riseFit(m.rise),
    good: ["Textbook meme jjinja. Chef's kiss."],
    bad: ["Needs more 'JAAA?' at the end.", "Flat like a Seoul subway map. More drama!"],
  },
  {
    id: "whisper",
    title: "Whisper jjinja",
    emoji: "🤫",
    hint: "As quietly as you can, but we still need to hear it",
    label: "Hush",
    allowUnvoiced: true,
    // ideal is a soft -40..-22 dB; shouting scores zero
    tone: (m) => (m.peakDb <= -22 ? 1 : clamp01(1 - (m.peakDb + 22) / 15)),
    good: ["So quiet. So deadly. So jjinja.", "A library-approved jjinja."],
    bad: ["That was not a whisper. The neighbors heard.", "Inside voice! INSIDE VOICE!"],
  },
  {
    id: "opera",
    title: "Opera jjinja",
    emoji: "🎭",
    hint: "Hit the high notes. Huge pitch swings!",
    label: "Drama",
    tone: (m) => clamp01(m.range / 16) * 0.8 + m.stretchFit * 0.2,
    good: ["Bravo! Encore! The fat lady is jealous.", "Pavarotti just rose from the grave."],
    bad: ["That was more karaoke than opera.", "One note does not an opera make."],
  },
  {
    id: "sad",
    title: "Sad jjinja",
    emoji: "😢",
    hint: "Slow, falling and heartbroken",
    label: "Sorrow",
    tone: (m) => 0.6 * fallFit(m.rise, 6) + 0.2 * m.stretchFit + 0.2 * (1 - m.loudFit),
    good: ["Somebody get this person a tissue.", "K-drama episode 16 energy."],
    bad: ["Too cheerful. Think of your last breakup.", "That sounded like good news."],
  },
  {
    id: "shocked",
    title: "Shocked-by-gossip jjinja",
    emoji: "😱",
    hint: "Loud, sharp, and shooting straight up",
    label: "Shock",
    tone: (m) => 0.5 * clamp01(m.rise / 10) + 0.3 * m.loudFit + 0.2 * m.attackFit,
    good: ["You heard the WHOLE story, didn't you?", "The group chat is on fire."],
    bad: ["You sound like you already knew the gossip.", "More gasp! The tea is HOT!"],
  },
  {
    id: "angry",
    title: "Angry jjinja",
    emoji: "😡",
    hint: "Loud, punchy, slamming down at the end",
    label: "Rage",
    tone: (m) => 0.4 * m.loudFit + 0.3 * m.attackFit + 0.3 * fallFit(m.rise, 4),
    good: ["Someone's getting a strongly worded email.", "Okay okay, we believe you!"],
    bad: ["That's mildly annoyed at best.", "Angry? You sound like you lost a sock."],
  },
  {
    id: "slow",
    title: "Slowest jjinja ever",
    emoji: "🐢",
    hint: "Stretch it as long as you can (3 seconds max)",
    label: "Slow",
    tone: (m) => clamp01((m.duration - 0.6) / 2.2),
    good: ["Jjjjjjjiiiiinnnnjjjjaaaaa. Respect.", "A jjinja you could age wine in."],
    bad: ["That was a speedrun, not a slow jjinja.", "Slower! Like a Monday morning!"],
  },
  {
    id: "mouse",
    title: "Highest jjinja",
    emoji: "🐭",
    hint: "Squeak it as high as you can",
    label: "Squeak",
    tone: (m) => (m.medianHz > 0 ? clamp01(semitones(150, m.medianHz) / 22) : 0),
    good: ["Only dogs can hear that one.", "Squeak level: cartoon mouse."],
    bad: ["Higher! Think chipmunk!", "That's a medium-sized jjinja."],
  },
  {
    id: "bear",
    title: "Deepest jjinja",
    emoji: "🐻",
    hint: "As low as your voice can go",
    label: "Depth",
    tone: (m) => (m.medianHz > 0 ? clamp01(semitones(m.medianHz, 260) / 16) : 0),
    good: ["The floor is shaking.", "Movie trailer voice unlocked."],
    bad: ["Deeper! Channel your inner bear.", "That's a teddy bear at best."],
  },
];

const BY_ID = new Map(CHALLENGES.map((c) => [c.id, c]));

export function getChallenge(id: unknown): Challenge {
  return BY_ID.get(String(id)) ?? CHALLENGES[0];
}

export function publicInfo(c: Challenge) {
  return { id: c.id, title: c.title, emoji: c.emoji, hint: c.hint };
}

// Picks a challenge not used yet in this match (falls back to any once all are used).
export function pickChallenge(used: string[]): Challenge {
  const fresh = CHALLENGES.filter((c) => !used.includes(c.id));
  const pool = fresh.length ? fresh : CHALLENGES;
  return pool[Math.floor(Math.random() * pool.length)];
}
