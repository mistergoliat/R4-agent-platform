#!/usr/bin/env bash
# R4 coordinated code deploy by SHA (owner-authorized). Keeps the current lane; checks the Core head after migrating.
#   TARGET=<full sha> PREV=<deployed short sha> LANE=sales-production@19 EXPECT_HEAD=0016_inbound_media bash deploy.sh
# Order with no kill-switch hold window: workers stop first (the gateway keeps ingesting and delivering), the outbound
# drains, the gateway stops (Meta retries webhooks), only then the kill switch. Any failure before the processes are
# stopped leaves production running; after that, rollback.sh level 2 restores PREV.
# Nothing is stopped before TARGET is proven deployable: a full 40-hex SHA that resolves to itself, the expected Core
# head shipped in that tree, and a clean install + build of that exact tree in a staging directory outside production
# (step 0b). A short or unknown SHA, a missing migration or a broken build stops here with production untouched.
# CHECK_ONLY=1 runs steps 0 and 0b and exits: no backup, nothing stopped, no autonomy change (validates a candidate).
set -euo pipefail
umask 077
: "${TARGET:?set TARGET=<full sha>}" "${PREV:?set PREV=<deployed short sha>}" "${LANE:?set LANE=<current lane profile>}" "${EXPECT_HEAD:?set EXPECT_HEAD=<core migration id>}"
R=~/R4-agent-platform; C=~/.config/r4
WORKERS="r4-scheduler r4-sales-worker r4-sales-worker-lane"; GATEWAY=r4-channel-gateway
step() { echo "== $(date -u +%T) $*"; }
envrun() { (cd "$R" && set -a && . "$C/production.env" && set +a && "$@"); }
db() { docker exec r4-production-postgres psql -U r4_production -d r4_production -At -c "$1"; }
autonomy() { envrun npm run -s production:sales:control -- autonomy status | grep -oE '"autonomy": "[a-z]+"' | head -1 || true; }
STARTED=$(date -u +%FT%TZ)

step "0. preconditions"
[[ "$TARGET" =~ ^[0-9a-f]{40}$ ]] || { echo "TARGET must be the full 40-character SHA (got '$TARGET'): nothing was stopped"; exit 1; }
[ "$(cd "$R" && git rev-parse --short HEAD)" = "$PREV" ] || { echo "deployed SHA is not $PREV"; exit 1; }
PREV_FULL=$(cd "$R" && git rev-parse HEAD); echo "deployed: $PREV_FULL (rollback: PREV_FULL=$PREV_FULL bash rollback.sh 2)"
[ -z "$(cd "$R" && git status --short)" ] || { echo "working tree not clean"; exit 1; }
avail=$(df -B1M --output=avail / | tail -1 | tr -d ' '); [ "$avail" -ge 3000 ] || { echo "disk $avail MB"; exit 1; }
grep -q "^R4_PROD_LANE_PROFILE=$LANE$" "$C/production.env" && grep -q "^R4_PROD_POLICY_PROFILE=$LANE$" "$C/production-lane.env" || { echo "lane is not $LANE"; exit 1; }
curl -sf -m 5 127.0.0.1:8090/health >/dev/null
[ "$(autonomy)" = '"autonomy": "enabled"' ] || { echo "autonomy was not enabled ($(autonomy)): stop"; exit 1; }
[ "$(db "select count(*) from action_executions where status not in ('succeeded','failed','rejected')")" = 0 ] || { echo "an action is not settled"; exit 1; }
(cd "$R" && git fetch -q origin && [ "$(git rev-parse --verify -q "$TARGET^{commit}")" = "$TARGET" ]) || { echo "TARGET $TARGET is not a commit of this repository: nothing was stopped"; exit 1; }
(cd "$R" && git cat-file -e "$TARGET:packages/persistence-postgres/migrations/$EXPECT_HEAD.sql") || { echo "TARGET does not ship migration $EXPECT_HEAD: nothing was stopped"; exit 1; }

step "0b. install and build TARGET in a staging directory (production untouched)"
STAGE=~/r4-deploy-stage/$TARGET; rm -rf "$STAGE"; mkdir -p "$STAGE"
(cd "$R" && git archive "$TARGET") | tar -x -C "$STAGE"
(cd "$STAGE" && npm ci --no-audit --no-fund > /tmp/r4-deploy-stage-npmci.log 2>&1) || { tail -5 /tmp/r4-deploy-stage-npmci.log; echo "staging install failed: nothing was stopped"; exit 1; }
(cd "$STAGE" && npm run build > /tmp/r4-deploy-stage-build.log 2>&1) || { tail -5 /tmp/r4-deploy-stage-build.log; echo "staging build failed: nothing was stopped"; exit 1; }
for f in agents/sales/dist/cli/production.js agents/sales/dist/cli/production-control.js apps/api/dist/migrate.js apps/scheduler/dist/main.js; do [ -e "$STAGE/$f" ] || { echo "staging build lacks $f: nothing was stopped"; exit 1; }; done
echo "staging build of $TARGET OK"; rm -rf "$STAGE"
if [ "${CHECK_ONLY:-0}" = 1 ]; then step "CHECK ONLY: $TARGET is deployable over $PREV_FULL; nothing was backed up or stopped"; exit 0; fi

