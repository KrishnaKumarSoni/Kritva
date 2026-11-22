#!/usr/bin/env bash
# Redeploys committed main to the Kritva EC2 box (us-west-2, https://184-33-88-175.sslip.io).
# Needs the "kritva-aws" host in ~/.ssh/config. The server's data/ (SQLite) is left untouched.
# Pass --env to also push .env merged with .env.production (secrets never go through git).
set -euo pipefail
cd "$(dirname "$0")/.."

git archive main | ssh kritva-aws 'tar -x -C /opt/kritva'
if [[ "${1:-}" == "--env" ]]; then
  { grep -v -E '^(KRITVA_PUBLIC_URL|KRITVA_OPERATOR_KEY|KRITVA_HOST|PORT|KRITVA_PHONE_ROUTES|KRITVA_PHONE_CALLER_ID|VOBIZ_[A-Z_]+)=' .env; echo; cat .env.production; } \
    | ssh kritva-aws 'umask 077; cat > /opt/kritva/.env'
fi
ssh kritva-aws 'cd /opt/kritva && npm ci --no-audit --no-fund >/dev/null && npm run build -w @kritva/web >/dev/null && sudo systemctl restart kritva && sleep 2 && curl -fsS localhost:8787/api/health'
echo
echo "Live: https://184-33-88-175.sslip.io"
