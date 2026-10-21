// Records a match as a vertical 9:16 video for TikTok/Reels/Shorts: player one on top, player
// two below, with the game's overlays redrawn onto a canvas and both voices mixed in.

const W = 720;
const H = 1280;
const HALF = H / 2;
const FPS = 30;
const MIME_CHOICES = [
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

export function recordingSupported() {
  return typeof MediaRecorder !== "undefined" && !!HTMLCanvasElement.prototype.captureStream;
}

function pickMime() {
  return MIME_CHOICES.find((m) => MediaRecorder.isTypeSupported?.(m)) ?? "";
}

export function fileExtension(mime) {
  return mime.includes("mp4") ? "mp4" : "webm";
}

export class MatchRecorder {
  // getScene() returns what to draw right now (see drawScene below)
  constructor(getScene) {
    this.getScene = getScene;
    this.canvas = document.createElement("canvas");
    this.canvas.width = W;
    this.canvas.height = H;
    this.g = this.canvas.getContext("2d");
    this.audio = new AudioContext();
    this.mix = this.audio.createMediaStreamDestination();
    // both players shouting at once would clip; a compressor keeps the mix loud but clean
    this.compressor = this.audio.createDynamicsCompressor();
    this.compressor.threshold.value = -18;
    this.compressor.ratio.value = 6;
    this.compressor.connect(this.mix);
    this.sources = new Map(); // stream id -> source node
    this.recorders = [];
    this.timer = null;
  }

  // Adds a stream's audio (your mic, the opponent's voice) to the mix. Safe to call repeatedly.
  addAudio(stream) {
    if (!stream || this.sources.has(stream.id) || !stream.getAudioTracks().length) return;
    const src = this.audio.createMediaStreamSource(stream);
    src.connect(this.compressor);
    this.sources.set(stream.id, src);
  }

  start() {
    this.audio.resume().catch(() => {});
    // a timer, not requestAnimationFrame, keeps frames coming if the tab is in the background
    this.timer = setInterval(() => drawScene(this.g, this.getScene()), 1000 / FPS);
    drawScene(this.g, this.getScene());
    this.stream = new MediaStream([...this.canvas.captureStream(FPS).getVideoTracks(), ...this.mix.stream.getAudioTracks()]);
  }

  // Starts a recording of the canvas. Several can run at once (full match + highlights).
  record({ paused = false } = {}) {
    const mime = pickMime();
    const rec = new MediaRecorder(this.stream, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: 3_000_000 });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const done = new Promise((resolve) => {
      rec.onstop = () => resolve(new Blob(chunks, { type: rec.mimeType || mime || "video/webm" }));
    });
    rec.start(1000);
    if (paused) rec.pause();
    const handle = {
      rec,
      done,
      pause: () => rec.state === "recording" && rec.pause(),
      resume: () => rec.state === "paused" && rec.resume(),
      stop: () => {
        if (rec.state !== "inactive") rec.stop();
        return done;
      },
    };
    this.recorders.push(handle);
    return handle;
  }

  dispose() {
    clearInterval(this.timer);
    for (const r of this.recorders) if (r.rec.state !== "inactive") r.rec.stop();
    for (const src of this.sources.values()) src.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.audio.close().catch(() => {});
  }
}

// ---------- drawing ----------

function cover(g, video, x, y, w, h) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return false;
  const scale = Math.max(w / vw, h / vh);
  const sw = w / scale;
  const sh = h / scale;
  g.drawImage(video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, x, y, w, h);
  return true;
}

function glass(g, x, y, w, h, r = 22, alpha = 0.38) {
  g.save();
  g.fillStyle = `rgba(12, 6, 24, ${alpha})`;
  g.strokeStyle = "rgba(255, 255, 255, 0.18)";
  g.lineWidth = 2;
  g.beginPath();
  g.roundRect(x, y, w, h, r);
  g.fill();
  g.stroke();
  g.restore();
}

