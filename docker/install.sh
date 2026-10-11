#!/usr/bin/env bash
# One-command install of LomoAgent (Docker) on a Linux machine:
#
#   curl -fsSL https://raw.githubusercontent.com/lomorage/lomoagent/main/docker/install.sh | bash
#
# Installs Docker if it is missing, writes docker-compose.yml + .env into LOMO_DIR, pulls the
# image, starts it, and prints the address to open and the first account's password. Running
# it again upgrades to the latest image and keeps all photos and data.
#
# Settings (environment variables, all optional), e.g.
#   curl -fsSL .../install.sh | LOMO_PHOTOS_DIR=/mnt/disk/photos bash
#
#   LOMO_DIR             install directory (compose file, data)    default: ~/lomo
#   LOMO_PHOTOS_DIR      where photos are stored                    default: $LOMO_DIR/photos
#   LOMO_DATA_DIR        database, logs, settings                   default: $LOMO_DIR/data
#   LOMO_ADMIN_USER      first account's user name                  default: admin
#   LOMO_ADMIN_PASSWORD  first account's password        default: chosen on the first web visit
#   LOMO_IMAGE           image to run          default: ghcr.io/lomorage/lomo-photo-viewer:test
#   TZ                   time zone for photo dates                  default: this machine's
#   LOMO_WEB_PORT        web app port                               default: 3001
#   LOMO_LOMOD_PORT      lomod port (Lomorage mobile apps)          default: 8000
#   LOMO_WEBDAV_PORT     lomod WebDAV port                          default: 8004
#   LOMO_SKIP_DOCKER_INSTALL=1   fail instead of installing Docker when it is missing
#
# The first account is created on the first start only; changing LOMO_ADMIN_* later has no effect.
# On a re-run, settings not given again are kept from the previous install's $LOMO_DIR/.env.
# A default port that is already taken is replaced by a free one (and reported); a port you set
# yourself that is taken is an error.
set -euo pipefail

# Ports given explicitly by the user (as opposed to defaults or values kept from .env)
explicit_ports=" "
for key in LOMO_WEB_PORT LOMO_LOMOD_PORT LOMO_WEBDAV_PORT; do
  [ -n "${!key:-}" ] && explicit_ports+="$key "
done

LOMO_DIR="${LOMO_DIR:-$HOME/lomo}"
if [ -f "$LOMO_DIR/.env" ]; then
  [ -r "$LOMO_DIR/.env" ] || { echo "ERROR: cannot read $LOMO_DIR/.env (installed as another user? run this as that user)" >&2; exit 1; }
  while IFS='=' read -r key value; do
    case "$key" in
      LOMO_IMAGE|LOMO_PHOTOS_DIR|LOMO_DATA_DIR|LOMO_ADMIN_USER|LOMO_ADMIN_PASSWORD|TZ|LOMO_WEB_PORT|LOMO_LOMOD_PORT|LOMO_WEBDAV_PORT)
        [ -n "${!key:-}" ] || printf -v "$key" '%s' "$value" ;;
    esac
  done < "$LOMO_DIR/.env"
fi
LOMO_IMAGE="${LOMO_IMAGE:-ghcr.io/lomorage/lomo-photo-viewer:test}"
LOMO_PHOTOS_DIR="${LOMO_PHOTOS_DIR:-$LOMO_DIR/photos}"
LOMO_DATA_DIR="${LOMO_DATA_DIR:-$LOMO_DIR/data}"
LOMO_ADMIN_USER="${LOMO_ADMIN_USER:-admin}"
LOMO_ADMIN_PASSWORD="${LOMO_ADMIN_PASSWORD:-}"
LOMO_WEB_PORT="${LOMO_WEB_PORT:-3001}"
LOMO_LOMOD_PORT="${LOMO_LOMOD_PORT:-8000}"
LOMO_WEBDAV_PORT="${LOMO_WEBDAV_PORT:-8004}"
CONTAINER=lomo-photo-viewer

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWARN:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# ---- checks ----
[ "$(uname -s)" = Linux ] || die "this installer is for Linux (found $(uname -s))"
case "$(uname -m)" in
  x86_64|amd64) ;;
  *) die "the image is built for x86_64 (amd64) only; this machine is $(uname -m)" ;;
esac
command -v curl >/dev/null || die "curl is required"

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null && SUDO="sudo"
fi

