// Abuse controls: name filtering, player reports, blocks, and temporary random-match bans.

const BAN_REPORTERS = 3; // distinct reporters within the window before a ban
const REPORT_WINDOW_MS = 24 * 60 * 60 * 1000;
const BAN_MS = 24 * 60 * 60 * 1000;

// Substrings that get a name replaced. Matched after folding common look-alike characters.
const BANNED = [
  "fuck", "shit", "bitch", "cunt", "nigg", "fag", "retard", "whore", "slut", "dick", "cock",
  "pussy", "penis", "vagina", "porn", "rape", "nazi", "hitler", "kike", "chink", "spic", "tranny",
];

const LOOKALIKES: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", $: "s", "!": "i" };

function fold(s: string) {
  return s
    .toLowerCase()
    .replace(/[013457@$!]/g, (c) => LOOKALIKES[c] ?? c)
    .replace(/[^a-z]/g, "");
}

export function cleanName(raw: unknown): string {
  const name = String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f<>]/g, "")
    .trim()
    .slice(0, 20);
  if (!name || BANNED.some((w) => fold(name).includes(w))) return `Guest${Math.floor(Math.random() * 1000)}`;
  return name;
}

interface ReportRecord {
  reporters: Map<string, number>; // reporter ip -> time
  bannedUntil: number;
}

const reports = new Map<string, ReportRecord>();
const blocks = new Map<string, Set<string>>(); // ip -> ips they never want to meet again

export function report(reporterIp: string, reportedIp: string, details: { reason: string; reporter: string; reported: string }) {
  const now = Date.now();
  if (reporterIp === reportedIp) {
    // same household or shared mobile IP: log it, but an IP block or ban would hit the reporter too
    console.warn(`[report] ${new Date(now).toISOString()} reason=${details.reason} reporter="${details.reporter}" reported="${details.reported}" sameIp=${reportedIp}`);
    return;
  }
  const rec = reports.get(reportedIp) ?? { reporters: new Map(), bannedUntil: 0 };
  for (const [ip, at] of rec.reporters) if (now - at > REPORT_WINDOW_MS) rec.reporters.delete(ip);
  rec.reporters.set(reporterIp, now);
  if (rec.reporters.size >= BAN_REPORTERS) rec.bannedUntil = now + BAN_MS;
  reports.set(reportedIp, rec);

  if (!blocks.has(reporterIp)) blocks.set(reporterIp, new Set());
  blocks.get(reporterIp)!.add(reportedIp);

  console.warn(
    `[report] ${new Date(now).toISOString()} reason=${details.reason} reporter="${details.reporter}" reported="${details.reported}" ` +
      `reportedIp=${reportedIp} distinctReporters=${rec.reporters.size}${rec.bannedUntil > now ? " BANNED" : ""}`,
  );
}

export function isBanned(ip: string) {
  return (reports.get(ip)?.bannedUntil ?? 0) > Date.now();
}

export function blocked(ipA: string, ipB: string) {
  return !!blocks.get(ipA)?.has(ipB) || !!blocks.get(ipB)?.has(ipA);
}
