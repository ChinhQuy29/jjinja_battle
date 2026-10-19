import { analyze } from "./features.js";
import { startFaceCapture } from "./face.js";
import { announce, botSpeak, hush, isMuted, roundLine, scoreLine, setMuted } from "./announcer.js";

const MAX_RECORD_MS = 3000;
const LONGER_RALLY_MAX_MS = 8000; // a 3s cap would make "longer" rallies unbeatable after one turn
// replaced by the server's list (which adds our TURN relay in production) on connect
let iceServers = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"] }];
const $ = (id) => document.getElementById(id);

// ---------- connection ----------

let ws;
let myId = null;
let state = null;
let challenges = []; // sent by the server on connect
const pending = []; // messages queued while (re)connecting

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    $("conn").textContent = "";
    send({ t: "hello", name: myName(), adult: ageChoice() === "adult" });
    while (pending.length) ws.send(JSON.stringify(pending.shift()));
  };
  ws.onclose = (e) => {
    $("conn").textContent =
      e.code === 1013 ? "Too many open tabs from your network. Close some and we'll reconnect…" : "Disconnected. Reconnecting…";
    state = null;
    closePeer();
    show("home");
    setTimeout(connect, 1500);
  };
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
}

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  else pending.push(msg);
}

function myName() {
  return $("name").value.trim();
}

// ---------- screens ----------

function show(id) {
  for (const s of document.querySelectorAll(".screen")) s.classList.toggle("hidden", s.id !== id);
}

// ---------- camera + microphone ----------

let localStream = null;
let mediaPromise = null;

function getMedia() {
  if (!mediaPromise) {
    mediaPromise = acquireMedia().catch((err) => {
      mediaPromise = null;
      throw err;
    });
  }
  return mediaPromise;
}

async function acquireMedia() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Camera and mic need HTTPS (or localhost). Open the https:// link.");
  }
  const audio = { echoCancellation: true, noiseSuppression: false };
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio,
      video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
    });
  } catch {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio });
      $("mediaError").textContent = "Camera unavailable, playing with mic only.";
    } catch {
      throw new Error("Camera and mic blocked. Allow access for this site in your browser, then try again.");
    }
  }
  return localStream;
}

function hasVideo(stream) {
  return !!stream?.getVideoTracks().some((t) => t.readyState === "live");
}

function attach(tile, stream, { mine, hideVideo = false }) {
  const video = tile.querySelector("video");
  if (video.srcObject !== stream) {
    video.srcObject = stream;
    if (stream) video.play().catch(() => {});
  }
  video.muted = mine; // never play your own mic back
  video.classList.toggle("mirror", mine);
  tile.classList.toggle("camOff", hideVideo || !hasVideo(stream));
}

// ---------- WebRTC (peer-to-peer video between the two players) ----------

let pc = null;
let videoSender = null;
let sendingVideo = null; // last applied consent state
let peerId = null;
let remoteStream = null;
let peerReady = null;
let signalChain = Promise.resolve();

function syncPeer() {
  const opponent = state?.players.find((p) => p.id !== myId);
  if (!opponent || opponent.bot) return closePeer(); // no video call with the bot
  if (opponent.id === peerId) return;
  closePeer();
  peerId = opponent.id;
  const iAmCaller = state.players[0].id === myId;
  peerReady = createPeer(iAmCaller);
}

async function createPeer(iAmCaller) {
  let stream = null;
  try {
    stream = await getMedia();
  } catch {}
  const conn = new RTCPeerConnection({ iceServers });
  pc = conn;
  remoteStream = new MediaStream();

  if (stream) {
    for (const track of stream.getTracks()) {
      const sender = conn.addTrack(track, stream);
      if (track.kind === "video") videoSender = sender;
    }
  }
  sendingVideo = null;
  applyVideoConsent();
  if (!stream?.getAudioTracks().length) conn.addTransceiver("audio", { direction: "recvonly" });
  if (!stream?.getVideoTracks().length) conn.addTransceiver("video", { direction: "recvonly" });

  conn.ontrack = (e) => {
    if (pc !== conn) return;
    remoteStream.addTrack(e.track);
    e.track.onunmute = renderRoom;
    renderRoom();
  };
  conn.onicecandidate = (e) => {
    if (pc === conn && e.candidate) send({ t: "signal", data: { candidate: e.candidate } });
  };
  conn.onconnectionstatechange = () => pc === conn && renderRoom();

  if (iAmCaller) {
    await conn.setLocalDescription(await conn.createOffer());
    send({ t: "signal", data: { sdp: conn.localDescription } });
  }
}

