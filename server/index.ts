import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { grade, sanitize, timeoutScore, type Score } from "./scoring.js";
import { CHALLENGES, pickChallenge, publicInfo, type Challenge } from "./challenges.js";
import { blocked, cleanName, isBanned, report } from "./safety.js";
import { allowAction, closeConnection, MessageBudget, openConnection } from "./limits.js";
import { hintFor, pickAxis, playRally, type Axis, type RallyResult } from "./rally.js";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
// behind Caddy, the real client IP arrives in X-Forwarded-For
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));
const TURN_MS = 15_000;
const RALLY_TURN_MS = 10_000; // rallies are meant to be quick
const MAX_RALLY_EXCHANGES = 20; // safety cap; a rally that long is a draw
const WINS_NEEDED = 2; // best of 3
const MAX_ROUNDS = 5; // ties extend the match a little
const MAX_AUDIO_BYTES = 400_000;
const MAX_FACE_CHARS = 150_000; // ~110 KB JPEG as a data URL

// ---------- static files ----------

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

const http = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const path = url.pathname === "/" || url.pathname.startsWith("/r/") ? "/index.html" : url.pathname;
  const file = normalize(join(PUBLIC_DIR, path));
  if (!file.startsWith(PUBLIC_DIR)) return void res.writeHead(403).end();
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

// ---------- game state ----------

interface Player {
  id: string;
  name: string;
  ip: string;
  adult: boolean; // confirmed 18+, required to turn the camera on in random matches
  cam: boolean; // consented to show their camera in a random match
  ws: WebSocket;
  room: Room | null;
  queued: boolean;
}

interface RoundResult {
  round: number;
  challenge: string;
  scores: Record<string, { total: number }>; // classic: round score; rally: successful jjinjas
  winner: string | null;
}

type Mode = "classic" | "rally";

interface Rally {
  axis: Axis;
  target: number | null; // value the next jjinja must beat
  exchanges: number;
  successes: Record<string, number>;
}

type Phase = "lobby" | "turn" | "reveal" | "over";

interface Room {
  code: string;
  players: Player[];
  ready: Set<string>;
  phase: Phase;
  kind: "private" | "random"; // random rooms keep cameras off until both players opt in
  mode: Mode;
  rally: Rally | null;
  round: number;
  order: string[]; // turn order for the current round
  turnIdx: number;
  turnOf: string | null;
  deadline: number;
  wins: Record<string, number>;
  history: RoundResult[];
  current: Record<string, Score | RallyResult>;
  challenge: Challenge; // this round's twist
  usedChallenges: string[];
  winner: string | null; // player id, "draw", or null
  faces: Record<string, { image: string; funny: number; round: number }>; // each player's funniest snapshot
  notice: string | null;
  timer: NodeJS.Timeout | null;
}

const rooms = new Map<string, Room>();
const queue: Player[] = [];

function send(p: Player, msg: object) {
  if (p.ws.readyState === WebSocket.OPEN) p.ws.send(JSON.stringify(msg));
}

function broadcast(room: Room, msg: object) {
  for (const p of room.players) send(p, msg);
}

function newCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code: string;
  do code = Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
  while (rooms.has(code));
  return code;
}

function createRoom(kind: Room["kind"] = "private"): Room {
  const room: Room = {
    code: newCode(),
    players: [],
    ready: new Set(),
    phase: "lobby",
    kind,
    mode: "classic",
    rally: null,
    round: 0,
    order: [],
    turnIdx: 0,
    turnOf: null,
    deadline: 0,
    wins: {},
    history: [],
    current: {},
    challenge: CHALLENGES[0],
    usedChallenges: [],
    winner: null,
    faces: {},
    notice: null,
    timer: null,
  };
  rooms.set(room.code, room);
  return room;
}

function pushState(room: Room) {
  broadcast(room, {
    t: "state",
    code: room.code,
    phase: room.phase,
    kind: room.kind,
    mode: room.mode,
    players: room.players.map((p) => ({ id: p.id, name: p.name, ready: room.ready.has(p.id), wins: room.wins[p.id] ?? 0, cam: p.cam })),
    round: room.round,
    challenge: room.phase === "turn" || room.phase === "reveal" ? roundInfo(room) : null,
    turnOf: room.turnOf,
    deadline: room.deadline,
    now: Date.now(),
    current: room.current,
    history: room.history,
    winner: room.winner,
    faces: room.phase === "over" ? room.faces : undefined, // images are large; only send for the results screen
    notice: room.notice,
  });
}

