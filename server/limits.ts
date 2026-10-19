// Rate limits: connections per IP, a message budget per connection, and per-action limits per IP.

export const MAX_CONNECTIONS_PER_IP = 8;
export const MAX_CONNECTIONS_TOTAL = 3000;

// Per connection: bursts of up to 80 messages, refilling at 30/s (WebRTC setup is chatty).
const BUCKET_SIZE = 80;
const REFILL_PER_SEC = 30;
// Clients that keep hammering after running dry get disconnected.
const MAX_DROPPED = 200;

// Per IP and action: at most `max` within `windowMs`.
const ACTION_LIMITS: Record<string, { max: number; windowMs: number }> = {
  hello: { max: 30, windowMs: 60_000 },
  create: { max: 15, windowMs: 60_000 },
  join: { max: 30, windowMs: 60_000 }, // also slows down guessing room codes
  quick: { max: 30, windowMs: 60_000 },
  practice: { max: 30, windowMs: 60_000 },
  report: { max: 10, windowMs: 60 * 60_000 },
};

const connections = new Map<string, number>();
let total = 0;

export function openConnection(ip: string): boolean {
  if (total >= MAX_CONNECTIONS_TOTAL || (connections.get(ip) ?? 0) >= MAX_CONNECTIONS_PER_IP) return false;
  connections.set(ip, (connections.get(ip) ?? 0) + 1);
  total++;
  return true;
}

export function closeConnection(ip: string) {
  const n = (connections.get(ip) ?? 1) - 1;
  if (n <= 0) connections.delete(ip);
  else connections.set(ip, n);
  total = Math.max(0, total - 1);
}

export class MessageBudget {
  private tokens = BUCKET_SIZE;
  private last = Date.now();
  private dropped = 0;

  // "ok" to handle, "drop" to ignore, "kick" to disconnect
  take(): "ok" | "drop" | "kick" {
    const now = Date.now();
    this.tokens = Math.min(BUCKET_SIZE, this.tokens + ((now - this.last) / 1000) * REFILL_PER_SEC);
    this.last = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      this.dropped = 0;
      return "ok";
    }
    return ++this.dropped > MAX_DROPPED ? "kick" : "drop";
  }
}

const hits = new Map<string, number[]>(); // `${ip}:${action}` -> timestamps

export function allowAction(ip: string, action: string): boolean {
  const limit = ACTION_LIMITS[action];
  if (!limit) return true;
  const key = `${ip}:${action}`;
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < limit.windowMs);
  if (recent.length >= limit.max) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  return true;
}

// Forget idle entries so memory doesn't grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [key, times] of hits) {
    const action = key.slice(key.lastIndexOf(":") + 1);
    const windowMs = ACTION_LIMITS[action]?.windowMs ?? 0;
    if (!times.some((t) => now - t < windowMs)) hits.delete(key);
  }
}, 5 * 60_000).unref();
