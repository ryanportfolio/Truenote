#!/bin/sh
# Container entrypoint for Dockerfile.railway. Runs TypeScript through tsx,
# as the Replit deployment did. exec hands PID 1 to Node so SIGTERM reaches
# the graceful-shutdown handlers.
set -eu

# Railway injects PORT for the public service; the api-server reads API_PORT.
if [ -n "${PORT:-}" ]; then
  API_PORT="$PORT"
  export API_PORT
fi

case "${TRUENOTE_PROCESS:-web}" in
  web)
    cd /app/artifacts/api-server
    exec ./node_modules/.bin/tsx src/index.ts
    ;;
  worker)
    cd /app/scripts
    exec ./node_modules/.bin/tsx src/worker.ts
    ;;
  *)
    echo "Unknown TRUENOTE_PROCESS: ${TRUENOTE_PROCESS}" >&2
    exit 64
    ;;
esac
