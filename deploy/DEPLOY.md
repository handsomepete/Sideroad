# Deploying Sideroad on the shared Hetzner server

Sideroad runs on the Hetzner server that already hosts Nox. Because it takes public form input and
holds customer data, it runs fenced off from everything else on the server:

- its own Linux user (`sideroad`) with no sudo, its own copy of Node, and its own Postgres database,
  reached only over a Unix socket, so nothing new listens on a network port
- the app itself listens on a Unix socket that only the web server can use
- systemd blocks it from seeing other processes, reading `/root`, `/home`, `/var/www` or Docker, and from
  connecting to anything on localhost, private networks or Docker (so it can't reach Nox's Redis,
  Postgres or MCP server), while still allowing outbound calls to Twilio and SMTP

Layout on the server:

```
/opt/sideroad/app      the code (git clone) and .env
/opt/sideroad/node     Node 22 for Sideroad only (the system Node and pm2 apps are untouched)
/var/lib/sideroad      uploaded photos
/var/backups/sideroad  nightly backups
/run/sideroad          the app's socket (created by systemd)
```

All commands run as root unless shown with `sudo -u sideroad`.

## 0. Look before touching anything

Copy `deploy/preflight.sh` to the server (the repo is private, so `scp deploy/preflight.sh root@server:`)
and run it:

```bash
sudo bash preflight.sh
```

It changes nothing. It shows the OS, which web server is in front (nginx, Caddy or a Cloudflare
tunnel), the listening ports and Docker containers. Read the **Warnings** section: if it lists
5432, 6379, 3848 or 8000 as exposed, one of Nox's services is reachable from the internet. That's worth
fixing whether or not Sideroad goes here (see the last section).

## 1. Domain

Point the domain's A (and AAAA) record at the server. If the server uses a Hetzner Cloud Firewall,
make sure it allows inbound 80 and 443.

## 2. User and directories

```bash
adduser --system --group --home /opt/sideroad --shell /usr/sbin/nologin sideroad
mkdir -p /opt/sideroad/app /var/lib/sideroad/uploads /var/backups/sideroad
chown -R sideroad:sideroad /opt/sideroad /var/lib/sideroad /var/backups/sideroad
chmod 750 /opt/sideroad /var/lib/sideroad /var/lib/sideroad/uploads /var/backups/sideroad
```

## 3. Postgres (socket only, no TCP port)

