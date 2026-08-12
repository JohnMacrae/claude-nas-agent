#!/usr/bin/env bash
# Copy the Google Calendar refresh token from rentr-dashboard's SQLite DB into
# property-agent's shared token file (+ .env fallback), then restart the agent.
#
# Run after re-authorising at rentr-dashboard /admin/google-auth.
set -euo pipefail

REPO="/volume1/docker/property-agent"
TOKEN_FILE="$REPO/data/google-refresh-token"
ENV_FILE="$REPO/.env"

TOKEN="$(docker exec rentr-dashboard python3 -c "
import sqlite3
row = sqlite3.connect('/data/rentr.db').execute(
    \"SELECT value FROM config WHERE key='google_refresh_token'\"
).fetchone()
print(row[0] if row and row[0] else '')
")"

if [[ -z "$TOKEN" ]]; then
  echo "No google_refresh_token in rentr-dashboard DB." >&2
  echo "Visit http://dnas.beetal-carp.ts.net:8765/admin/google-auth and re-authorise first." >&2
  exit 1
fi

mkdir -p "$REPO/data"
printf '%s' "$TOKEN" > "$TOKEN_FILE"
chmod 600 "$TOKEN_FILE"
echo "Wrote $TOKEN_FILE"

if [[ -f "$ENV_FILE" ]]; then
  if grep -q '^GOOGLE_REFRESH_TOKEN=' "$ENV_FILE"; then
    sed -i "s|^GOOGLE_REFRESH_TOKEN=.*|GOOGLE_REFRESH_TOKEN=$TOKEN|" "$ENV_FILE"
  else
    printf '\nGOOGLE_REFRESH_TOKEN=%s\n' "$TOKEN" >> "$ENV_FILE"
  fi
  echo "Updated $ENV_FILE"
fi

echo "Rebuilding and restarting property-agent..."
cd "$REPO"
docker compose build agent
docker compose up -d agent

echo "Verifying Calendar access..."
sleep 3
if docker exec property-agent node /agent/gcal.js list-events \
    --calendar Maintenance \
    --from "$(date -u +%Y-%m-01)T00:00:00Z" \
    --to "$(date -u +%Y-%m-%d)T23:59:59Z" | grep -q '"ok":true'; then
  echo "OK — Google Calendar auth restored."
else
  echo "FAIL — token sync completed but gcal still errors. Check logs:" >&2
  docker logs property-agent --tail 20 >&2
  exit 1
fi
