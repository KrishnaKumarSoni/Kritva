#!/usr/bin/env bash
# Deploys Kritva to Cloudflare: the Worker "kritva" (apps/worker) at https://kritva.krishnakumarsoni.com.
# The database lives in the Worker's Durable Object and is never touched by a deploy.
#
#   scripts/deploy-cloudflare.sh              deploy main, exactly as it is on origin
#   scripts/deploy-cloudflare.sh --secrets    also set the Worker's secrets from .env + .env.production
#   scripts/deploy-cloudflare.sh --ref HEAD   deploy a local commit that is not pushed yet (says so loudly)
#
# Like the old AWS script, it builds from a clean copy of the commit (git archive), so local edits never
# ship, and records the commit: check what is live with
#   curl -s https://kritva.krishnakumarsoni.com/api/health
# Needs Node 24 and wrangler logged in (npx wrangler login) to the account that holds krishnakumarsoni.com.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
URL="https://kritva.krishnakumarsoni.com"

secrets=no
ref=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --secrets) secrets=yes ;;
    --ref) ref="${2:?--ref needs a git ref}"; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

if [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 24 ]]; then
  echo "Kritva needs Node 24 (nvm use 24); this is $(node -v)." >&2
  exit 1
fi

if [[ -z "$ref" ]]; then
  if ! git fetch -q origin main:main 2>/dev/null; then
    git fetch -q origin main
    if [[ "$(git rev-parse main)" != "$(git rev-parse origin/main)" ]]; then
      echo "Local main ($(git rev-parse --short main)) differs from origin/main ($(git rev-parse --short origin/main)). Push or merge first; nothing was deployed." >&2
      exit 1
    fi
  fi
  ref=main
else
  echo "WARNING: deploying $ref, which origin/main may not have. Push it to main afterwards so main matches what is live." >&2
fi
sha="$(git rev-parse "$ref^{commit}")"
echo "Deploying ${sha:0:7}: $(git log -1 --format=%s "$sha")"

build="$(mktemp -d)"
trap 'rm -rf "$build"' EXIT
git archive "$sha" | tar -x -C "$build"
cd "$build"
npm ci --no-audit --no-fund >/dev/null
npm run build -w @kritva/worker >/dev/null
wrangler=(npx wrangler --config apps/worker/wrangler.jsonc)

# The Worker's vars (in wrangler.jsonc) and the secrets must not share names; local-only settings stay local.
if [[ "$secrets" == yes ]]; then
  umask 077
  node --input-type=module - "$ROOT" "$build/secrets.json" <<'EOF'
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
const [root, out] = process.argv.slice(2);
const read = (f) => (existsSync(`${root}/${f}`) ? parseEnv(readFileSync(`${root}/${f}`, "utf8")) : {});
const config = JSON.parse(readFileSync("apps/worker/wrangler.jsonc", "utf8").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n"));
const localOnly = /^(PORT|KRITVA_HOST|KRITVA_DATA_DIR|KRITVA_PHONE_LOG_FILE|KRITVA_SES_REGION|KRITVA_COMMIT|VOBIZ_TRUNK_ID|AWS_\w+)$/;
const merged = { ...read(".env"), ...read(".env.production") };
const secrets = Object.fromEntries(Object.entries(merged).filter(([k, v]) => v !== "" && !(k in config.vars) && !localOnly.test(k)));
writeFileSync(out, JSON.stringify(secrets));
console.log(`Secrets to set: ${Object.keys(secrets).sort().join(", ")}`);
EOF
fi

"${wrangler[@]}" deploy --message "${ref} ${sha:0:7}" --var "KRITVA_COMMIT:${sha}"
if [[ "$secrets" == yes ]]; then
  "${wrangler[@]}" secret bulk "$build/secrets.json"
fi

# The server object picks up a new version once its old instance winds down, which took about 5 minutes once.
echo "Waiting for ${URL} to serve ${sha:0:7} (up to 6 minutes)..."
for _ in $(seq 1 90); do
  live="$(curl -fsS -m 10 "${URL}/api/health" 2>/dev/null | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).commit' 2>/dev/null || true)"
  if [[ "$live" == "$sha" ]]; then
    echo "Live: ${URL} (${sha:0:7})"
    exit 0
  fi
  sleep 4
done
echo "Deployed, but ${URL}/api/health does not report ${sha:0:7} yet (it said: ${live:-nothing}). Check: npx wrangler tail --config apps/worker/wrangler.jsonc" >&2
exit 1
