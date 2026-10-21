// Fighting-game style announcer using the browser's built-in text-to-speech.

const synth = window.speechSynthesis;
let muted = false;
let voice = null;

try {
  muted = localStorage.getItem("announcerMuted") === "1";
} catch {}

function pickVoice() {
  const voices = synth?.getVoices() ?? [];
  const english = voices.filter((v) => v.lang?.startsWith("en"));
  // deeper, punchier voices first when available
  const preferred = ["Google UK English Male", "Microsoft Guy", "Microsoft David", "Daniel", "Alex", "Google US English"];
  voice = preferred.map((n) => english.find((v) => v.name.includes(n))).find(Boolean) ?? english[0] ?? voices[0] ?? null;
}
if (synth) {
  pickVoice();
  synth.onvoiceschanged = pickVoice;
}

export function isMuted() {
  return muted;
}

export function setMuted(value) {
  muted = value;
  try {
    localStorage.setItem("announcerMuted", value ? "1" : "0");
  } catch {}
  if (muted) synth?.cancel();
}

let speakListener = null;
// Called with every line the announcer or the bot says, e.g. to caption match recordings
// (browsers can't record speech-synthesis audio).
export function onSpeak(fn) {
  speakListener = fn;
}

// Speaks a line, cutting off whatever the announcer was saying before.
export function announce(text) {
  if (text) speakListener?.(text);
  if (!synth || muted || !text) return;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  if (voice) u.voice = voice;
  u.rate = 1.05;
  u.pitch = 0.75;
  u.volume = 1;
  synth.speak(u);
}

// Stops speech immediately, e.g. right before the mic starts recording.
export function hush() {
  synth?.cancel();
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// The bot's own "jjinja": a Korean voice says 진짜 properly when the device has one.
export function botSpeak() {
  if (!synth) return;
  if (muted) return speakListener?.("🤖 jjinja?");
  synth.cancel();
  const korean = (synth.getVoices() ?? []).find((v) => v.lang?.toLowerCase().startsWith("ko"));
  const line = korean ? pick(["진짜?", "진짜아아?", "찐짜?!"]) : pick(["jjinja?", "jjinjaaa?", "jjin-JAAA?!"]);
  speakListener?.(`🤖 ${line}`);
  const u = new SpeechSynthesisUtterance(line);
  if (korean) u.voice = korean;
  else if (voice) u.voice = voice;
  u.pitch = 0.9 + Math.random() * 1.1;
  u.rate = 0.7 + Math.random() * 0.5;
  synth.speak(u);
}

export function scoreLine(score) {
  if (score.total === 0 && /time/i.test(score.comment)) return pick(["Too slow!", "Time's up!"]);
  if (score.total >= 90) return pick(["LEGENDARY!", "Flawless jjinja!", "Unbelievable!"]);
  if (score.total >= 75) return pick(["Jjinja?!", "Excellent!", "Now that's a jjinja!"]);
  if (score.total >= 50) return pick(["Not bad.", "Decent.", "Respectable."]);
  if (score.total >= 30) return pick(["Hmm.", "Questionable.", "Needs work."]);
  return pick(["Ouch.", "Oof.", "Was that a jjinja?"]);
}

const ROUND_WORDS = ["one", "two", "three", "four", "five"];

export function roundLine(round, wins) {
  const tied = wins.length === 2 && wins[0] === 1 && wins[1] === 1;
  if (round === 1) return "Round one. Fight!";
  if (round >= 4) return "Sudden death!";
  if (tied) return "Final round!";
  return `Round ${ROUND_WORDS[round - 1] ?? round}!`;
}