function onSignal(from, data) {
  if (from !== peerId || !peerReady) return;
  const forPeer = peerId;
  // process signals strictly in order, after the peer connection exists
  signalChain = signalChain
    .then(() => peerReady)
    .then(async () => {
      if (peerId !== forPeer || !pc) return;
      if (data?.sdp) {
        await pc.setRemoteDescription(data.sdp);
        if (data.sdp.type === "offer") {
          await pc.setLocalDescription(await pc.createAnswer());
          send({ t: "signal", data: { sdp: pc.localDescription } });
        }
      } else if (data?.candidate) {
        await pc.addIceCandidate(data.candidate).catch(() => {});
      }
    })
    .catch((err) => console.warn("signal error", err));
}

// In random matches no video frames leave this device until both players opt in.
function videoAllowed() {
  if (!state || state.kind !== "random") return true;
  return state.players.length === 2 && state.players.every((p) => p.cam);
}

function applyVideoConsent() {
  if (!videoSender) return;
  const allow = videoAllowed();
  if (allow === sendingVideo) return;
  sendingVideo = allow;
  const track = allow ? localStream?.getVideoTracks()[0] ?? null : null;
  videoSender.replaceTrack(track).catch(() => {});
}

function closePeer() {
  pc?.close();
  pc = null;
  videoSender = null;
  sendingVideo = null;
  peerId = null;
  remoteStream = null;
  peerReady = null;
  signalChain = Promise.resolve();
  oppRecording = false;
}

// ---------- recording ----------

function pickMime() {
  const options = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"];
  return options.find((m) => window.MediaRecorder?.isTypeSupported?.(m)) ?? "";
}

// Records mic audio for up to maxMs (3s by default). Tap again to stop early.
// Resolves with the audio Blob and a snapshot of the loudest (funniest) moment.
async function record(button, meterEl, maxMs = MAX_RECORD_MS) {
  const stream = await getMedia();
  const audioOnly = new MediaStream(stream.getAudioTracks());
  return new Promise((resolve) => {
    const mime = pickMime();
    const rec = new MediaRecorder(audioOnly, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    let raf;
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    let face = null;
    rec.onstop = async () => {
      button.onclick = null;
      button.classList.remove("live");
      cancelAnimationFrame(raf);
      clearTimeout(cap);
      meterEl.style.width = "0%";
      resolve({ blob: new Blob(chunks, { type: rec.mimeType || mime }), face: await face.stop() });
    };

    const started = performance.now();
    const stop = () => rec.state === "recording" && rec.stop();
    const tick = () => {
      const pct = Math.min(100, ((performance.now() - started) / maxMs) * 100);
      meterEl.style.width = pct + "%";
      if (pct < 100) raf = requestAnimationFrame(tick);
    };
    // a timer, not rAF, enforces the cap: rAF pauses in background tabs
    const cap = setTimeout(stop, maxMs);

    hush(); // keep the announcer out of the recording
    face = startFaceCapture(stream);
    rec.start();
    button.classList.add("live");
    button.innerHTML = "⏹<small>tap to stop</small>";
    button.onclick = stop;
    tick();
  });
}

function blobToBase64(blob) {
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]);
    r.readAsDataURL(blob);
  });
}

// ---------- overlay pieces ----------

const recordButtonHtml = `
  <button class="recBtn">🎤<small>tap &amp; say it</small></button>
  <div class="meter"><div></div></div>`;

function scoreCard(score, audioUrl = null, face = null) {
  const bar = (label, v) => `<div class="bar"><span>${label}</span><div><i style="width:${v}%"></i></div><b>${v}</b></div>`;
  return `
    <div class="card pop">
      ${face ? `<img class="faceThumb" src="${face}" alt="Your face at the loudest moment" />` : ""}
      <div class="total">${score.total}<small>/100</small></div>
      ${bar("Pron.", score.pronunciation)}
      ${bar(escapeHtml(score.label ?? "Tone"), score.tone)}
      ${bar("Funny", score.funny)}
      <p class="comment">“${escapeHtml(score.comment)}”</p>
      ${audioUrl ? `<button class="small replay" data-src="${audioUrl}">▶ Replay</button>` : ""}
    </div>`;
}

