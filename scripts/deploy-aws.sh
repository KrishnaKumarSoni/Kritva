#!/usr/bin/env bash
# Redeploys main, exactly as it is on origin, to the Kritva EC2 box (us-west-2, https://184-33-88-175.sslip.io).
# Needs the "kritva-aws" host in ~/.ssh/config. The server's data/ (SQLite) is left untouched.
# Pass --env to also push .env merged with .env.production (secrets never go through git).
#
# Several sessions deploy from this repo, so the script:
# - deploys only what is pushed: local main must match origin/main (it fast-forwards a stale main, and refuses
#   unpushed or diverged commits);
# - takes a lock on the server, so two deploys never overlap;
# - records the deployed commit in /opt/kritva/DEPLOYED. Check what is live with: ssh kritva-aws cat /opt/kritva/DEPLOYED
set -euo pipefail
cd "$(dirname "$0")/.."

if ! git fetch -q origin main:main 2>/dev/null; then
  git fetch -q origin main
  if [[ "$(git rev-parse main)" != "$(git rev-parse origin/main)" ]]; then
    echo "Local main ($(git rev-parse --short main)) differs from origin/main ($(git rev-parse --short origin/main)). Push or merge first; nothing was deployed." >&2
    exit 1
  fi
fi
sha="$(git rev-parse main)"
echo "Deploying main at ${sha:0:7}: $(git log -1 --format=%s main)"

if [[ "${1:-}" == "--env" ]]; then
  { grep -v -E '^(KRITVA_PUBLIC_URL|KRITVA_OPERATOR_KEY|KRITVA_HOST|PORT|KRITVA_PHONE_ROUTES|KRITVA_PHONE_CALLER_ID|VOBIZ_[A-Z_]+)=' .env; echo; cat .env.production; } \
    | ssh kritva-aws 'umask 077; cat > /opt/kritva/.env.next'
  env_step='mv /opt/kritva/.env.next /opt/kritva/.env &&'
else
  env_step=''
fi

git archive main | ssh kritva-aws "exec 9>/tmp/kritva-deploy.lock && flock -w 900 9 && tar -x -C /opt/kritva && ${env_step} cd /opt/kritva && npm ci --no-audit --no-fund >/dev/null && npm run build -w @kritva/web >/dev/null && sudo systemctl restart kritva && sleep 2 && curl -fsS localhost:8787/api/health && echo '${sha}' > /opt/kritva/DEPLOYED"
echo
echo "Live: https://184-33-88-175.sslip.io (${sha:0:7})"
