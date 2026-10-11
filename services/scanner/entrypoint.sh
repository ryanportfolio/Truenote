#!/bin/bash
# Starts freshclam (signature updates), clamd and the HTTP wrapper as the
# clamav user. If any of the three exits, the others are stopped and the
# container exits non-zero, so Railway's restart policy brings it back.
#
# SCANNER_DATABASE_DIR (default /var/lib/clamav) holds the signature
# database. Point it at a volume so a restarted or woken container keeps its
# signatures and freshclam downloads only the difference. Railway mounts
# volumes owned by root, so a service with a volume starts the container as
# root (RAILWAY_RUN_UID=0); this script then prepares the directory and
# re-runs itself as clamav, so freshclam, clamd and node never run as root.
set -uo pipefail

conf=/opt/scanner
bundled=/var/lib/clamav
db_dir="${SCANNER_DATABASE_DIR:-$bundled}"

# The path is written into the generated configs below.
if [[ ! "$db_dir" =~ ^/[A-Za-z0-9._/-]+$ ]]; then
  echo "[scanner] SCANNER_DATABASE_DIR must be an absolute path of letters, digits, '.', '_', '-' and '/'; got '$db_dir'" >&2
  exit 1
fi

if [ "$(id -u)" = "0" ]; then
  if [ -n "${SCANNER_ROOT_DROPPED:-}" ]; then
    echo "[scanner] still root after dropping privileges; refusing to start" >&2
    exit 1
  fi
  mkdir -p "$db_dir" || exit 1
  # Seed an empty directory (a new volume) from the image's bundled database,
  # so the first freshclam run fetches only the difference.
  if [ ! -e "$db_dir/daily.cvd" ] && [ ! -e "$db_dir/daily.cld" ]; then
    echo "[scanner] seeding $db_dir from the bundled signature database" >&2
    find "$bundled" -maxdepth 1 -type f \( -name '*.cvd' -o -name '*.cld' -o -name '*.cud' \) \
      -exec cp -p {} "$db_dir"/ \; || exit 1
  fi
  chown -R clamav:clamav "$db_dir" || exit 1
  export SCANNER_ROOT_DROPPED=1
  exec setpriv --reuid="$(id -u clamav)" --regid="$(id -g clamav)" --clear-groups -- "$0" "$@"
fi

mkdir -p "$db_dir" 2>/dev/null
if [ ! -d "$db_dir" ] || [ ! -w "$db_dir" ]; then
  echo "[scanner] database directory $db_dir is not writable by uid $(id -u); start the container as root (RAILWAY_RUN_UID=0) so it can be prepared, or point SCANNER_DATABASE_DIR at a writable directory" >&2
  exit 1
fi

rm -f /tmp/clamd.sock

# Configs with the database directory filled in, generated from the shipped
# files. freshclam's reload notices go to the generated clamd config.
sed "s|^DatabaseDirectory .*|DatabaseDirectory $db_dir|" "$conf/clamd.conf" > /tmp/clamd.conf || exit 1
sed -e "s|^DatabaseDirectory .*|DatabaseDirectory $db_dir|" \
    -e "s|^NotifyClamd .*|NotifyClamd /tmp/clamd.conf|" \
    "$conf/freshclam.conf" > /tmp/freshclam.conf || exit 1

stop_all() {
  kill -TERM $(jobs -p) 2>/dev/null
  wait
}
trap 'stop_all; exit 0' TERM INT

# One update before clamd loads, so clamd starts on current signatures (the
# image's bundled database can be weeks old, and a reload notice sent before
# clamd's socket exists is lost). On failure, start with the database on disk;
# /health reports it stale past 48 hours.
grep -v '^NotifyClamd' /tmp/freshclam.conf > /tmp/freshclam-initial.conf
freshclam --config-file=/tmp/freshclam-initial.conf --stdout \
  || echo "[scanner] initial signature update failed; starting with the database on disk" >&2
rm -f /tmp/freshclam-initial.conf

freshclam --config-file=/tmp/freshclam.conf --daemon --stdout &
clamd --config-file=/tmp/clamd.conf &
node "$conf/server.mjs" &

wait -n
status=$?
echo "[scanner] a process exited with status $status; stopping the container" >&2
stop_all
exit 1