function rallyCard(result, audioUrl = null) {
  return `
    <div class="card pop rallyCard ${result.ok ? "ok" : "fail"}">
      <div class="verdict">${result.ok ? "✅" : "❌"}</div>
      <div class="total">${escapeHtml(result.display)}</div>
      <p class="comment">${escapeHtml(result.comment)}</p>
      ${audioUrl ? `<button class="small replay" data-src="${audioUrl}">▶ Replay</button>` : ""}
    </div>`;
}

function badge(text, cls = "") {
  return `<div class="badge ${cls}">${text}</div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest(".replay");
  if (btn) new Audio(btn.dataset.src).play().catch(() => {});
});

function safeGet(k) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function safeSet(k, v) {
  try {
    localStorage.setItem(k, v);
  } catch {}
}

// ---------- practice ----------

let practiceBest = Number(safeGet("practiceBest") ?? 0) || 0;
let practiceAudio = null;
let practiceFace = null;

function renderChallengePicker() {
  const select = $("practiceChallenge");
  const current = select.value || "classic";
  select.innerHTML = challenges.map((c) => `<option value="${c.id}">${c.emoji} ${escapeHtml(c.title)}</option>`).join("");
  select.value = challenges.some((c) => c.id === current) ? current : "classic";
  renderChallengeHint();
}

function renderChallengeHint() {
  const c = challenges.find((x) => x.id === $("practiceChallenge").value);
  $("practiceHint").textContent = c ? c.hint : "";
}

async function openPractice() {
  show("practice");
  $("practiceBest").textContent = practiceBest || "—";
  $("practiceError").textContent = "";
  const tile = $("practiceTile");
  tile.querySelector(".overlay").innerHTML = `<div class="cardSlot"></div>${recordButtonHtml}`;
  armPracticeButton();
  try {
    attach(tile, await getMedia(), { mine: true });
  } catch (err) {
    $("practiceError").textContent = err.message;
    tile.classList.add("camOff");
  }
}

function armPracticeButton() {
  const btn = $("practiceTile").querySelector(".recBtn");
  btn.disabled = false;
  btn.innerHTML = "🎤<small>tap &amp; say it</small>";
  btn.onclick = practiceRound;
}

async function practiceRound() {
  const tile = $("practiceTile");
  const btn = tile.querySelector(".recBtn");
  try {
    tile.querySelector(".cardSlot").innerHTML = "";
    const { blob, face } = await record(btn, tile.querySelector(".meter div"));
    btn.innerHTML = "⏳<small>judging</small>";
    btn.disabled = true;
    practiceFace = face;
    if (practiceAudio) URL.revokeObjectURL(practiceAudio);
    practiceAudio = URL.createObjectURL(blob);
    send({ t: "practice", features: await analyze(blob), challenge: $("practiceChallenge").value });
  } catch (err) {
    $("practiceError").textContent = err.message || String(err);
    armPracticeButton();
  }
}

// ---------- match ----------

let oppRecording = false;
let timerRaf = null;
let clipUrls = {}; // playerId -> data URL of their clip this round
let clipRound = 0;

async function matchTurn(btn, meter) {
  try {
    send({ t: "rec", on: true });
    const maxMs = state?.challenge?.id === "rally-longer" ? LONGER_RALLY_MAX_MS : MAX_RECORD_MS;
    const { blob, face } = await record(btn, meter, maxMs);
    send({ t: "rec", on: false });
    btn.innerHTML = "⏳<small>judging</small>";
    btn.disabled = true;
    const [features, audio] = await Promise.all([analyze(blob), blobToBase64(blob)]);
    send({ t: "submit", features, audio, mime: blob.type, face });
  } catch (err) {
    send({ t: "rec", on: false });
    $("mediaError").textContent = err.message || String(err);
    btn.innerHTML = "🎤<small>tap &amp; say it</small>";
    btn.onclick = () => matchTurn(btn, meter);
  }
}

function nameOf(id) {
  return state?.players.find((p) => p.id === id)?.name ?? "?";
}

function overlayFor(p) {
  const s = state;
  if (!p) return { key: "empty", html: badge("Waiting for opponent…<small>send the invite link</small>", "big") };

  const me = p.id === myId;
  const score = s.current?.[p.id];
  const url = clipUrls[p.id] ?? null;
  const connecting = !me && (!pc || pc.connectionState !== "connected");
  const netNote = !me && pc?.connectionState === "failed" ? badge("Video couldn't connect on this network", "warn") : "";

  if (s.phase === "lobby") {
    return {
      key: `lobby-${p.ready}-${connecting}`,
      html: netNote + badge(p.ready ? "Ready ✓" : "Not ready", p.ready ? "good" : ""),
    };
  }
  if (s.phase === "over") {
    const sum = s.history.reduce((acc, r) => acc + (r.scores[p.id]?.total ?? 0), 0);
    const label = s.winner === "draw" ? "🤝 Draw" : s.winner === p.id ? "🏆 Winner" : "😵 Defeated";
    const stat = s.mode === "rally" ? `${sum} jjinja${sum === 1 ? "" : "s"} landed` : `${sum} pts total`;
    return { key: `over-${s.winner}-${p.ready}`, html: badge(`${label}<small>${stat}${p.ready ? " · wants a rematch" : ""}</small>`, s.winner === p.id ? "win big" : "big") };
  }
  // in a rally you take many turns per round, so an earlier result doesn't hide the record button
  const turnKey = `${s.round}-${s.challenge?.hint ?? ""}`;
  if (s.phase === "turn" && s.turnOf === p.id && (s.mode === "rally" || !score)) {
    if (me) return { key: `myturn-${turnKey}`, html: recordButtonHtml, arm: true };
    return {
      key: `oppturn-${turnKey}-${oppRecording}`,
      html: oppRecording ? badge("🔴 Recording…", "rec") : badge("🎤 Their turn…"),
    };
  }
  if (score?.rally) return { key: `rally-${turnKey}-${score.display}-${score.ok}-${!!url}`, html: rallyCard(score, url) };
  if (score) return { key: `score-${s.round}-${score.total}-${score.comment}-${!!url}`, html: scoreCard(score, url) };
  return { key: `idle-${s.round}`, html: netNote };
}

function renderTiles() {
  const s = state;
  for (let i = 0; i < 2; i++) {
    const tile = $(`tile${i}`);
    const p = s.players[i];
    tile.classList.toggle("empty", !p);
    tile.classList.toggle("me", p?.id === myId);
    tile.classList.toggle("active", !!p && s.phase === "turn" && s.turnOf === p.id);
    const hiddenTag = s.kind === "random" && p && !videoAllowed() ? " · 🔒 cam off" : "";
    tile.querySelector(".pname").textContent = p ? `${p.name}${p.id === myId ? " (you)" : ""}${hiddenTag}` : "";
    tile.querySelector(".reportBtn").hidden = !p || p.id === myId || p.bot;
    tile.querySelector(".noCam").textContent = p?.bot ? "🤖" : "🙂";
    tile.querySelector(".wins").textContent = p ? "★".repeat(p.wins) + "☆".repeat(Math.max(0, 2 - p.wins)) : "";

    if (!p) attach(tile, null, { mine: false });
    else if (p.id === myId) attach(tile, localStream, { mine: true });
    // receiver-side check too: their video stays hidden unless both agreed (audio keeps playing)
    else attach(tile, remoteStream, { mine: false, hideVideo: !videoAllowed() });

    const overlay = tile.querySelector(".overlay");
    const o = overlayFor(p);
    if (overlay.dataset.key !== o.key) {
      overlay.dataset.key = o.key;
      overlay.innerHTML = o.html;
      if (o.arm) {
        const btn = overlay.querySelector(".recBtn");
        btn.onclick = () => matchTurn(btn, overlay.querySelector(".meter div"));
      }
    }
  }
}

function renderRoom() {
  const s = state;
  if (!s) return;
  show("room");
  $("roomCode").textContent = s.code;
  $("roomNotice").textContent = s.notice ?? "";

  if (s.round !== clipRound) {
    clipUrls = {};
    clipRound = s.round;
  }

  const inMatch = s.phase === "turn" || s.phase === "reveal";
  const me = s.players.find((p) => p.id === myId);
  $("lobbyPanel").classList.toggle("hidden", s.phase !== "lobby");
  $("modePicker").classList.toggle("hidden", s.phase !== "lobby" && s.phase !== "over");
  for (const b of document.querySelectorAll("#modePicker button")) b.classList.toggle("selected", b.dataset.mode === s.mode);
  $("overPanel").classList.toggle("hidden", s.phase !== "over");

  if (s.phase === "lobby") {
    $("lobbyText").textContent =
      s.players.length < 2
        ? "Share the invite link or room code with your friend."
        : s.mode === "rally"
          ? "Rally: take turns, and each jjinja must beat the last one. First to fail loses. Best of 3 rallies!"
          : "Both players press ready to start. Best of 3!";
    $("btnReady").disabled = s.players.length < 2;
    $("btnReady").textContent = me?.ready ? "Cancel ready" : "I'm ready";
  }

  document.querySelector(".status").classList.toggle("hidden", !inMatch);
  $("roundLabel").textContent = inMatch ? `${s.mode === "rally" ? "Rally" : "Round"} ${s.round}` : "";
  const c = inMatch ? s.challenge : null;
  $("challengeLabel").innerHTML = c
    ? `<span class="cEmoji">${c.emoji}</span><span><b>${escapeHtml(c.title)}</b><small>${escapeHtml(c.hint)}</small></span>`
    : "";
  if (s.phase === "turn") {
    $("turnLabel").textContent = s.turnOf === myId ? "Your turn! Say it: JJINJA?!" : `${nameOf(s.turnOf)} is up…`;
    startTimer(s.deadline - s.now + Date.now());
  } else {
    $("turnLabel").textContent = s.phase === "reveal" ? "Judges are deliberating…" : "";
    stopTimer();
  }

  if (s.phase === "over") {
    $("overTitle").textContent =
      s.winner === "draw" ? "It's a draw. Jjinja?" : s.winner === myId ? "🏆 You win! JJINJA!" : `${nameOf(s.winner)} wins. Jjinja…?`;
    const ids = s.players.map((p) => p.id);
    const rows = s.history
      .map((r) => `<tr><td>R${r.round} <small>${escapeHtml(r.challenge ?? "")}</small></td>${ids.map((id) => `<td class="${r.winner === id ? "won" : ""}">${r.scores[id]?.total ?? "-"}</td>`).join("")}</tr>`)
      .join("");
    const note = s.mode === "rally" ? `<p class="hint small">Numbers are jjinjas each player landed in that rally.</p>` : "";
    $("overTable").innerHTML = note + `<table><tr><th></th>${ids.map((id) => `<th>${escapeHtml(nameOf(id))}</th>`).join("")}</tr>${rows}</table>`;
    $("btnRematch").textContent = me?.ready ? "Waiting for opponent…" : "Rematch";
    renderFaces(s);
  }

  renderCamConsent();
  applyVideoConsent();
  renderTiles();
}

function renderCamConsent() {
  const s = state;
  const panel = $("camConsent");
  const show = s.kind === "random" && s.players.length === 2;
  panel.classList.toggle("hidden", !show);
  if (!show) return;
  const me = s.players.find((p) => p.id === myId);
  const opp = s.players.find((p) => p.id !== myId);
  const btn = $("btnCam");
  if (ageChoice() !== "adult") {
    $("camText").textContent = "Cameras stay off in random matches for players under 18. Audio still works!";
    btn.hidden = true;
    return;
  }
  btn.hidden = false;
  btn.textContent = me?.cam ? "📷 Hide my camera" : "📷 Show my camera";
  $("camText").textContent = videoAllowed()
    ? "Cameras are on for both of you."
    : me?.cam
      ? `Waiting for ${opp?.name ?? "your opponent"} to turn their camera on too.`
      : opp?.cam
        ? `${opp.name} wants cameras on. Video shows only if you both agree.`
        : "Cameras are off in random matches. Video shows only if you both turn them on.";
}

function renderFaces(s) {
  const faces = s.faces ?? {};
  const cards = s.players
    .filter((p) => faces[p.id])
    .map((p) => {
      const f = faces[p.id];
      const file = `jjinja-${p.name.replace(/[^\w-]+/g, "_")}.jpg`;
      return `
        <figure class="polaroid">
          <img src="${f.image}" alt="${escapeHtml(p.name)}'s funniest face" />
          <figcaption><b>${escapeHtml(p.name)}</b><small>Round ${f.round} · Funny ${f.funny}</small></figcaption>
          <a class="small" href="${f.image}" download="${file}">Save</a>
        </figure>`;
    })
    .join("");
  $("overFaces").innerHTML = cards ? `<h3>Funniest faces</h3><div class="faces">${cards}</div>` : "";
}

let queueTimer = null;

let timerDeadline = 0;

function startTimer(deadlineLocal) {
  if (Math.abs(deadlineLocal - timerDeadline) < 500 && timerRaf) return;
  stopTimer();
  timerDeadline = deadlineLocal;
  const total = deadlineLocal - Date.now();
  const tick = () => {
    const left = Math.max(0, deadlineLocal - Date.now());
    $("timerBar").style.width = (left / Math.max(total, 1)) * 100 + "%";
    timerRaf = left > 0 ? requestAnimationFrame(tick) : null;
  };
  tick();
}

function stopTimer() {
  if (timerRaf) cancelAnimationFrame(timerRaf);
  timerRaf = null;
  timerDeadline = 0;
  $("timerBar").style.width = "0%";
}

// ---------- announcer ----------

function announceTransition(prev, next) {
  const name = (id) => next.players.find((p) => p.id === id)?.name ?? "?";
  if (next.phase === "turn") {
    const newTurn = prev?.phase !== "turn" || prev.turnOf !== next.turnOf || prev.round !== next.round;
    if (!newTurn) return;
    if (next.players.find((p) => p.id === next.turnOf)?.bot) setTimeout(botSpeak, 1500);
    const who = next.turnOf === myId ? "Your turn!" : `${name(next.turnOf)}'s turn.`;
    const newRound = !prev || prev.round !== next.round || prev.phase === "lobby" || prev.phase === "over";
    if (next.mode === "rally") {
      // mid-rally turns move fast; the "Higher!"/"Longer!" call already cued the next player
      if (!newRound) return;
      const verb = next.challenge?.title.split(" ").pop().toLowerCase() ?? "";
      return announce(`Rally ${next.round}! Go ${verb}! ${next.turnOf === myId ? "You start!" : `${name(next.turnOf)} starts.`}`);
    }
    const twist = next.challenge && next.challenge.id !== "classic" ? ` ${next.challenge.title}!` : "";
    announce(newRound ? `${roundLine(next.round, next.players.map((p) => p.wins))}${twist} ${who}` : who);
  } else if (next.phase === "over" && prev?.phase !== "over") {
    if (next.winner === "draw") return announce("It's a draw!");
    const loser = next.players.find((p) => p.id !== next.winner);
    const flawless = loser && loser.wins === 0 ? " Flawless victory!" : "";
    announce(`${next.winner === myId ? "You win!" : `${name(next.winner)} wins!`}${flawless}`);
  }
}

