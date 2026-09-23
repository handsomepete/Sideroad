# Deploying Sideroad

One small Linux VPS (Ubuntu 24.04 assumed): Caddy for HTTPS, Postgres, and the app as a
systemd service running as the non-root `sideroad` user. 1 vCPU / 1 GB RAM is plenty for Phase 1.

## 1. Server packages (as root)

```bash
apt update && apt upgrade -y
apt install -y postgresql caddy git ufw
# Node 22 LTS from NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs

ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw enable
```

## 2. User, directories, database

```bash
adduser --system --group --home /opt/sideroad sideroad
mkdir -p /var/lib/sideroad/uploads /var/backups/sideroad
chown -R sideroad:sideroad /var/lib/sideroad /var/backups/sideroad
chmod 750 /var/lib/sideroad /var/lib/sideroad/uploads

# Postgres role that matches the Linux user (peer auth over the local socket, no password needed)
sudo -u postgres createuser sideroad
sudo -u postgres createdb -O sideroad sideroad
```

## 3. Code and build (as sideroad)

```bash
sudo -u sideroad -H bash
cd /opt/sideroad
git clone https://github.com/handsomepete/sideroad.git .
npm ci && npm run build && npm prune --omit=dev
```

## 4. Secrets: `.env`

```bash
cp .env.example .env && chmod 600 .env
npm run hash-password        # needs dev deps; or run on your laptop and paste the result
nano .env
```

Production values:

| Key | Value |
|---|---|
| `NODE_ENV` | `production` |
| `PUBLIC_BASE_URL` | `https://your-domain` (exactly, no trailing slash) |
| `TRUST_PROXY` | `true` |
| `DATABASE_URL` | `postgres://sideroad@/sideroad?host=/var/run/postgresql` |
| `UPLOAD_DIR` | `/var/lib/sideroad/uploads` |
| `SESSION_SECRET` | `openssl rand -base64 48` |

Twilio, SMTP and admin email as in `.env.example`. `.env` is gitignored; never copy it into the unit file.

## 5. Migrate and start

```bash
npm run migrate                                   # as sideroad
exit
cp /opt/sideroad/deploy/sideroad.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now sideroad
systemctl status sideroad && journalctl -u sideroad -f
```

## 6. HTTPS

Point the domain's A record at the server, then:

```bash
cp /opt/sideroad/deploy/Caddyfile /etc/caddy/Caddyfile   # edit the domain first
systemctl reload caddy
curl https://your-domain/healthz
```

## 7. Twilio

In the Twilio console, on the Canadian number's configuration:

- **A message comes in**: Webhook, `https://your-domain/webhooks/twilio/sms`, HTTP POST.
- Leave Twilio's default opt-out handling (STOP/START) on. Twilio blocks texts to opted-out numbers at
  its end too; the app records STOP/START and blocks sending from the dashboard.

Delivery receipts go to `/webhooks/twilio/status` automatically (the app sets it on each send).
Every webhook call is checked against Twilio's signature using `PUBLIC_BASE_URL`, so that value must
match the URL configured in Twilio exactly.

## 8. Backups

```bash
sudo -u sideroad crontab -e
# 15 3 * * * /opt/sideroad/deploy/backup.sh
```

Test a restore once: `pg_restore --clean --dbname=sideroad /var/backups/sideroad/db-XXXX.dump`.

## Updating

```bash
sudo -u sideroad -H bash -c 'cd /opt/sideroad && git pull && npm ci && npm run build && npm prune --omit=dev && npm run migrate'
systemctl restart sideroad
```
