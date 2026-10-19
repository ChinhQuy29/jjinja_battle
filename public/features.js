// Extracts rough voice features from a recorded clip: loudness, syllable count,
// onset sharpness and a pitch contour (autocorrelation). Good enough for vibes.

const FRAME = 0.02; // seconds per analysis frame

export async function analyze(blob) {
  const ctx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, 44100);
  const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
  const data = buf.getChannelData(0);
  const sr = buf.sampleRate;
  const hop = Math.floor(sr * FRAME);
  const win = hop * 2;

  const db = [];
  const pitch = [];
  for (let i = 0; i + win <= data.length; i += hop) {
    const frame = data.subarray(i, i + win);
    let sum = 0;
    for (let j = 0; j < frame.length; j++) sum += frame[j] * frame[j];
    const rms = Math.sqrt(sum / frame.length);
    db.push(20 * Math.log10(rms + 1e-9));
    pitch.push(rms > 0.01 ? detectPitch(frame, sr) : 0);
  }
  if (!db.length) return empty();

  const peakDb = Math.max(...db);
  const gate = peakDb - 25; // frames within 25 dB of the peak count as "voice"
  let first = db.findIndex((d) => d > gate);
  let last = db.length - 1 - [...db].reverse().findIndex((d) => d > gate);
  if (first < 0 || peakDb < -50) return { ...empty(), peakDb };

  const span = db.slice(first, last + 1);
  const spanPitch = pitch.slice(first, last + 1);

  // syllables: peaks separated by a dip of at least 6 dB
  let syllables = 0;
  let inPeak = false;
  let localMax = -Infinity;
  for (const d of span) {
    if (!inPeak && d > peakDb - 12) {
      inPeak = true;
      syllables++;
      localMax = d;
    } else if (inPeak) {
      localMax = Math.max(localMax, d);
      if (d < localMax - 6) inPeak = false;
    }
  }

  // attack: fastest loudness rise in the first 150ms (dB per 10ms)
  let attack = 0;
  for (let i = Math.max(1, first - 1); i < Math.min(db.length, first + 8); i++) attack = Math.max(attack, (db[i] - db[i - 1]) / 2);

  return {
    duration: span.length * FRAME,
    peakDb,
    syllables,
    attack,
    pitch: spanPitch.map((p) => Math.round(p)),
  };
}

function empty() {
  return { duration: 0, peakDb: -100, syllables: 0, attack: 0, pitch: [] };
}

// autocorrelation pitch detection limited to the human voice range
function detectPitch(frame, sr) {
  const minLag = Math.floor(sr / 900);
  const maxLag = Math.floor(sr / 70);
  let best = 0;
  let bestLag = 0;
  let energy = 0;
  for (let j = 0; j < frame.length; j++) energy += frame[j] * frame[j];
  for (let lag = minLag; lag <= maxLag && lag < frame.length; lag++) {
    let c = 0;
    for (let j = 0; j + lag < frame.length; j++) c += frame[j] * frame[j + lag];
    if (c > best) {
      best = c;
      bestLag = lag;
    }
  }
  // weak periodicity means unvoiced (noise, "jj" hiss)
  return bestLag && best / energy > 0.45 ? sr / bestLag : 0;
}