// what the banner shows: the round's challenge, or the rally's axis and current target
function roundInfo(room: Room) {
  if (room.mode !== "rally" || !room.rally) return publicInfo(room.challenge);
  const { axis, target } = room.rally;
  return { id: `rally-${axis.id}`, emoji: axis.emoji, title: axis.title, hint: hintFor(axis, target) };
}

function clearTimer(room: Room) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
}

function joinRoom(p: Player, room: Room) {
  leaveRoom(p);
  room.players.push(p);
  p.room = room;
  p.cam = false;
  room.notice = null;
  pushState(room);
}

function leaveRoom(p: Player) {
  const room = p.room;
  if (!room) return;
  p.room = null;
  room.players = room.players.filter((x) => x !== p);
  room.ready.delete(p.id);
  if (room.players.length === 0) {
    clearTimer(room);
    rooms.delete(room.code);
    return;
  }
  if (room.phase !== "lobby") {
    clearTimer(room);
    resetToLobby(room);
    room.notice = `${p.name} left the match.`;
  }
  pushState(room);
}

function resetToLobby(room: Room) {
  room.phase = "lobby";
  room.ready.clear();
  room.round = 0;
  room.turnOf = null;
  room.wins = {};
  room.history = [];
  room.current = {};
  room.usedChallenges = [];
  room.rally = null;
  room.winner = null;
  room.faces = {};
}

function startMatch(room: Room) {
  resetToLobby(room);
  room.ready.clear();
  room.notice = null;
  for (const p of room.players) room.wins[p.id] = 0;
  startRound(room);
}

function startRound(room: Room) {
  room.round += 1;
  room.current = {};
  if (room.mode === "rally") {
    room.rally = { axis: pickAxis(), target: null, exchanges: 0, successes: {} };
  } else {
    room.challenge = pickChallenge(room.usedChallenges);
    room.usedChallenges.push(room.challenge.id);
  }
  const ids = room.players.map((p) => p.id);
  // alternate who goes first each round
  room.order = room.round % 2 === 1 ? ids : [...ids].reverse();
  room.turnIdx = 0;
  startTurn(room);
}

function startTurn(room: Room) {
  clearTimer(room);
  room.phase = "turn";
  room.turnOf = room.order[room.turnIdx];
  // "longer" rallies allow 8s recordings, so they need extra time per turn
  const turnMs = room.mode === "rally" ? RALLY_TURN_MS + (room.rally?.axis.id === "longer" ? 6000 : 0) : TURN_MS;
  room.deadline = Date.now() + turnMs;
  room.timer = setTimeout(() => submit(room, room.turnOf!, null), turnMs + 1500);
  pushState(room);
}

function submit(room: Room, playerId: string, payload: { features: unknown; audio?: string; mime?: string; face?: string } | null) {
  if (room.phase !== "turn" || room.turnOf !== playerId) return;
  clearTimer(room);

  const features = payload ? sanitize(payload.features) : null;
  if (room.mode === "rally") return submitRally(room, playerId, payload, features);
  const score = features ? grade(features, room.challenge.id) : timeoutScore(room.challenge.id);
  room.current[playerId] = score;
  room.phase = "reveal";
  keepFace(room, playerId, payload?.face, score.funny);

  broadcast(room, { t: "clip", from: playerId, audio: payload?.audio ?? null, mime: payload?.mime ?? null, score });
  pushState(room);

  // give the opponent time to hear the clip and see the score
  const revealMs = Math.min(features?.duration ?? 0, 3.5) * 1000 + 3500;
  room.timer = setTimeout(() => afterReveal(room), revealMs);
}

function keepFace(room: Room, playerId: string, face: string | undefined, funny: number) {
  const best = room.faces[playerId];
  if (face && (!best || funny > best.funny)) room.faces[playerId] = { image: face, funny, round: room.round };
}