function renderMute() {
  $("btnMute").textContent = isMuted() ? "🔇" : "🔊";
  $("btnMute").title = isMuted() ? "Announcer off" : "Announcer on";
}

// ---------- messages ----------

function onMessage(m) {
  switch (m.t) {
    case "welcome":
      myId = m.id;
      challenges = m.challenges ?? [];
      if (m.iceServers?.length) iceServers = m.iceServers;
      renderChallengePicker();
      break;
    case "error":
      $("homeError").textContent = m.msg;
      show("home");
      break;
    case "queued":
      show("queue");
      $("queueText").textContent = "Looking for an opponent…";
      clearTimeout(queueTimer);
      queueTimer = setTimeout(() => {
        $("queueText").textContent = "No one's around right now. Jjinja Bot is always up for a fight!";
        $("btnBot").classList.add("pulse");
      }, 12000);
      break;
    case "unqueued":
      show("home");
      break;
    case "state":
      if (m.turnOf !== state?.turnOf || m.phase !== "turn") oppRecording = false;
      announceTransition(state, m);
      state = m;
      history.replaceState(null, "", `/r/${m.code}`);
      syncPeer();
      renderRoom();
      break;
    case "slow":
      $("conn").textContent = m.msg;
      setTimeout(() => ($("conn").textContent = ""), 5000);
      if (m.action === "practice") armPracticeButton();
      if (m.action === "quick") show("home");
      break;
    case "reported":
      state = null;
      closePeer();
      history.replaceState(null, "", "/");
      show("home");
      $("homeError").textContent = "Thanks for reporting. You won't be matched with that player again.";
      break;
    case "signal":
      onSignal(m.from, m.data);
      break;
    case "rec":
      oppRecording = m.on;
      renderRoom();
      break;
    case "clip": {
      const url = m.audio ? `data:${m.mime || "audio/webm"};base64,${m.audio}` : null;
      if (url) clipUrls[m.from] = url;
      announce(m.score.say ?? scoreLine(m.score));
      // you already heard it live over the video call; play it only if the call isn't connected
      if (url && m.from !== myId && pc?.connectionState !== "connected") new Audio(url).play().catch(() => {});
      renderRoom();
      break;
    }
    case "practiceResult": {
      const score = m.score;
      if (score.total > practiceBest) {
        practiceBest = score.total;
        safeSet("practiceBest", String(practiceBest));
      }
      $("practiceBest").textContent = practiceBest || "—";
      announce(scoreLine(score));
      $("practiceTile").querySelector(".cardSlot").innerHTML = scoreCard(score, practiceAudio, practiceFace);
      armPracticeButton();
      break;
    }
  }
}

