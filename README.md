# Jjinja Battle (prototype)

Say "jjinja" (찐짜) into your mic, get scored 0–100, and beat your friend in a best-of-3.

Scoring is **vibes-based** for now: the browser measures loudness, syllables, onset sharpness and the pitch contour, and the server turns that into Pronunciation / Tone / Funny scores with some randomness added. A rising, dramatic "jjin-JAAA?" scores best.

## Run it

```bash
npm install
npm run dev
```

Open http://localhost:3000.

## Play with a friend over the internet

Browsers only allow microphone access on `https://` (or `localhost`), so give your friend an HTTPS tunnel to your machine. Cloudflare's quick tunnel is free and needs no account:

```bash
winget install --id Cloudflare.cloudflared
```

```bash
cloudflared tunnel --url http://localhost:3000
```

It prints a link like `https://something-random.trycloudflare.com`. Both of you open that link (you should use it too, not localhost), then:

1. You: enter a name, click **Invite a friend**, then **Copy invite link** and send it.
2. Friend: opens the link, enters a name, clicks **Join room**.
3. Both click **I'm ready**. Take turns recording (3 seconds max, tap again to stop early). You hear each other's clips automatically.

**Random match** pairs anyone who clicks it at the same time. **Practice** scores you solo and keeps a personal best.

## Put it online

See [DEPLOY.md](DEPLOY.md): a ~$5/month VPS, a free DuckDNS subdomain, automatic HTTPS, and a video relay, set up with one script.

## Layout

- `server/index.ts`: HTTP + WebSocket server (rooms, invite codes, matchmaking queue, turns, timers)
- `server/scoring.ts`: the prototype grader (swap this out for the real model later)
- `public/features.js`: in-browser audio analysis (pitch via autocorrelation, energy, syllables)
- `public/app.js`: UI and recording
