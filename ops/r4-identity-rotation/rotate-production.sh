#!/usr/bin/env bash
# PRODUCTION rotation of R4_PROD_IDENTITY_HASH_KEY. NOT to be run without the owner's explicit authorization, and only
# after restored-copy-test.sh passed on a fresh copy. Prints counts only (never a key, a wa_id or a derived key).
#   SHA=<deployed short sha> bash rotate-production.sh
#
# Until the database commit (step 6) any failure RESTORES production (processes started, autonomy as found) and changes
# nothing. After the commit a failure stops with "DATABASE ROTATED": run rollback-production.sh B=<backup dir>.
# Order (no kill-switch hold window): workers stop first (the gateway keeps ingesting and delivering), the outbound
# drains, the gateway stops (Meta retries webhooks), only then the kill switch is engaged.
set -euo pipefail
umask 077
: "${SHA:?set SHA=<deployed short sha>}"
HERE=$(cd "$(dirname "$0")" && pwd)
R=~/R4-agent-platform; C=~/.config/r4
B=~/backups/r4-production/identity-rotation-$(date -u +%Y%m%dT%H%M%SZ)
WORKERS="r4-scheduler r4-sales-worker r4-sales-worker-lane"; GATEWAY=r4-channel-gateway; PROCS="$WORKERS $GATEWAY"
step() { echo "== $(date -u +%T) $*"; }
db() { docker exec r4-production-postgres psql -U r4_production -d r4_production -At -c "$1"; }
envrun() { (cd "$R" && set -a && . "$C/production.env" && set +a && "$@"); }
autonomy() { envrun npm run -s production:sales:control -- autonomy status | grep -oE '"autonomy": "[a-z]+"' | head -1 || true; }
setautonomy() { envrun npm run -s production:sales:control -- autonomy "$1" --reason "$2" >/dev/null 2>&1; }
ENVS=(--env-file "$C/production.env" --env-file "$C/production-lane.env")
TOOL="$B/tool"; PHASE=preflight; BEFORE_AUTONOMY=''; STARTED=$(date -u +%FT%TZ)

on_exit() {
  local code=$?
  [ "$code" = 0 ] && return
  if [ "$PHASE" = committed ]; then
    echo "!! FAILED AFTER THE DATABASE COMMIT: DATABASE ROTATED. Run: B=$B bash $HERE/rollback-production.sh"
  elif [ "$PHASE" != preflight ]; then
    echo "!! aborted before the commit: restoring production (nothing in the database changed)"
    for p in $PROCS; do pm2 start "$p" >/dev/null 2>&1 || true; done
    [ "$BEFORE_AUTONOMY" = '"autonomy": "enabled"' ] && setautonomy on "identity rotation aborted before commit (restored)" || true
    echo "autonomy now: $(autonomy)"
  fi
}
trap on_exit EXIT
settled() {
  [ "$(db "select count(*) from action_executions where status not in ('succeeded','failed','rejected')")" = 0 ] || { echo "ABORT: an action is not settled"; exit 1; }
  [ "$(db "select count(*) from outbound_messages where status in ('pending','dispatching','unknown')")" = 0 ] || { echo "ABORT: outbound not settled"; exit 1; }
}
wait_for() { for _ in $(seq 1 "$2"); do [ "$(db "$1")" = 0 ] && return 0; sleep 2; done; echo "ABORT: timed out waiting: $3"; exit 1; }

step "0. preconditions (production running)"
[ "$(cd "$R" && git rev-parse --short HEAD)" = "$SHA" ] || { echo "deployed SHA is not $SHA"; exit 1; }
settled
BEFORE_AUTONOMY=$(autonomy); echo "autonomy: $BEFORE_AUTONOMY"

step "1. tools, old key (same parser as the deployment) and new key (CSPRNG, 256 bits) in a 0700 backup dir"
mkdir -p "$TOOL"; cp "$HERE/rotation.mjs" "$HERE/rotate.mjs" "$TOOL/"; ln -s "$R/node_modules" "$TOOL/node_modules"
node "$TOOL/rotate.mjs" export-key "${ENVS[@]}" --out "$B/old.key" >/dev/null
node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))' > "$B/new.key"
echo "files holding the old key (names only): $({ grep -rlF -f "$B/old.key" "$C" ~/.config/r4-web-qa ~/transport 2>/dev/null || true; } | sed "s#$HOME#~#" | paste -sd ' ')"

