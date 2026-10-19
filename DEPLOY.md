# Deploying Jjinja Battle

This puts the game online with a free DuckDNS subdomain and automatic HTTPS. There are two hosting options. Both use the same setup script, so you can start free and move later.

- **Option A: Oracle Cloud Always Free ($0).** The recommended place to start. A real server that doesn't expire.
- **Option B: a ~$5/month VPS** (Vultr, DigitalOcean, Hetzner, …). Simpler and more predictable; move here when you outgrow A.

What you end up with either way:

- `https://<your-name>.duckdns.org` serving the game
- **Caddy**: HTTPS certificates that renew themselves
- **coturn**: a video relay for players on strict networks (school, office, some mobile data)
- **systemd**: restarts the game if it crashes or the server reboots
- **Firewall and automatic security updates**: turned on

Plan for about 30–45 minutes, most of it waiting.

## 1. Create an SSH key on your PC (once)

An SSH key lets you log in to the server without a password. In **PowerShell**:

```powershell
ssh-keygen -t ed25519 -C "jjinja-server"
```

Press Enter to accept the default location, and pick a passphrase you'll remember. Then print the **public** half (safe to share) and copy it:

```powershell
Get-Content $env:USERPROFILE\.ssh\id_ed25519.pub
```

It's one line starting with `ssh-ed25519`. Never share the other file, `id_ed25519` without `.pub`.

---

## Option A: Oracle Cloud Always Free

### A1. Sign up

1. Go to **oracle.com/cloud/free** and click **Start for free**.
2. Fill in your details and verify your email and phone.
3. **Choose your Home Region carefully: it can't be changed later.** Pick one close to most of your players (for Korea and East Asia: Seoul, Chuncheon, Tokyo, Osaka or Singapore). Free ARM servers are sometimes sold out in popular regions, which is the main trade-off.
4. Add a card for **identity verification** (prepaid and virtual cards are often rejected). Oracle may place a small temporary hold. **An Always Free account can't be charged** unless you click "Upgrade to Pay As You Go" yourself.
5. Wait for the email saying your account is ready (from a few minutes to a few hours), then sign in.
6. **Turn on two-factor authentication** for the account (your profile → Security), so nobody else can use it.

### A2. Create the server

1. Open the menu (☰) → **Compute → Instances → Create instance**.
2. **Name:** `jjinja`.
3. Under **Image and shape**:
   - **Image → Change image → Ubuntu → Canonical Ubuntu 24.04**.
   - **Shape → Change shape → Ampere → VM.Standard.A1.Flex**. Set **2 OCPUs and 12 GB memory**; the free allowance is 4 OCPUs and 24 GB in total. Check that it says **Always Free-eligible**.
4. Under **Networking**: let it **create a new virtual cloud network** and **public subnet**, and keep **Assign a public IPv4 address** on.
5. Under **Add SSH keys**: choose **Paste public keys** and paste your `ssh-ed25519 …` line.
6. Leave the boot volume at its default size and click **Create**.
7. When the instance shows **Running**, copy its **Public IP address**.

**"Out of capacity" error?** This is common for the free ARM servers. Try, in this order:

- pick a different **availability domain** (if your region has more than one),
- try a smaller shape (1 OCPU, 6 GB), which is plenty for this game,
- try again at a different time of day,
- or use the always-available free **VM.Standard.E2.1.Micro** shape (AMD, 1 GB RAM). It's small, but the setup script adds swap, and it's enough for a small player base.

### A3. Open the ports in Oracle's firewall

Oracle has a firewall in its dashboard (the "Security List") that blocks everything except SSH. The setup script handles the firewall **inside** the server, but this one has to be done here.

1. Open your instance → under **Instance details** click the **Virtual cloud network** → **Subnets** (or **Security**) → your public subnet → **Default Security List for …**.
2. Click **Add Ingress Rules** and add these rules, each with **Source CIDR** `0.0.0.0/0` and **Stateless** unticked:

| IP protocol | Destination port range | For |
|---|---|---|
| TCP | `80` | HTTPS certificate checks |
| TCP | `443` | the website |
| UDP | `443` | faster HTTPS (HTTP/3) |
| TCP | `3478` | video relay |
| UDP | `3478` | video relay |
| UDP | `49160-49200` | video relay |

### A4. Point a free subdomain at it (DuckDNS)

1. Go to duckdns.org and sign in with GitHub or Google.
2. Type a subdomain (e.g. `jjinja`) and click **add domain**.
3. Put the server's public IP in **current ip** and click **update ip**.

### A5. Run the setup script

Log in. On Oracle the user is **`ubuntu`**, not root. Answer `yes` to the fingerprint question the first time:

```powershell
ssh ubuntu@203.0.113.45
```

On the server, with your own domain:

```bash
curl -fsSL https://raw.githubusercontent.com/ChinhQuy29/jjinja_battle/main/deploy/setup.sh -o setup.sh
sudo bash setup.sh jjinja.duckdns.org
```

When it prints **All set!**, open `https://jjinja.duckdns.org`. The first visit can take a few extra seconds while Caddy gets the HTTPS certificate.

### Oracle's idle-instance rule

Oracle may **reclaim Always Free servers that look idle for 7 days** (very low CPU, network and memory use). Early on, with few players, that can happen. Your options:

- **Accept it.** If it's reclaimed, create a new instance (A2–A3), update the IP in DuckDNS (A4) and run the setup again (A5). That's about 20 minutes, and nothing is lost because the game keeps no saved data.
- **Upgrade the account to Pay As You Go.** Always Free resources stay free and are no longer reclaimed for being idle. The catch is that your card *can* then be charged if you create something that isn't free, so set a **budget alert** (Billing → Budgets, e.g. $1) right away.

Don't run fake "keep busy" scripts to dodge the rule. It goes against Oracle's terms and can get the account closed.

---

## Option B: a ~$5/month VPS

Use this when you outgrow Oracle or want something more predictable. Vultr is used below because its $5 plan has 1 GB RAM and data centers worldwide, including Seoul, Tokyo and Singapore. DigitalOcean, Linode/Akamai and Hetzner work the same way. Prices change, so check before you buy.

1. Sign up at vultr.com, verify your email, and **turn on two-factor authentication**. Adding a payment method is between you and Vultr.
2. Go to **Account → SSH Keys → Add SSH Key** and paste the `ssh-ed25519 …` line.
3. Click **Deploy**:
   - **Type:** Cloud Compute, Shared CPU, Regular
   - **Location:** closest to most of your players
   - **Image:** Ubuntu **24.04 LTS** x64
   - **Plan:** the $5/month one (1 vCPU, 1 GB RAM)
   - **SSH Keys:** tick yours
   - Untick auto backups and paid add-ons
4. Copy the server's IPv4 address and point DuckDNS at it (same as A4).
5. Log in with `ssh root@<ip>` and run the same two commands as in A5.

Moving from Oracle to a VPS later: run the setup on the new server, change the IP in DuckDNS, and delete the old server.

---

## Updating the live game

After you push changes to GitHub, run this from PowerShell (use `root@` instead of `ubuntu@` on a VPS):

```powershell
ssh ubuntu@jjinja.duckdns.org "sudo bash /opt/jjinja/deploy/update.sh"
```

A restart drops matches in progress, so update when it's quiet.

## Handy commands (on the server, with `sudo`)

| What | Command |
|---|---|
| Is the game running? | `systemctl status jjinja` |
| Live game logs | `journalctl -u jjinja -f` |
| Player reports | `journalctl -u jjinja \| grep "\[report\]"` |
| Restart the game | `systemctl restart jjinja` |
| HTTPS / Caddy logs | `journalctl -u caddy -n 50` |
| Video relay logs | `journalctl -u coturn -n 50` |

## Troubleshooting

- **The site doesn't load:** check that `ping jjinja.duckdns.org` shows your server's IP. On Oracle, check the Security List rules (A3). Then look at `journalctl -u caddy -n 50` for certificate errors, which happen when port 80 or 443 is blocked.
- **The page loads but says "Disconnected":** run `journalctl -u jjinja -n 50`.
- **Video never connects for some players:** the relay needs TCP/UDP `3478` and UDP `49160–49200` open, in Oracle's Security List or your provider's firewall.
- **Setup failed halfway:** fix the cause and run `sudo bash setup.sh <domain>` again. It's safe to re-run.

## Private repository

The script downloads the code from GitHub, which only works without extra steps while the repository is **public**. If you make it private:

1. On the server: `sudo ssh-keygen -t ed25519 -f /root/.ssh/jjinja_deploy -N ""` then `sudo cat /root/.ssh/jjinja_deploy.pub`
2. On GitHub: **repo → Settings → Deploy keys → Add deploy key**, paste the key, read-only.
3. On the server:
   ```bash
   printf 'Host github.com\n  IdentityFile /root/.ssh/jjinja_deploy\n' | sudo tee -a /root/.ssh/config
   sudo git clone git@github.com:ChinhQuy29/jjinja_battle.git /opt/jjinja
   sudo cp /opt/jjinja/deploy/setup.sh . && sudo bash setup.sh jjinja.duckdns.org
   ```
   `update.sh` pulls as the `jjinja` user, so give that user the key too, or run `sudo git -C /opt/jjinja pull` before `update.sh`.
