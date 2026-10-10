#!/bin/bash
# Starts freshclam (signature updates), clamd and the HTTP wrapper as the
# clamav user. If any of the three exits, the others are stopped and the
# container exits non-zero, so Railway's restart policy brings it back.
set -uo pipefail

conf=/opt/scanner
rm -f /tmp/clamd.sock

stop_all() {
  kill -TERM $(jobs -p) 2>/dev/null
  wait
}
trap 'stop_all; exit 0' TERM INT

freshclam --config-file="$conf/freshclam.conf" --daemon --stdout &
clamd --config-file="$conf/clamd.conf" &
node "$conf/server.mjs" &

wait -n
status=$?
echo "[scanner] a process exited with status $status; stopping the container" >&2
stop_all
exit 1
