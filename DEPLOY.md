# Deploying Jjinja Battle

This puts the game on a ~$5/month Linux server with a free DuckDNS subdomain and automatic HTTPS. The setup takes about 30 minutes, most of it waiting.

What you end up with:

- `https://<your-name>.duckdns.org` serving the game
- **Caddy**: HTTPS certificates that renew themselves
- **coturn**: a video relay for players on strict networks (school, office, some mobile data)
- **systemd**: restarts the game if it crashes or the server reboots
- **Firewall and automatic security updates**: turned on

## 1. Create an SSH key on your PC (once)

An SSH key lets you log in to the server without a password. In **PowerShell**:

```powershell
ssh-keygen -t ed25519 -C "jjinja-vps"
```

Press Enter to accept the default location, and pick a passphrase you'll remember. Then print the **public** half (safe to share) and copy it:

```powershell
Get-Content $env:USERPROFILE\.ssh\id_ed25519.pub
```

It's one line starting with `ssh-ed25519`. Never share the other file, `id_ed25519` without `.pub`.

## 2. Create the server

Any provider with a ~$5 plan works: Vultr, DigitalOcean, Linode/Akamai, Hetzner. Vultr is used below because its $5 plan has 1 GB RAM and data centers worldwide, including Seoul, Tokyo and Singapore. Prices and plan names change, so check before you buy.

1. Sign up at vultr.com and verify your email. You'll add a payment method; that's between you and Vultr.
2. Go to **Account → SSH Keys → Add SSH Key**, paste the `ssh-ed25519 …` line, and name it `jjinja`.
3. Click **Deploy** (or **Deploy New Server**):
   - **Type:** Cloud Compute, Shared CPU, Regular
   - **Location:** closest to most of your players (e.g. Seoul or Tokyo for Korea and East Asia)
   - **Image:** Ubuntu **24.04 LTS** x64
   - **Plan:** the $5/month one (1 vCPU, 1 GB RAM)
   - **SSH Keys:** tick `jjinja`
   - Turn off auto backups and extra add-ons unless you want them (they cost extra).
   - **Hostname:** `jjinja`
4. Deploy, wait about a minute, and copy the server's **IPv4 address** (e.g. `203.0.113.45`).

## 3. Get a free subdomain (DuckDNS)

1. Go to duckdns.org and sign in with GitHub or Google.
2. Type a subdomain (e.g. `jjinja`), click **add domain**.
3. Put the server's IPv4 address in the **current ip** box and click **update ip**.

Your address is now `jjinja.duckdns.org` (with your own name). The server's IP doesn't change, so you won't need the DuckDNS updater.

## 4. Run the setup script

From PowerShell, log in to the server (answer `yes` to the fingerprint question the first time):

```powershell
ssh root@203.0.113.45
```

On the server, download and run the setup, using your own domain:

```bash
curl -fsSL https://raw.githubusercontent.com/ChinhQuy29/jjinja_battle/main/deploy/setup.sh -o setup.sh
sudo bash setup.sh jjinja.duckdns.org
```

It takes 5–10 minutes. When it prints **All set!**, open `https://jjinja.duckdns.org`. The first visit can take a few extra seconds while Caddy fetches the HTTPS certificate.

### Private repository

The script downloads the code from GitHub, which only works without extra steps if the repository is **public**. If you keep it private:

1. On the server: `ssh-keygen -t ed25519 -f /root/.ssh/jjinja_deploy -N ""` then `cat /root/.ssh/jjinja_deploy.pub`
2. On GitHub: **repo → Settings → Deploy keys → Add deploy key**, paste the key, read-only.
3. On the server:
   ```bash
   printf 'Host github.com\n  IdentityFile /root/.ssh/jjinja_deploy\n' >> /root/.ssh/config
   git clone git@github.com:ChinhQuy29/jjinja_battle.git /opt/jjinja
   cp /opt/jjinja/deploy/setup.sh . && sudo bash setup.sh jjinja.duckdns.org
   ```
   The `curl` download in step 4 won't work for a private repository, which is why this copies `setup.sh` from the clone. `update.sh` pulls as the `jjinja` user, so give that user the key too, or run `git -C /opt/jjinja pull` as root before `update.sh`.

## 5. Updating the live game

After you push changes to GitHub, run this from PowerShell:

```powershell
ssh root@jjinja.duckdns.org "sudo bash /opt/jjinja/deploy/update.sh"
```

A restart drops matches in progress, so update when it's quiet.

## Handy commands (on the server)

| What | Command |
|---|---|
| Is the game running? | `systemctl status jjinja` |
| Live game logs | `journalctl -u jjinja -f` |
| Player reports | `journalctl -u jjinja \| grep "\[report\]"` |
| Restart the game | `systemctl restart jjinja` |
| HTTPS / Caddy logs | `journalctl -u caddy -n 50` |
| Video relay logs | `journalctl -u coturn -n 50` |

## Troubleshooting

- **The site doesn't load:** check that DuckDNS shows the right IP (`ping jjinja.duckdns.org` should show it). Then check `journalctl -u caddy -n 50` for certificate errors. Ports 80 and 443 must be reachable, and some providers have their own firewall in the dashboard, so allow them there too.
- **The game page loads but says "Disconnected":** run `journalctl -u jjinja -n 50`.
- **Video never connects for some players:** the relay needs UDP/TCP `3478` and UDP `49160–49200` open, including in any provider-level firewall.
- **Out of memory during setup:** the script adds 1 GB of swap, but you can re-run `sudo bash setup.sh <domain>` safely.