function text(g, str, x, y, { size = 32, weight = 800, align = "left", color = "#fff", maxWidth } = {}) {
  g.save();
  g.font = `${weight} ${size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  g.textAlign = align;
  g.textBaseline = "middle";
  g.lineJoin = "round";
  g.lineWidth = Math.max(4, size / 7);
  g.strokeStyle = "rgba(0, 0, 0, 0.7)";
  g.strokeText(str, x, y, maxWidth);
  g.fillStyle = color;
  g.fillText(str, x, y, maxWidth);
  g.restore();
}

function wrap(g, str, maxWidth, size) {
  g.font = `600 ${size}px system-ui, sans-serif`;
  const words = String(str).split(" ");
  const lines = [];
  let line = "";
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (g.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else line = test;
  }
  if (line) lines.push(line);
  return lines.slice(0, 2);
}

function drawHalf(g, p, top) {
  // camera, or a placeholder when it's off / hidden / the bot
  g.fillStyle = "#120c1c";
  g.fillRect(0, top, W, HALF);
  const shown = p.video && cover(g, p.video, 0, top, W, HALF);
  if (!shown) text(g, p.bot ? "🤖" : "🙂", W / 2, top + HALF / 2, { size: 150, align: "center" });

  if (p.active) {
    g.save();
    g.strokeStyle = "#ff3d7f";
    g.lineWidth = 10;
    g.strokeRect(5, top + 5, W - 10, HALF - 10);
    g.restore();
  }

  // name and round wins
  const nameY = top + (top === 0 ? 120 : 44);
  text(g, p.name, 28, nameY, { size: 34, maxWidth: 460 });
  text(g, "★".repeat(p.wins) + "☆".repeat(Math.max(0, 2 - p.wins)), W - 28, nameY, { size: 34, align: "right", color: "#ffc93c" });

  if (p.status) {
    const bw = 300;
    glass(g, (W - bw) / 2, top + HALF - 110, bw, 70, 35, p.status.startsWith("🔴") ? 0.6 : 0.38);
    text(g, p.status, W / 2, top + HALF - 75, { size: 32, align: "center" });
  }

  if (p.score) drawScore(g, p.score, top);
}

function drawScore(g, s, top) {
  const w = 440;
  const h = 210;
  const x = (W - w) / 2;
  const y = top + HALF - h - 26;
  glass(g, x, y, w, h);
  if (s.rally) {
    text(g, `${s.ok ? "✅" : "❌"} ${s.display}`, W / 2, y + 66, { size: 58, align: "center" });
  } else {
    text(g, String(s.total), W / 2 - 12, y + 62, { size: 76, align: "center" });
    text(g, "/100", W / 2 + 62, y + 76, { size: 26, weight: 600, color: "rgba(255,255,255,0.75)" });
    text(g, `Pron ${s.pronunciation} · ${s.label ?? "Tone"} ${s.tone} · Funny ${s.funny}`, W / 2, y + 120, { size: 24, weight: 600, align: "center" });
  }
  const lines = wrap(g, `“${s.comment}”`, w - 40, 24);
  lines.forEach((l, i) => text(g, l, W / 2, y + (s.rally ? 130 : 158) + i * 30, { size: 24, weight: 600, align: "center" }));
}

// scene: { players: [p, p], round, challenge, caption, winner, watermark }
// p: { name, wins, video, bot, active, status, score }
export function drawScene(g, scene) {
  if (!scene) return;
  g.clearRect(0, 0, W, H);
  const [a, b] = scene.players;
  drawHalf(g, a ?? { name: "", wins: 0 }, 0);
  drawHalf(g, b ?? { name: "Waiting…", wins: 0 }, HALF);
  g.fillStyle = "#000";
  g.fillRect(0, HALF - 2, W, 4);

  // round + challenge banner across the top
  if (scene.round) {
    const label = scene.challenge ? `${scene.round} · ${scene.challenge.emoji} ${scene.challenge.title}` : scene.round;
    glass(g, 40, 22, W - 80, 64, 32);
    text(g, label, W / 2, 54, { size: 30, align: "center", maxWidth: W - 120 });
  }

  // announcer caption on the seam between the two players (above the winner banner if shown)
  if (scene.caption) {
    const y = scene.winner ? HALF - 140 : HALF;
    text(g, scene.caption, W / 2, y, { size: 54, weight: 900, align: "center", color: "#ffd166", maxWidth: W - 60 });
  }

  if (scene.winner) {
    glass(g, 60, HALF - 90, W - 120, 180, 30, 0.55);
    text(g, scene.winner, W / 2, HALF - 20, { size: 56, weight: 900, align: "center", maxWidth: W - 160 });
    if (scene.winnerSub) text(g, scene.winnerSub, W / 2, HALF + 45, { size: 28, weight: 600, align: "center", maxWidth: W - 160 });
  }

  if (scene.watermark) {
    text(g, scene.watermark, W / 2, H - 22, { size: 22, weight: 700, align: "center", color: "rgba(255,255,255,0.85)" });
  }
}
