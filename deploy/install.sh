#!/usr/bin/env bash
# Sets up a server for neptunia-bot with the private files outside the checkout, under one root
# (the layout described in deploy/neptunia-bot.service):
#   /opt/neptunia/
#     app/    the engine checkout (root-owned, read-only to the service)
#     etc/    .env, config.local.json, prompts.local/   (NEPTUNIA_PRIVATE_DIR)
#     data/   everything the bot writes                 (NEPTUNIA_DATA_DIR)
#
# Usage:     sudo deploy/install.sh [--root DIR] [--user NAME] [--prefix DIR] [--dry-run]
#   --root DIR    the top directory of the layout (default /opt/neptunia)
#   --user NAME   the service user (default neptunia-bot): created as a system user, no login, no home
#   --prefix DIR  the checkout the service runs from (default <root>/app; clone it there first)
#   --dry-run     print the commands without running them (does not need root)
#
# Every step is safe to repeat:
#   - creates the service user (and its group) if absent;
#   - creates <root> (root:root 755);
#   - creates <root>/etc (root:root 755) with .env copied from .env.example when absent
#     (root:<user> 640), prompts.local/ (<user> 750), and config.local.json ({} when absent,
#     <user> 640); existing files are left alone;
#   - creates <root>/data (<user>:<user> 750);
#   - installs deploy/neptunia-bot.service into /etc/systemd/system/ with User=, Group=,
#     WorkingDirectory=, the two directory variables, EnvironmentFile= and ReadWritePaths= set
#     for the given user, checkout and root;
#   - installs deploy/neptunia-core.service (User= the given user) and the template
#     deploy/neptunia-interface@.service the same way, for running the interfaces as units
#     (deploy/README.md), then runs systemctl daemon-reload.
# It starts and enables none of them: fill in the private files first (it prints which).

set -euo pipefail

UNIT_NAME=neptunia-bot.service
CORE_UNIT=neptunia-core.service
INTERFACE_UNIT=neptunia-interface@.service
UNIT_DIR=/etc/systemd/system

ROOT=/opt/neptunia
SERVICE_USER=neptunia-bot
PREFIX=
DRY_RUN=0

usage() {
  echo "usage: sudo deploy/install.sh [--root DIR] [--user NAME] [--prefix DIR] [--dry-run]" >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --root) [ $# -ge 2 ] || usage; ROOT=$2; shift 2 ;;
    --user) [ $# -ge 2 ] || usage; SERVICE_USER=$2; shift 2 ;;
    --prefix) [ $# -ge 2 ] || usage; PREFIX=$2; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage ;;
    *) echo "install: unknown argument: $1" >&2; usage ;;
  esac
done

if ! [[ $SERVICE_USER =~ ^[a-z_][a-z0-9_-]*$ ]]; then
  echo "install: invalid user name: $SERVICE_USER" >&2
  exit 2