step "2. plan (read-only, production running): env shape, rollout 0 %, every binding and list entry verifiable"
node "$TOOL/rotate.mjs" plan "${ENVS[@]}" --new-key-file "$B/new.key" || { echo "ABORT: plan blocked; nothing changed"; exit 1; }

PHASE=stopping
step "3. stop the workers, drain the outbound, stop the gateway, then engage the kill switch"
for p in $WORKERS; do pm2 stop "$p" >/dev/null; done
wait_for "select count(*) from outbound_messages where status in ('pending','dispatching')" 30 "outbound drain"
pm2 stop "$GATEWAY" >/dev/null
setautonomy off "identity HMAC rotation (owner-authorized)"
[ "$(autonomy)" = '"autonomy": "disabled"' ] || { echo "ABORT: kill switch not engaged"; exit 1; }
wait_for "select count(*) from pg_stat_activity where usename='r4_production' and client_addr is not null and application_name like 'r4-%'" 15 "R4 sessions to close"
settled
[ "$(db "select count(*) from inbound_events where status='received'")" = 0 ] || { echo "ABORT: unsettled inbound (the restart drains it; retry later)"; exit 1; }

step "4. backup (database dump, configuration, pm2 dump)"
docker exec r4-production-postgres pg_dump -U r4_production -Fc -d r4_production > "$B/r4_production.dump"
cp -p "$C/production.env" "$C/production-lane.env" ~/.pm2/dump.pm2 "$B/"
(cd "$B" && sha256sum r4_production.dump production.env production-lane.env dump.pm2 > SHA256SUMS); echo "$B"

step "5. plan again with production stopped"
node "$TOOL/rotate.mjs" plan "${ENVS[@]}" --new-key-file "$B/new.key" >/dev/null || { echo "ABORT: plan blocked with production stopped"; exit 1; }

step "6. apply (one transaction; refuses on any blocker)"
PHASE=committing
node "$TOOL/rotate.mjs" apply "${ENVS[@]}" --new-key-file "$B/new.key" --out "$B/lists.env"
PHASE=committed

step "7. install the new key and the recomputed lists in the env files (atomic; checked; no old value survives)"
node "$TOOL/rotate.mjs" install "${ENVS[@]}" --new-key-file "$B/new.key" --lists "$B/lists.env" --old-env-file "$B/production.env"

step "8. verify the database under the key the env files now hold"
node "$TOOL/rotate.mjs" verify "${ENVS[@]}" --key-from-env

step "9. start (gateway last) with a clean pm2 environment: only the new key is injected, the old value is purged"
for p in $WORKERS $GATEWAY; do env -i HOME="$HOME" PATH="$PATH" R4_PROD_IDENTITY_HASH_KEY="$(cat "$B/new.key")" pm2 restart "$p" --update-env >/dev/null; sleep 3; done
sleep 12; pm2 save >/dev/null
[ "$(grep -cF -f "$B/old.key" ~/.pm2/dump.pm2 || true)" = 0 ] || { echo "FAILED: the pm2 dump still holds the old key"; exit 1; }
pm2 jlist | PROCS="$PROCS" node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const want=process.env.PROCS.split(" ");const r=JSON.parse(s).filter(p=>want.includes(p.name));for(const p of r)console.log(p.name,p.pm2_env.status);if(r.length!==want.length||r.some(p=>p.pm2_env.status!=="online"))process.exit(1)})'
curl -sf -m 5 127.0.0.1:8090/health >/dev/null || { echo "FAILED: gateway /health"; exit 1; }
echo "gateway /health 200"

step "10. autonomy back to its previous state; holds created during the window (expected 0)"
[ "$BEFORE_AUTONOMY" = '"autonomy": "enabled"' ] && setautonomy on "identity HMAC rotated and verified (owner-authorized)"
echo "autonomy now: $(autonomy)"
echo "kill-switch holds since $STARTED: $(db "select count(*) from inbound_events where disposition = 'held:autonomy_disabled' and received_at >= '$STARTED'") (a person must release any)"
PHASE=done
echo "the old key stays only in $B (0600) for the rollback window; shred it when the owner closes the rotation"
step "ROTATION DONE: the allowlisted owner sends one message; it must land on the existing conversation (same binding)"
