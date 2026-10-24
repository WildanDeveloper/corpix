#!/bin/sh
set -e

# Corpix refuses to bind a non-loopback address without an admin token. A
# container has to bind 0.0.0.0 to be reachable, so generate one on first start
# and keep it in the data volume instead of baking a default into the image.
if [ -z "${ADMIN_TOKEN:-}" ]; then
  TOKEN_FILE="${DATA_DIR:-/data}/admin-token"
  mkdir -p "$(dirname "$TOKEN_FILE")" 2>/dev/null || true
  if [ ! -w "$(dirname "$TOKEN_FILE")" ]; then
    echo "[corpix] cannot write to $(dirname "$TOKEN_FILE")."
    echo "[corpix] If you bind-mounted a host directory, make it writable by uid 10001:"
    echo "[corpix]   sudo chown -R 10001:10001 <host-directory>"
    echo "[corpix] Alternatively set ADMIN_TOKEN explicitly."
    exit 1
  fi
  if [ -f "$TOKEN_FILE" ]; then
    ADMIN_TOKEN="$(cat "$TOKEN_FILE")"
  else
    ADMIN_TOKEN="$(node -e "process.stdout.write(require('node:crypto').randomBytes(24).toString('hex'))")"
    printf '%s' "$ADMIN_TOKEN" > "$TOKEN_FILE"
    chmod 600 "$TOKEN_FILE"
    echo "[corpix] generated an admin token and stored it in $TOKEN_FILE"
    echo "[corpix] open the UI and paste that token into the Admin token field"
  fi
  export ADMIN_TOKEN
fi

exec "$@"
