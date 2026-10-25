#!/usr/bin/env bash
# Start Corpix with a data directory that survives reboots.
#
# The one rule: never put DATA_DIR in /tmp. The OS clears it, and with it go the
# projects, runs, settings, the API key and every agent's memory.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${CORPIX_DATA_DIR:-$ROOT/data}"
PORT="${PORT:-3080}"
HOST="${HOST:-127.0.0.1}"

case "$(readlink -f "$DATA_DIR")" in
  /tmp/*|/var/tmp/*)
    echo "Refusing to use DATA_DIR=$DATA_DIR: temporary directories are wiped on reboot." >&2
    echo "Set CORPIX_DATA_DIR to a permanent path, e.g. $ROOT/data" >&2
    exit 1
    ;;
esac

# Node 22 is required by the toolchain; prefer the local install when present.
if [ -d /opt/node22/bin ]; then
  export PATH="/opt/node22/bin:$PATH"
fi

mkdir -p "$DATA_DIR"
cd "$ROOT"

echo "Corpix"
echo "  data: $DATA_DIR"
echo "  url:  http://$HOST:$PORT"
echo

exec env DATA_DIR="$DATA_DIR" PORT="$PORT" HOST="$HOST" ./node_modules/.bin/tsx apps/server/src/index.ts