step "1. fresh backup (production running)"
TS=$(date -u +%Y%m%dT%H%M%SZ); B=~/backups/r4-production/$TS; mkdir -p "$B"
docker exec r4-production-postgres pg_dump -U r4_production -Fc -d r4_production > "$B/r4_production.dump"
docker exec r4-production-postgres pg_dumpall -U r4_production --roles-only > "$B/roles.sql"
cp "$C"/*.env "$C"/run-*.sh "$B/"; [ -d "$C/secrets" ] && mkdir -p "$B/secrets" && cp "$C"/secrets/*.env "$B/secrets/"; (cd "$R" && git rev-parse HEAD) > "$B/r4-sha.txt"
chmod -R go-rwx "$B"; (cd "$B" && find . -type f ! -name SHA256SUMS -exec sha256sum {} + > SHA256SUMS)
entries=$(docker exec -i r4-production-postgres pg_restore --list < "$B/r4_production.dump" | grep -c "TABLE DATA")
echo "backup $B ($entries table data entries)"; echo "$B" > ~/backups/r4-production/LATEST

step "2. stop the workers, drain the outbound, stop the gateway, then the kill switch"
for p in $WORKERS; do pm2 stop "$p" >/dev/null; done
for _ in $(seq 1 30); do [ "$(db "select count(*) from outbound_messages where status in ('pending','dispatching')")" = 0 ] && break; sleep 2; done
[ "$(db "select count(*) from outbound_messages where status in ('pending','dispatching')")" = 0 ] || { echo "outbound not drained: restarting workers"; for p in $WORKERS; do pm2 start "$p" >/dev/null; done; exit 1; }
pm2 stop "$GATEWAY" >/dev/null
envrun npm run -s production:sales:control -- autonomy off --reason "R4 $TARGET code deploy (owner-authorized); lane $LANE unchanged" > /dev/null 2>&1
[ "$(autonomy)" = '"autonomy": "disabled"' ] || { echo "kill switch not engaged"; exit 1; }

step "3. code $TARGET"
cd "$R"; git checkout -q "$TARGET"; [ "$(git rev-parse HEAD)" = "$TARGET" ]
npm ci --no-audit --no-fund > /tmp/r4-deploy-npmci.log 2>&1 || { tail -5 /tmp/r4-deploy-npmci.log; exit 1; }
npm run build > /tmp/r4-deploy-build.log 2>&1 || { tail -5 /tmp/r4-deploy-build.log; exit 1; }
echo "built $(git log --oneline -1)"

step "4. migrations (expected head $EXPECT_HEAD)"
envrun npm run -s db:migrate > /tmp/r4-deploy-coremigrate.log 2>&1 || { tail -5 /tmp/r4-deploy-coremigrate.log; exit 1; }
envrun npm run -s sales:migrate > /tmp/r4-deploy-salesmigrate.log 2>&1 || { tail -5 /tmp/r4-deploy-salesmigrate.log; exit 1; }
grep -oE '"applied":\[[^]]*\]' /tmp/r4-deploy-coremigrate.log | head -1
[ "$(db "select id from r4_schema_migrations order by id desc limit 1")" = "$EXPECT_HEAD" ] || { echo "head is not $EXPECT_HEAD"; exit 1; }

step "5. start in order (lane still $LANE)"
for p in $WORKERS $GATEWAY; do pm2 start "$p" >/dev/null; sleep 3; done
sleep 15

step "6. verify"
pm2 jlist | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const want=["r4-channel-gateway","r4-sales-worker","r4-sales-worker-lane","r4-scheduler"];const r=JSON.parse(s).filter(p=>want.includes(p.name));for(const p of r)console.log(p.name,p.pm2_env.status);if(r.length!==4||r.some(p=>p.pm2_env.status!=="online"))process.exit(1)})'
curl -sf -m 5 127.0.0.1:8090/health >/dev/null && echo "gateway /health 200"
for f in r4-sales-worker r4-sales-worker-lane; do tail -60 ~/.pm2/logs/$f-out.log | grep -oE '"compatibility":"[^"]*"' | tail -1 | sed "s/^/$f /"; done
grep -E '^R4_PROD_LANE_PROFILE=' "$C/production.env"; grep -E '^R4_PROD_POLICY_PROFILE=' "$C/production-lane.env"

step "7. autonomy on; holds in the window (expected 0)"
envrun npm run -s production:sales:control -- autonomy on --reason "R4 $TARGET deployed; lane $LANE unchanged" > /dev/null 2>&1
[ "$(autonomy)" = '"autonomy": "enabled"' ] || { echo "autonomy not restored"; exit 1; }; autonomy
pm2 save >/dev/null
echo "kill-switch holds since $STARTED: $(db "select count(*) from inbound_events where disposition = 'held:autonomy_disabled' and received_at >= '$STARTED'")"
step "DEPLOY DONE ($(cd "$R" && git rev-parse --short HEAD), head $EXPECT_HEAD)"