# ---- Docker ----
if ! command -v docker >/dev/null; then
  [ "${LOMO_SKIP_DOCKER_INSTALL:-}" = 1 ] && die "Docker is not installed (LOMO_SKIP_DOCKER_INSTALL=1)"
  [ "$(id -u)" -eq 0 ] || [ -n "$SUDO" ] || die "Docker is not installed and installing it needs root or sudo"
  say "Docker not found; installing it with the official script (https://get.docker.com)"
  curl -fsSL https://get.docker.com | $SUDO sh
  $SUDO systemctl enable --now docker >/dev/null 2>&1 || true
fi

DOCKER="docker"
if ! docker info >/dev/null 2>&1; then
  if [ -n "$SUDO" ] && $SUDO docker info >/dev/null 2>&1; then
    DOCKER="$SUDO docker"
  else
    die "cannot talk to the Docker daemon; is it running? (try: sudo systemctl start docker)"
  fi
fi
COMPOSE=""
if $DOCKER compose version >/dev/null 2>&1; then
  COMPOSE="$DOCKER compose"
fi

# ---- ports (the container uses host networking, so they are this machine's ports) ----
# Something accepts connections on the port (bash's /dev/tcp, so no ss/netstat needed)
port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

# On a re-run our own container holds the ports (kept from .env), so only check a new install.
existing=$($DOCKER ps -aq -f "name=^${CONTAINER}$" || true)
taken=" "
for key in LOMO_WEB_PORT LOMO_LOMOD_PORT LOMO_WEBDAV_PORT; do
  port="${!key}"
  if [ -z "$existing" ] && port_busy "$port"; then
    what="another program"
    curl -fs -o /dev/null --max-time 2 "http://127.0.0.1:$port/status" 2>/dev/null && what="another program (it answers like a Lomorage server, lomod)"
    case "$explicit_ports" in
      *" $key "*) die "port $port ($key) is already used by $what; choose another, e.g. $key=$((port + 10))" ;;
    esac
    next=$((port + 1))
    while port_busy "$next" || [[ "$taken" == *" $next "* ]]; do next=$((next + 1)); done
    warn "port $port is already used by $what; using $next instead ($key=$next)"
    printf -v "$key" '%s' "$next"
  fi
  taken+="${!key} "
done
WEB_PORT="$LOMO_WEB_PORT"
LOMOD_PORT="$LOMO_LOMOD_PORT"

# ---- configuration ----
if [ -z "${TZ:-}" ]; then
  TZ=$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || true)
  TZ="${TZ:-Etc/UTC}"
fi

say "Installing into $LOMO_DIR"
mkdir -p "$LOMO_DIR" "$LOMO_PHOTOS_DIR" "$LOMO_DATA_DIR"
cd "$LOMO_DIR"

# .env keeps the settings (and the password, if one was given) out of the compose file
umask 077
cat > .env <<EOF
LOMO_IMAGE=$LOMO_IMAGE
LOMO_PHOTOS_DIR=$LOMO_PHOTOS_DIR
LOMO_DATA_DIR=$LOMO_DATA_DIR
LOMO_ADMIN_USER=$LOMO_ADMIN_USER
LOMO_ADMIN_PASSWORD=$LOMO_ADMIN_PASSWORD
TZ=$TZ
LOMO_WEB_PORT=$LOMO_WEB_PORT
LOMO_LOMOD_PORT=$LOMO_LOMOD_PORT
LOMO_WEBDAV_PORT=$LOMO_WEBDAV_PORT
EOF
umask 022

cat > docker-compose.yml <<'EOF'
# Written by docker/install.sh -- settings are in .env next to this file.
# Manage with: docker compose ps | logs | restart | down ; upgrade: docker compose pull && docker compose up -d
services:
  lomo:
    image: ${LOMO_IMAGE}
    container_name: lomo-photo-viewer
    restart: unless-stopped
    # Host networking: reachable at this machine's LAN IP on the ports below, discoverable by
    # the Lomorage mobile app, and the addresses it shows are real.
    network_mode: host
    environment:
      LOMO_ADMIN_USER: ${LOMO_ADMIN_USER}
      LOMO_ADMIN_PASSWORD: ${LOMO_ADMIN_PASSWORD}
      TZ: ${TZ}
      WEB_PORT: ${LOMO_WEB_PORT}
      LOMOD_PORT: ${LOMO_LOMOD_PORT}
      WEBDAV_PORT: ${LOMO_WEBDAV_PORT}
    volumes:
      - ${LOMO_PHOTOS_DIR}:/photos
      - ${LOMO_DATA_DIR}:/data