function submitRally(room: Room, playerId: string, payload: { audio?: string; mime?: string; face?: string } | null, features: ReturnType<typeof sanitize> | null) {
  const rally = room.rally!;
  const result = playRally(rally.axis, rally.target, features);
  room.current[playerId] = result;
  room.phase = "reveal";
  if (result.ok) {
    rally.target = result.value;
    rally.exchanges += 1;
    rally.successes[playerId] = (rally.successes[playerId] ?? 0) + 1;
  }
  if (features) keepFace(room, playerId, payload?.face, grade(features).funny);

  broadcast(room, { t: "clip", from: playerId, audio: payload?.audio ?? null, mime: payload?.mime ?? null, score: result });
  pushState(room);

  // keep it snappy on success, linger a bit on the decisive fail
  room.timer = setTimeout(() => {
    if (result.ok && rally.exchanges < MAX_RALLY_EXCHANGES) {
      room.turnIdx = 1 - room.turnIdx;
      return startTurn(room);
    }
    const winner = result.ok ? null : room.order.find((id) => id !== playerId) ?? null;
    const scores = Object.fromEntries(room.order.map((id) => [id, { total: rally.successes[id] ?? 0 }]));
    finishRound(room, winner, `${rally.axis.emoji} ${rally.axis.title}`, scores);
  }, result.ok ? 1500 : 3000);
}

function afterReveal(room: Room) {
  room.turnIdx += 1;
  if (room.turnIdx < room.order.length) return startTurn(room);

  const total = (id: string) => (room.current[id] as Score | undefined)?.total ?? 0;
  const [a, b] = room.order;
  const winner = total(a) === total(b) ? null : total(a) > total(b) ? a : b;
  const scores = Object.fromEntries(room.order.map((id) => [id, { total: total(id) }]));
  finishRound(room, winner, `${room.challenge.emoji} ${room.challenge.title}`, scores);
}

function finishRound(room: Room, winner: string | null, label: string, scores: RoundResult["scores"]) {
  if (winner) room.wins[winner] = (room.wins[winner] ?? 0) + 1;
  room.history.push({ round: room.round, challenge: label, scores, winner });

  const champ = room.players.find((p) => (room.wins[p.id] ?? 0) >= WINS_NEEDED);
  if (champ || room.round >= MAX_ROUNDS) {
    room.phase = "over";
    room.turnOf = null;
    room.winner = champ ? champ.id : decideByTotals(room);
    room.ready.clear();
    return pushState(room);
  }
  startRound(room);
}

function decideByTotals(room: Room): string {
  const totals = room.players.map((p) => ({
    id: p.id,
    sum: room.history.reduce((s, r) => s + (r.scores[p.id]?.total ?? 0), 0),
  }));
  totals.sort((x, y) => y.sum - x.sum);
  return totals.length > 1 && totals[0].sum === totals[1].sum ? "draw" : totals[0].id;
}

// pairs the longest-waiting players who haven't blocked each other
function nextPair(): [Player, Player] | null {
  for (let i = 0; i < queue.length; i++) {
    for (let j = i + 1; j < queue.length; j++) {
      if (!blocked(queue[i].ip, queue[j].ip)) {
        const b = queue.splice(j, 1)[0];
        const a = queue.splice(i, 1)[0];
        return [a, b];
      }
    }
  }
  return null;
}

function tryMatchmake() {
  for (let pair = nextPair(); pair; pair = nextPair()) {
    const [a, b] = pair;
    a.queued = b.queued = false;
    const room = createRoom("random");
    joinRoom(a, room);
    joinRoom(b, room);
    // random matches skip the ready check
    setTimeout(() => {
      if (room.players.length === 2 && room.phase === "lobby") startMatch(room);
    }, 2500);
  }
}

function dequeue(p: Player) {
  const i = queue.indexOf(p);
  if (i >= 0) queue.splice(i, 1);
  p.queued = false;
}

// ---------- websocket ----------

const wss = new WebSocketServer({ server: http, path: "/ws", maxPayload: 1_000_000 });

function clientIp(req: import("node:http").IncomingMessage) {
  const direct = req.socket.remoteAddress ?? "unknown";
  const forwarded = req.headers["x-forwarded-for"];
  if (TRUST_PROXY && typeof forwarded === "string" && forwarded) return forwarded.split(",")[0].trim();
  return direct;
}