fi
case "$ROOT" in
  /*) ;;
  *) echo "install: --root must be an absolute path: $ROOT" >&2; exit 2 ;;
esac
case "$ROOT" in
  *'|'*|*'&'*|*'\'*|*[[:space:]]*) echo "install: --root must not contain |, &, \\ or spaces: $ROOT" >&2; exit 2 ;;
esac
ROOT=${ROOT%"${ROOT##*[!/]}"}
if [ -z "$ROOT" ]; then
  echo "install: --root must not be /" >&2
  exit 2
fi
PRIVATE_DIR=$ROOT/etc
DATA_DIR=$ROOT/data
[ -n "$PREFIX" ] || PREFIX=$ROOT/app
if [ ! -d "$PREFIX" ]; then
  echo "install: checkout directory not found: $PREFIX (clone the engine to <root>/app, or pass --prefix)" >&2
  exit 2
fi
PREFIX=$(cd -- "$PREFIX" && pwd -P)
case "$PREFIX" in
  *'|'*|*'&'*|*'\'*|*[[:space:]]*) echo "install: --prefix must not contain |, &, \\ or spaces: $PREFIX" >&2; exit 2 ;;
esac
if [ ! -f "$PREFIX/src/index.js" ] || [ ! -f "$PREFIX/deploy/$UNIT_NAME" ]; then
  echo "install: $PREFIX does not look like a neptunia-bot checkout (missing src/index.js or deploy/$UNIT_NAME)" >&2
  exit 2
fi
if [ "$DRY_RUN" -eq 0 ] && [ "$(id -u)" -ne 0 ]; then
  echo "install: run as root (sudo deploy/install.sh ...), or use --dry-run" >&2
  exit 1
fi

# Prints a command and runs it; with --dry-run, only prints it.
run() {
  echo "+ $*"
  if [ "$DRY_RUN" -eq 0 ]; then "$@"; fi
}

# Writes the bot's unit with User=, Group=, WorkingDirectory=, NEPTUNIA_PRIVATE_DIR,
# NEPTUNIA_DATA_DIR, EnvironmentFile= and ReadWritePaths= set for this layout (adds a Group=
# line after User= when the unit has none).
render_unit() {
  local add_group=()
  if ! grep -q '^Group=' "$PREFIX/deploy/$UNIT_NAME"; then add_group=(-e "/^User=/a Group=$SERVICE_USER"); fi
  sed -e "s|^User=.*|User=$SERVICE_USER|" \
      -e "s|^Group=.*|Group=$SERVICE_USER|" \
      -e "s|^WorkingDirectory=.*|WorkingDirectory=$PREFIX|" \
      -e "s|^Environment=NEPTUNIA_PRIVATE_DIR=.*|Environment=NEPTUNIA_PRIVATE_DIR=$PRIVATE_DIR|" \
      -e "s|^Environment=NEPTUNIA_DATA_DIR=.*|Environment=NEPTUNIA_DATA_DIR=$DATA_DIR|" \
      -e "s|^EnvironmentFile=.*|EnvironmentFile=-$PRIVATE_DIR/.env|" \
      -e "s|^ReadWritePaths=.*|ReadWritePaths=$DATA_DIR $PRIVATE_DIR|" \
      "${add_group[@]}" \
      "$PREFIX/deploy/$UNIT_NAME"
}

# Writes one of the units for running the interfaces as units with WorkingDirectory=, the two
# directory variables and the paths under them set for this layout; the core's User= is the
# service user, an interface's stays neptunia-%i-interface.
render_split_unit() {
  local user_line=()
  if [ "$1" = "$CORE_UNIT" ]; then user_line=(-e "s|^User=.*|User=$SERVICE_USER|"); fi
  sed -e "s|^WorkingDirectory=.*|WorkingDirectory=$PREFIX|" \
      -e "s|^Environment=NEPTUNIA_PRIVATE_DIR=.*|Environment=NEPTUNIA_PRIVATE_DIR=$PRIVATE_DIR|" \
      -e "s|^Environment=NEPTUNIA_DATA_DIR=.*|Environment=NEPTUNIA_DATA_DIR=$DATA_DIR|" \
      -e "s|/opt/neptunia/etc|$PRIVATE_DIR|g" \
      -e "s|/opt/neptunia/data|$DATA_DIR|g" \
      "${user_line[@]}" \
      "$PREFIX/deploy/$1"
}

echo "neptunia-bot install: user=$SERVICE_USER root=$ROOT checkout=$PREFIX$([ "$DRY_RUN" -eq 1 ] && echo ' (dry run)')"

# Service user.
if id -u "$SERVICE_USER" >/dev/null 2>&1; then
  echo "= user $SERVICE_USER already exists"
else
  run useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$SERVICE_USER"
fi

# Root directory, then private directory and its files. Existing files are left alone.
run install -d -o root -g root -m 0755 "$ROOT"
run install -d -o root -g root -m 0755 "$PRIVATE_DIR"
if [ -e "$PRIVATE_DIR/.env" ]; then
  echo "= $PRIVATE_DIR/.env already exists, not overwritten"
else
  run install -o root -g "$SERVICE_USER" -m 0640 "$PREFIX/.env.example" "$PRIVATE_DIR/.env"
fi
run install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$PRIVATE_DIR/prompts.local"
if [ -e "$PRIVATE_DIR/config.local.json" ]; then
  echo "= $PRIVATE_DIR/config.local.json already exists, not overwritten"
else
  echo "+ echo '{}' > $PRIVATE_DIR/config.local.json"
  if [ "$DRY_RUN" -eq 0 ]; then echo '{}' > "$PRIVATE_DIR/config.local.json"; fi
  run chown "$SERVICE_USER:$SERVICE_USER" "$PRIVATE_DIR/config.local.json"
  run chmod 0640 "$PRIVATE_DIR/config.local.json"
fi

# Data directory.
run install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$DATA_DIR"

# Unit file, rewritten for this user and checkout (replaced on every run).
echo "+ render $PREFIX/deploy/$UNIT_NAME (User=$SERVICE_USER, Group=$SERVICE_USER, WorkingDirectory=$PREFIX, NEPTUNIA_PRIVATE_DIR=$PRIVATE_DIR, NEPTUNIA_DATA_DIR=$DATA_DIR) > $UNIT_DIR/$UNIT_NAME"
if [ "$DRY_RUN" -eq 0 ]; then
  unit_tmp=$(mktemp)
  trap 'rm -f "$unit_tmp"' EXIT
  render_unit > "$unit_tmp"
  install -o root -g root -m 0644 "$unit_tmp" "$UNIT_DIR/$UNIT_NAME"
fi
# The units for running the interfaces as units (replaced on every run, never enabled here).
for unit in "$CORE_UNIT" "$INTERFACE_UNIT"; do
  echo "+ render $PREFIX/deploy/$unit (WorkingDirectory=$PREFIX, NEPTUNIA_PRIVATE_DIR=$PRIVATE_DIR, NEPTUNIA_DATA_DIR=$DATA_DIR) > $UNIT_DIR/$unit"
  if [ "$DRY_RUN" -eq 0 ]; then
    split_tmp=$(mktemp)
    render_split_unit "$unit" > "$split_tmp"
    install -o root -g root -m 0644 "$split_tmp" "$UNIT_DIR/$unit"
    rm -f "$split_tmp"
  fi
done
run systemctl daemon-reload

cat <<EOF

Done$([ "$DRY_RUN" -eq 1 ] && echo ' (dry run)'). The service is not started yet. Fill in:
  $PRIVATE_DIR/.env                Discord token and OpenRouter key (see .env.example)
  $PRIVATE_DIR/config.local.json   settings that override config.json for this deployment
  $PRIVATE_DIR/prompts.local/      the character: files that replace those in prompts/
Then: sudo systemctl enable --now ${UNIT_NAME%.service}
      journalctl -u ${UNIT_NAME%.service} -f
To run the interfaces as units instead, follow deploy/README.md (${CORE_UNIT%.service}, ${INTERFACE_UNIT%.service}<name>).
EOF