EOF

# ---- pull and start ----
say "Pulling $LOMO_IMAGE"
if ! $DOCKER pull "$LOMO_IMAGE"; then
  $DOCKER image inspect "$LOMO_IMAGE" >/dev/null 2>&1 || die "could not pull $LOMO_IMAGE"
  warn "pull failed; using the copy of $LOMO_IMAGE already on this machine"
fi

say "Starting the container"
if [ -n "$COMPOSE" ]; then
  $COMPOSE up -d --force-recreate
else
  # No compose plugin: the same thing with plain docker run
  [ -n "$existing" ] && $DOCKER rm -f "$CONTAINER" >/dev/null
  $DOCKER run -d --name "$CONTAINER" --restart unless-stopped --network host \
    -e LOMO_ADMIN_USER="$LOMO_ADMIN_USER" -e LOMO_ADMIN_PASSWORD="$LOMO_ADMIN_PASSWORD" -e TZ="$TZ" \
    -e WEB_PORT="$LOMO_WEB_PORT" -e LOMOD_PORT="$LOMO_LOMOD_PORT" -e WEBDAV_PORT="$LOMO_WEBDAV_PORT" \
    -v "$LOMO_PHOTOS_DIR:/photos" -v "$LOMO_DATA_DIR:/data" "$LOMO_IMAGE" >/dev/null
fi

say "Waiting for it to come up"
for _ in $(seq 1 120); do
  curl -fs -o /dev/null "http://127.0.0.1:$WEB_PORT/" && curl -fs -o /dev/null "http://127.0.0.1:$LOMOD_PORT/status" && break
  [ "$($DOCKER inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" = true ] || { $DOCKER logs --tail 50 "$CONTAINER" >&2 || true; die "the container stopped; log above"; }
  sleep 1
done
curl -fs -o /dev/null "http://127.0.0.1:$WEB_PORT/" || { $DOCKER logs --tail 50 "$CONTAINER" >&2 || true; die "not up after 2 minutes; log above"; }

# ---- tell the user how to use it ----
ips=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+(\.[0-9]+){3}$' | grep -vE '^(127\.|172\.(1[7-9]|2[0-9]|3[01])\.)' || true)
[ -n "$ips" ] || ips="<this-machine-ip>"

# The first account (files in /data are root-owned, so read them through the container)
account=""
if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$LOMOD_PORT/welcome")" = 200 ]; then
  # lomod has no account yet: the web app asks for its password on the first visit
  account="user: $LOMO_ADMIN_USER   password: open the web app; the first visit asks you to choose it"
elif $DOCKER exec "$CONTAINER" grep -q '"existing":true' /data/.admin-initialized 2>/dev/null; then
  account="existing data: sign in with your existing account"
elif generated=$($DOCKER exec "$CONTAINER" cat /data/admin-password.txt 2>/dev/null); then
  # generated by an earlier version of the image
  account=$(printf '%s\n' "$generated" | paste -sd' ' | awk '{print "user: " $1 "   password: " $2}')
  account="$account   (also in $LOMO_DATA_DIR/admin-password.txt)"
elif [ -n "$LOMO_ADMIN_PASSWORD" ]; then
  account="user: $LOMO_ADMIN_USER   password: the LOMO_ADMIN_PASSWORD you set"
else
  account="user: $LOMO_ADMIN_USER   password: the one chosen on the first visit"
fi

echo
echo "  LomoAgent is running."
echo
for ip in $ips; do
  echo "  Web app (computer or phone browser):  http://$ip:$WEB_PORT"
  echo "  Lomorage mobile app server address:   http://$ip:$LOMOD_PORT"
done
[ -n "$account" ] && echo "  Account:  $account"
echo
echo "  Photos:   $LOMO_PHOTOS_DIR"
echo "  Data:     $LOMO_DATA_DIR"
if [ -n "$COMPOSE" ]; then
  echo "  Manage:   cd $LOMO_DIR && $COMPOSE logs | restart | down"
else
  echo "  Manage:   $DOCKER logs | restart | stop $CONTAINER"
fi
echo "  Upgrade:  run this installer again"
if command -v ufw >/dev/null && $SUDO ufw status 2>/dev/null | grep -q 'Status: active'; then
  echo
  warn "ufw firewall is active; to allow other devices: sudo ufw allow $WEB_PORT/tcp && sudo ufw allow $LOMOD_PORT/tcp"
fi
echo