// ---------- wiring ----------

$("btnMute").onclick = () => {
  setMuted(!isMuted());
  renderMute();
  if (!isMuted()) announce("Jjinja!");
};
renderMute();

$("name").value = safeGet("name") ?? "";
$("name").addEventListener("change", () => {
  safeSet("name", myName());
  send({ t: "hello", name: myName(), adult: ageChoice() === "adult" });
});

function requireName() {
  if (!myName()) $("name").value = `Guest${Math.floor(Math.random() * 1000)}`;
  safeSet("name", myName());
  send({ t: "hello", name: myName(), adult: ageChoice() === "adult" });
  $("homeError").textContent = "";
  $("mediaError").textContent = "";
  getMedia()
    .then(() => state && renderRoom())
    .catch((err) => ($("mediaError").textContent = err.message));
}

$("btnPractice").onclick = () => {
  requireName();
  openPractice();
};
$("btnPracticeBack").onclick = () => show("home");
$("practiceChallenge").onchange = () => {
  renderChallengeHint();
  $("practiceTile").querySelector(".cardSlot").innerHTML = "";
};
$("btnCreate").onclick = () => {
  requireName();
  send({ t: "create" });
};
function ageChoice() {
  return safeGet("ageChoice");
}

$("btnQuick").onclick = () => {
  if (!ageChoice()) return $("ageGate").showModal();
  requireName();
  send({ t: "quick" });
};
for (const b of document.querySelectorAll("#ageGate [data-age]")) {
  b.onclick = () => {
    safeSet("ageChoice", b.dataset.age);
    $("ageGate").close();
    $("btnQuick").onclick();
  };
}
$("btnAgeCancel").onclick = () => $("ageGate").close();