wss.on("connection", (ws, req) => {
  const ip = clientIp(req);
  if (!openConnection(ip)) return ws.close(1013, "Too many connections");
  const budget = new MessageBudget();
  const p: Player = { id: randomUUID(), name: "Guest", ip, adult: false, cam: false, ws, room: null, queued: false };
  send(p, { t: "welcome", id: p.id, challenges: CHALLENGES.map(publicInfo) });

  ws.on("message", (data) => {
    const verdict = budget.take();
    if (verdict === "kick") return ws.close(1008, "Too many messages");
    if (verdict === "drop") return;
    let msg: any;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (!allowAction(p.ip, msg?.t)) return send(p, { t: "slow", action: msg.t, msg: "Slow down a little! Try again in a minute." });
    switch (msg.t) {
      case "hello":
        p.name = cleanName(msg.name);
        p.adult = msg.adult === true;
        if (!p.adult && p.cam) p.cam = false;
        if (p.room) pushState(p.room);
        break;
      case "create":
        dequeue(p);
        joinRoom(p, createRoom());
        break;
      case "join": {
        const room = rooms.get(String(msg.code ?? "").toUpperCase());
        if (!room) return send(p, { t: "error", msg: "Room not found." });
        if (room.players.includes(p)) return pushState(room);
        if (room.players.length >= 2) return send(p, { t: "error", msg: "Room is full." });
        dequeue(p);
        joinRoom(p, room);
        break;
      }
      case "quick":
        leaveRoom(p);
        if (isBanned(p.ip)) {
          return send(p, {
            t: "error",
            msg: "Random matches are paused for you for 24 hours after several reports. You can still invite friends.",
          });
        }
        if (!p.queued) {
          p.queued = true;
          queue.push(p);
          send(p, { t: "queued" });
          tryMatchmake();
        }
        break;
      case "cancelQuick":
        dequeue(p);
        send(p, { t: "unqueued" });
        break;
      case "leave":
        leaveRoom(p);
        break;
      case "mode": {
        const room = p.room;
        if (!room || (room.phase !== "lobby" && room.phase !== "over")) return;
        room.mode = msg.mode === "rally" ? "rally" : "classic";
        room.ready.clear();
        pushState(room);
        break;
      }
      case "ready": {
        const room = p.room;
        if (!room || (room.phase !== "lobby" && room.phase !== "over")) return;
        if (room.ready.has(p.id)) room.ready.delete(p.id);
        else room.ready.add(p.id);
        if (room.players.length === 2 && room.ready.size === 2) startMatch(room);
        else pushState(room);
        break;
      }
      case "submit": {
        if (!p.room) return;
        const audio = typeof msg.audio === "string" && msg.audio.length <= MAX_AUDIO_BYTES * 1.4 ? msg.audio : undefined;
        const mime = typeof msg.mime === "string" ? msg.mime.slice(0, 60) : undefined;
        const face =
          typeof msg.face === "string" && msg.face.startsWith("data:image/jpeg;base64,") && msg.face.length <= MAX_FACE_CHARS
            ? msg.face
            : undefined;
        submit(p.room, p.id, { features: msg.features, audio, mime, face });
        break;
      }
      case "signal": // WebRTC offer/answer/ICE, relayed to the opponent
      case "rec": {
        // "rec" tells the opponent we started/stopped recording
        const other = p.room?.players.find((x) => x !== p);
        if (other) send(other, { t: msg.t, from: p.id, data: msg.data, on: !!msg.on });
        break;
      }
      case "cam": {
        // camera consent only matters in random rooms, and only adults may turn it on
        if (!p.room || p.room.kind !== "random") return;
        p.cam = msg.on === true && p.adult;
        pushState(p.room);
        break;
      }
      case "report": {
        const room = p.room;
        const other = room?.players.find((x) => x !== p);
        if (!room || !other) return;
        const reason = ["video", "harassment", "name", "other"].includes(msg.reason) ? msg.reason : "other";
        report(p.ip, other.ip, { reason, reporter: p.name, reported: other.name });
        leaveRoom(p);
        send(p, { t: "reported" });
        break;
      }
      case "practice":
        send(p, { t: "practiceResult", score: grade(sanitize(msg.features), msg.challenge) });
        break;
    }
  });

  ws.on("close", () => {
    closeConnection(ip);
    dequeue(p);
    leaveRoom(p);
  });
});

http.listen(PORT, HOST, () => {
  console.log(`Jjinja Battle running at http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
});
