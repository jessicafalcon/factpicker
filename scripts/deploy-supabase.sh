#!/usr/bin/env bash
# Build, verify and deploy the GraphQL edge function.
# Requires a Supabase personal access token: https://supabase.com/dashboard/account/tokens
set -euo pipefail
cd "$(dirname "$0")/.."

REF="${SUPABASE_PROJECT_REF:?set SUPABASE_PROJECT_REF to your project ref}"
CLI="npx --yes supabase@latest"

if [ -z "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  cat <<EOF
Missing SUPABASE_ACCESS_TOKEN.

  1. Create a token: https://supabase.com/dashboard/account/tokens
  2. export SUPABASE_ACCESS_TOKEN=sbp_...
     (or run: $CLI login)

Then re-run: npm run edge:deploy
EOF
  exit 1
fi

echo "1/4  building dataset + schema + bundle"
node --experimental-strip-types scripts/build-edge.ts

echo "2/4  serving the bundle locally to prove it answers"
node --experimental-strip-types scripts/verify-edge.ts > /tmp/edge-verify.json
node -e 'const r=require("/tmp/edge-verify.json"); if(!r.ok) process.exit(1); console.log("     ok —", r.query.moments, "moments, CORS", r.health.cors)'

echo "3/4  deploying graphql to $REF"
$CLI functions deploy graphql --remote="$REF" --no-verify-jwt --use-api --yes

echo "4/4  smoke test"
URL="https://$REF.supabase.co/functions/v1/graphql"
curl -sS "$URL" -H 'content-type: application/json' \
  -d '{"query":"{ apiVersion dataset { videos stanceRows events } }"}'
echo
echo "ready: $URL"