$("btnCam").onclick = () => {
  const me = state?.players.find((p) => p.id === myId);
  send({ t: "cam", on: !me?.cam });
};

for (const b of document.querySelectorAll(".reportBtn")) b.onclick = () => $("reportDialog").showModal();
$("btnReportCancel").onclick = () => $("reportDialog").close();
$("btnReportSend").onclick = () => {
  $("reportDialog").close();
  // stop seeing and hearing them immediately, before the server even answers
  closePeer();
  if (state) renderTiles();
  send({ t: "report", reason: $("reportReason").value });
};
$("btnCancelQuick").onclick = () => {
  clearTimeout(queueTimer);
  send({ t: "cancelQuick" });
};
$("btnBot").onclick = () => {
  clearTimeout(queueTimer);
  $("btnBot").classList.remove("pulse");
  send({ t: "bot" });
};
$("btnJoin").onclick = () => {
  requireName();
  send({ t: "join", code: $("joinCode").value.trim().toUpperCase() });
};
$("btnReady").onclick = () => send({ t: "ready" });
for (const b of document.querySelectorAll("#modePicker button")) b.onclick = () => send({ t: "mode", mode: b.dataset.mode });
$("btnRematch").onclick = () => send({ t: "ready" });
$("btnLeave").onclick = () => {
  send({ t: "leave" });
  state = null;
  closePeer();
  history.replaceState(null, "", "/");
  show("home");
};
$("btnCopy").onclick = async () => {
  const link = `${location.origin}/r/${state?.code}`;
  try {
    await navigator.clipboard.writeText(link);
    $("btnCopy").textContent = "Copied!";
  } catch {
    prompt("Copy this link:", link);
  }
  setTimeout(() => ($("btnCopy").textContent = "Copy invite link"), 1500);
};

// invite links: /r/CODE prefills the join box
const inviteMatch = location.pathname.match(/^\/r\/([A-Z0-9]{4})$/i);
if (inviteMatch) {
  $("joinCode").value = inviteMatch[1].toUpperCase();
  $("homeError").textContent = "You've been invited! Enter your name and press Join room.";
}

connect();