If preflight showed **no** host Postgres (Nox's runs in Docker, which is fine to leave alone):

```bash
apt install -y postgresql
# Unix socket only: no TCP listener, so no clash with a Docker Postgres on 5432 and nothing exposed.
sed -i "s/^#\?listen_addresses.*/listen_addresses = ''/" /etc/postgresql/*/main/postgresql.conf
systemctl restart postgresql
```

Either way, create the role and database. Peer authentication means the `sideroad` Linux user can reach
only its own database and needs no password:

```bash
sudo -u postgres createuser sideroad
sudo -u postgres createdb -O sideroad sideroad
```

## 4. Node 22, for Sideroad only

```bash
cd /opt/sideroad
ARCH=$(uname -m | sed 's/x86_64/x64/; s/aarch64/arm64/')
BASE=https://nodejs.org/dist/latest-v22.x
curl -fsSLO $BASE/SHASUMS256.txt
FILE=$(grep -o "node-v22[^ ]*-linux-$ARCH.tar.xz" SHASUMS256.txt)
curl -fsSLO $BASE/$FILE && grep " $FILE\$" SHASUMS256.txt | sha256sum -c -
mkdir -p node && tar -xJf $FILE -C node --strip-components=1 && rm $FILE SHASUMS256.txt
chown -R root:root node && chmod -R go-w node    # sideroad can run it but not change it
/opt/sideroad/node/bin/node -v
```

## 5. Code and build

The repo is private. Either add a read-only GitHub deploy key for the `sideroad` user, or clone on your
laptop and `rsync` the folder to `/opt/sideroad/app` (then `chown -R sideroad:sideroad /opt/sideroad/app`).
With a deploy key:

```bash
sudo -u sideroad -H bash -c '
  export PATH=/opt/sideroad/node/bin:$PATH
  cd /opt/sideroad/app
  git clone git@github.com:handsomepete/sideroad.git .
  npm ci && npm run build'
```

## 6. Secrets: `.env`

```bash
sudo -u sideroad -H bash -c 'cd /opt/sideroad/app && cp .env.example .env && chmod 600 .env'
sudo -u sideroad -H bash -c 'cd /opt/sideroad/app && PATH=/opt/sideroad/node/bin:$PATH npm run hash-password'
nano /opt/sideroad/app/.env
```

| Key | Value |
|---|---|
| `NODE_ENV` | `production` |
| `SOCKET_PATH` | `/run/sideroad/sideroad.sock` |
| `PUBLIC_BASE_URL` | `https://your-domain` (exactly, no trailing slash) |
| `TRUST_PROXY` | `1` (one proxy in front: Caddy, nginx or cloudflared) |
| `DATABASE_URL` | `postgres://sideroad@/sideroad?host=/var/run/postgresql` |
| `UPLOAD_DIR` | `/var/lib/sideroad/uploads` |
| `SESSION_SECRET` | output of `openssl rand -base64 48` |
| `ADMIN_PASSWORD_HASH` | from `npm run hash-password`, in single quotes |

Plus the Twilio, SMTP and alert-email values described in `.env.example`. Both groups are optional:
leave them blank to go live with just the web forms and add them later (then `systemctl restart sideroad`). Then set up the database and
drop the dev tools:

```bash
sudo -u sideroad -H bash -c 'cd /opt/sideroad/app && PATH=/opt/sideroad/node/bin:$PATH npm run migrate && PATH=/opt/sideroad/node/bin:$PATH npm prune --omit=dev'
```

## 7. Service

```bash
cp /opt/sideroad/app/deploy/sideroad.service /etc/systemd/system/
# Also block Sideroad from this server's own public addresses (where Docker-published ports live):
mkdir -p /etc/systemd/system/sideroad.service.d
printf '[Service]\nIPAddressDeny=%s\n' "$(hostname -I)" > /etc/systemd/system/sideroad.service.d/server-ip.conf
systemctl daemon-reload && systemctl enable --now sideroad
systemctl status sideroad --no-pager
curl -s --unix-socket /run/sideroad/sideroad.sock http://localhost/healthz    # {"ok":true}
```

If preflight showed a DNS resolver on a private or loopback address other than `127.0.0.53`, add it to
`IPAddressAllow=` in the drop-in. Public resolvers such as Hetzner's need nothing.

## 8. Web server

Use whichever one preflight showed is already running. Don't install a second one on ports 80/443.

**Caddy:** append `deploy/Caddyfile` (with your domain) to `/etc/caddy/Caddyfile`, then

```bash
usermod -aG sideroad caddy && systemctl restart caddy
```

**nginx:**

```bash
cp /opt/sideroad/app/deploy/nginx-sideroad.conf /etc/nginx/sites-available/sideroad   # edit the domain
ln -s /etc/nginx/sites-available/sideroad /etc/nginx/sites-enabled/
usermod -aG sideroad www-data
nginx -t && systemctl restart nginx
apt install -y certbot python3-certbot-nginx && certbot --nginx -d your-domain
```

**Cloudflare tunnel:** add an ingress rule with `hostname: your-domain` and
`service: unix:/run/sideroad/sideroad.sock`, then add the `cloudflared` user to the `sideroad` group.

**Nothing yet:** `apt install -y caddy` and follow the Caddy steps.

Then check `curl https://your-domain/healthz`.

## 9. Check the fence

```bash
systemd-analyze security sideroad --no-pager | tail -1
systemctl show sideroad -p IPAddressDeny -p ProtectProc -p InaccessiblePaths
```

## 10. Twilio

On the Canadian number's configuration in the Twilio console:

- **A message comes in**: Webhook, `https://your-domain/webhooks/twilio/sms`, HTTP POST.
- Leave Twilio's default STOP/START handling on as a second layer.

Delivery receipts go to `/webhooks/twilio/status` automatically. Webhooks are verified against
`PUBLIC_BASE_URL`, so it must match the URL in Twilio exactly.

## 11. Backups

```bash
sudo -u sideroad crontab -e
# 15 3 * * * /opt/sideroad/app/deploy/backup.sh
```

Test a restore once: `pg_restore --clean --dbname=sideroad /var/backups/sideroad/db-XXXX.dump`.
Copy backups off the server as well.

## Updating

```bash
sudo -u sideroad -H bash -c '
  export PATH=/opt/sideroad/node/bin:$PATH
  cd /opt/sideroad/app && git pull && npm ci && npm run build && npm run migrate && npm prune --omit=dev'
systemctl restart sideroad
```

## Separate from Sideroad: Nox's published ports

The `precheckmd` repo's `docker-compose.yml` publishes Postgres (`5432`, password `nox`) and Redis
(`6379`, no password) on all interfaces. Docker writes its own firewall rules, so `ufw` does **not**
block these. If preflight flags them as exposed, bind them to localhost in that compose file
(`"127.0.0.1:5432:5432"`, `"127.0.0.1:6379:6379"`) and recreate the containers. A Hetzner Cloud Firewall,
which sits outside the server, blocks them too.
