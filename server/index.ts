import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { grade, sanitize, timeoutScore, type Score } from "./scoring.js";

const PORT = Number(process.env.PORT ?? 3000);
const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));
const TURN_MS = 15_000;
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
  ws: WebSocket;
  room: Room | null;
  queued: boolean;
}

interface RoundResult {
  round: number;
  scores: Record<string, Score>;
  winner: string | null;
}

type Phase = "lobby" | "turn" | "reveal" | "over";

interface Room {
  code: string;
  players: Player[];
  ready: Set<string>;
  phase: Phase;
  round: number;
  order: string[]; // turn order for the current round
  turnIdx: number;
  turnOf: string | null;
  deadline: number;
  wins: Record<string, number>;
  history: RoundResult[];
  current: Record<string, Score>;
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

function createRoom(): Room {
  const room: Room = {
    code: newCode(),
    players: [],
    ready: new Set(),
    phase: "lobby",
    round: 0,
    order: [],
    turnIdx: 0,
    turnOf: null,
    deadline: 0,
    wins: {},
    history: [],
    current: {},
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
    players: room.players.map((p) => ({ id: p.id, name: p.name, ready: room.ready.has(p.id), wins: room.wins[p.id] ?? 0 })),
    round: room.round,
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

function clearTimer(room: Room) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
}

function joinRoom(p: Player, room: Room) {
  leaveRoom(p);
  room.players.push(p);
  p.room = room;
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
  room.deadline = Date.now() + TURN_MS;
  room.timer = setTimeout(() => submit(room, room.turnOf!, null), TURN_MS + 1500);
  pushState(room);
}

function submit(room: Room, playerId: string, payload: { features: unknown; audio?: string; mime?: string; face?: string } | null) {
  if (room.phase !== "turn" || room.turnOf !== playerId) return;
  clearTimer(room);

  const features = payload ? sanitize(payload.features) : null;
  const score = features ? grade(features) : timeoutScore();
  room.current[playerId] = score;
  room.phase = "reveal";
  const best = room.faces[playerId];
  if (payload?.face && (!best || score.funny > best.funny)) {
    room.faces[playerId] = { image: payload.face, funny: score.funny, round: room.round };
  }

  broadcast(room, { t: "clip", from: playerId, audio: payload?.audio ?? null, mime: payload?.mime ?? null, score });
  pushState(room);

  // give the opponent time to hear the clip and see the score
  const revealMs = Math.min(features?.duration ?? 0, 3.5) * 1000 + 3500;
  room.timer = setTimeout(() => afterReveal(room), revealMs);
}

function afterReveal(room: Room) {
  room.turnIdx += 1;
  if (room.turnIdx < room.order.length) return startTurn(room);

  const [a, b] = room.order;
  const sa = room.current[a]?.total ?? 0;
  const sb = room.current[b]?.total ?? 0;
  const winner = sa === sb ? null : sa > sb ? a : b;
  if (winner) room.wins[winner] = (room.wins[winner] ?? 0) + 1;
  room.history.push({ round: room.round, scores: room.current, winner });

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

function tryMatchmake() {
  while (queue.length >= 2) {
    const a = queue.shift()!;
    const b = queue.shift()!;
    a.queued = b.queued = false;
    const room = createRoom();
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

wss.on("connection", (ws) => {
  const p: Player = { id: randomUUID(), name: "Guest", ws, room: null, queued: false };
  send(p, { t: "welcome", id: p.id });

  ws.on("message", (data) => {
    let msg: any;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    switch (msg.t) {
      case "hello":
        p.name = String(msg.name ?? "").trim().slice(0, 20) || `Guest${Math.floor(Math.random() * 1000)}`;
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
      case "practice":
        send(p, { t: "practiceResult", score: grade(sanitize(msg.features)) });
        break;
    }
  });

  ws.on("close", () => {
    dequeue(p);
    leaveRoom(p);
  });
});

http.listen(PORT, () => {
  console.log(`Jjinja Battle running at http://localhost:${PORT}`);
});
