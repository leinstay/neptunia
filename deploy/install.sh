#!/usr/bin/env bash
# Prepares a server for neptunia-bot with the private files kept out of the checkout (the layout
# of deploy/neptunia-bot.service):
#   /etc/neptunia       NEPTUNIA_PRIVATE_DIR: .env, config.local.json, prompts.local/
#   /var/lib/neptunia   NEPTUNIA_DATA_DIR: everything the bot writes (its memory)
#
# Usage:     sudo deploy/install.sh [--user NAME] [--prefix DIR] [--dry-run]
#   --user NAME   the service user (default neptunia-bot): a system user, no login, no home
#   --prefix DIR  the checkout the service runs from (default: the checkout holding this script)
#   --dry-run     print the commands only; change nothing (needs no root)
#
# What it does, every step safe to repeat:
#   - creates the service user (and its group) when absent;
#   - creates /etc/neptunia (root:root 755) with .env copied from .env.example when absent
#     (root:<user> 640), prompts.local/ (<user> 750) and config.local.json ({} when absent,
#     <user> 640); an existing file is never overwritten;
#   - creates /var/lib/neptunia (<user>:<user> 750);
#   - installs deploy/neptunia-bot.service into /etc/systemd/system/ with User=, Group= and
#     WorkingDirectory= set to the given user and checkout, then runs systemctl daemon-reload.
# It never starts or enables the service: fill in the private files first (it prints which).

set -euo pipefail

PRIVATE_DIR=/etc/neptunia
DATA_DIR=/var/lib/neptunia
UNIT_NAME=neptunia-bot.service
UNIT_DIR=/etc/systemd/system

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
SERVICE_USER=neptunia-bot
PREFIX=$(cd -- "$SCRIPT_DIR/.." && pwd -P)
DRY_RUN=0

usage() {
  echo "usage: sudo deploy/install.sh [--user NAME] [--prefix DIR] [--dry-run]" >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --user) [ $# -ge 2 ] || usage; SERVICE_USER=$2; shift 2 ;;
    --prefix) [ $# -ge 2 ] || usage; PREFIX=$2; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage ;;
    *) echo "install: unknown argument: $1" >&2; usage ;;
  esac
done

if ! [[ $SERVICE_USER =~ ^[a-z_][a-z0-9_-]*$ ]]; then
  echo "install: not a valid user name: $SERVICE_USER" >&2
  exit 2
fi
if [ ! -d "$PREFIX" ]; then
  echo "install: --prefix is not a directory: $PREFIX" >&2
  exit 2
fi
PREFIX=$(cd -- "$PREFIX" && pwd -P)
case "$PREFIX" in
  *'|'*|*'&'*|*'\'*) echo "install: --prefix may not contain |, & or \\: $PREFIX" >&2; exit 2 ;;
esac
if [ ! -f "$PREFIX/src/index.js" ] || [ ! -f "$PREFIX/deploy/$UNIT_NAME" ]; then
  echo "install: $PREFIX is not a neptunia-bot checkout (no src/index.js or deploy/$UNIT_NAME)" >&2
  exit 2
fi
if [ "$DRY_RUN" -eq 0 ] && [ "$(id -u)" -ne 0 ]; then
  echo "install: must be run as root (sudo deploy/install.sh ...), or with --dry-run" >&2
  exit 1
fi

# Runs a command, printing it first; with --dry-run only prints it.
run() {
  echo "+ $*"
  if [ "$DRY_RUN" -eq 0 ]; then "$@"; fi
}

# The bot's unit with User=, Group= and WorkingDirectory= set (a Group= line is added after User=
# when the unit has none), on stdout.
render_unit() {
  local add_group=()
  if ! grep -q '^Group=' "$PREFIX/deploy/$UNIT_NAME"; then add_group=(-e "/^User=/a Group=$SERVICE_USER"); fi
  sed -e "s|^User=.*|User=$SERVICE_USER|" \
      -e "s|^Group=.*|Group=$SERVICE_USER|" \
      -e "s|^WorkingDirectory=.*|WorkingDirectory=$PREFIX|" \
      "${add_group[@]}" \
      "$PREFIX/deploy/$UNIT_NAME"
}

echo "neptunia-bot install: user $SERVICE_USER, checkout $PREFIX$([ "$DRY_RUN" -eq 1 ] && echo ' (dry run: nothing is changed)')"

# The service user.
if id -u "$SERVICE_USER" >/dev/null 2>&1; then
  echo "= user $SERVICE_USER exists"
else
  run useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$SERVICE_USER"
fi

# The private directory and its files; an existing file is kept as it is.
run install -d -o root -g root -m 0755 "$PRIVATE_DIR"
if [ -e "$PRIVATE_DIR/.env" ]; then
  echo "= $PRIVATE_DIR/.env exists, kept"
else
  run install -o root -g "$SERVICE_USER" -m 0640 "$PREFIX/.env.example" "$PRIVATE_DIR/.env"
fi
run install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$PRIVATE_DIR/prompts.local"
if [ -e "$PRIVATE_DIR/config.local.json" ]; then
  echo "= $PRIVATE_DIR/config.local.json exists, kept"
else
  echo "+ echo '{}' > $PRIVATE_DIR/config.local.json"
  if [ "$DRY_RUN" -eq 0 ]; then echo '{}' > "$PRIVATE_DIR/config.local.json"; fi
  run chown "$SERVICE_USER:$SERVICE_USER" "$PRIVATE_DIR/config.local.json"
  run chmod 0640 "$PRIVATE_DIR/config.local.json"
fi

# The data directory.
run install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$DATA_DIR"

# The unit, rewritten for this user and checkout (replaced on every run).
echo "+ render $PREFIX/deploy/$UNIT_NAME (User=$SERVICE_USER, Group=$SERVICE_USER, WorkingDirectory=$PREFIX) > $UNIT_DIR/$UNIT_NAME"
if [ "$DRY_RUN" -eq 0 ]; then
  unit_tmp=$(mktemp)
  trap 'rm -f "$unit_tmp"' EXIT
  render_unit > "$unit_tmp"
  install -o root -g root -m 0644 "$unit_tmp" "$UNIT_DIR/$UNIT_NAME"
fi
run systemctl daemon-reload

cat <<EOF

Done$([ "$DRY_RUN" -eq 1 ] && echo ' (dry run)'). The service is not started. Fill in next:
  $PRIVATE_DIR/.env                the Discord token and the OpenRouter key (see .env.example)
  $PRIVATE_DIR/config.local.json   this deployment's settings over config.json
  $PRIVATE_DIR/prompts.local/      the character: files that replace prompts/ file by file
Then: sudo systemctl enable --now ${UNIT_NAME%.service}
      journalctl -u ${UNIT_NAME%.service} -f
EOF
