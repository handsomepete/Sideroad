#!/usr/bin/env bash
# Read-only look at the server before installing Sideroad next to what's already running.
# Changes nothing and prints no secrets. Run as root:  sudo bash preflight.sh
set -uo pipefail
hr() { printf '\n== %s ==\n' "$1"; }

hr "System"
. /etc/os-release 2>/dev/null && echo "OS: $PRETTY_NAME"
echo "Arch: $(uname -m)"
free -h | sed -n '1,2p'
df -h / | tail -1
echo "Server IPs: $(hostname -I)"

hr "Node"
echo "System node: $(command -v node >/dev/null && node -v || echo none)"
echo "pm2: $(command -v pm2 || echo none)"

hr "Web front door"
for s in nginx caddy apache2 cloudflared; do printf '%-12s %s\n' "$s" "$(systemctl is-active "$s" 2>/dev/null)"; done
ls /etc/nginx/sites-enabled/ 2>/dev/null | sed 's/^/nginx site: /'
[ -f /etc/caddy/Caddyfile ] && grep -E '^[^#[:space:]].*\{' /etc/caddy/Caddyfile | sed 's/^/caddy site: /'

hr "Listening ports (0.0.0.0 / [::] / * = reachable from outside unless a firewall blocks it)"
command -v ss >/dev/null || echo "ss not found (apt install iproute2)"
ss -tlnpH 2>/dev/null | awk '{print $4, $6}' | sort -u

hr "Docker"
if command -v docker >/dev/null; then docker ps --format '{{.Names}}  {{.Image}}  {{.Ports}}'; else echo "no docker"; fi

hr "Firewall"
ufw status 2>/dev/null | head -20 || echo "ufw not installed"

hr "Postgres on the host"
echo "psql: $(command -v psql || echo none)   service: $(systemctl is-active postgresql 2>/dev/null)"

hr "DNS resolvers"
grep -E '^nameserver' /etc/resolv.conf

hr "Existing sideroad user"
id sideroad 2>/dev/null || echo "none yet"

hr "Warnings"
ss -tlnH | awk '{print $4}' | grep -E '^(0\.0\.0\.0|\*|\[::\]):(5432|6379|3848|8000)$' \
  | sed 's/^/EXPOSED: /; s/$/  (database, Redis or MCP port open to all interfaces; Docker-published ports bypass ufw)/'
echo "done"
