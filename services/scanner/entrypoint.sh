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

# One update before clamd loads, so clamd starts on current signatures (the
# image's bundled database can be weeks old, and a reload notice sent before
# clamd's socket exists is lost). On failure, start with the bundled database;
# /health reports it stale past 48 hours.
grep -v '^NotifyClamd' "$conf/freshclam.conf" > /tmp/freshclam-initial.conf
freshclam --config-file=/tmp/freshclam-initial.conf --stdout \
  || echo "[scanner] initial signature update failed; starting with the bundled database" >&2
rm -f /tmp/freshclam-initial.conf

freshclam --config-file="$conf/freshclam.conf" --daemon --stdout &
clamd --config-file="$conf/clamd.conf" &
node "$conf/server.mjs" &

wait -n
status=$?
echo "[scanner] a process exited with status $status; stopping the container" >&2
stop_all
exit 1
