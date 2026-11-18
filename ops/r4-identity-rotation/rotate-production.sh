#!/usr/bin/env bash
# PRODUCTION rotation of R4_PROD_IDENTITY_HASH_KEY. Only with the owner's explicit authorization. Prints counts, file
# names and timings only (never a key, a wa_id or a derived key). Runbook: docs/architecture/R4_IDENTITY_HMAC_ROTATION.md.
#   SHA=<deployed short sha> LANE=sales-production@22 bash rotate-production.sh
#   PREFLIGHT_ONLY=1 SHA=... LANE=... bash rotate-production.sh     steps 0-2 only (read-only, production running)
#
# Until the database commit (step 6) any failure RESTORES production (processes started, autonomy as found) and changes
# nothing. After the commit a failure stops with "DATABASE ROTATED": run rollback-production.sh B=<backup dir>.
# Window: workers stop first (the gateway keeps ingesting and delivering), the outbound drains, the gateway stops (Meta
# retries webhooks), then the kill switch. On the way back the workers start under the new key, autonomy is restored,
# and only then the gateway starts: no inbound can reach R4 while autonomy is off, so the window creates no holds.
set -euo pipefail
umask 077
: "${SHA:?set SHA=<deployed short sha>}" "${LANE:?set LANE=<current lane profile, e.g. sales-production@22>}"
HERE=$(cd "$(dirname "$0")" && pwd)
# The defaults are production; local-rehearsal.sh overrides them to run this same script against a throwaway copy.
R=${R4_REPO:-~/R4-agent-platform}; C=${R4_CONFIG:-~/.config/r4}; BACKUPS=${R4_BACKUPS:-~/backups/r4-production}
PG=${R4_PG_CONTAINER:-r4-production-postgres}; PGU=${R4_PG_USER:-r4_production}; PGD=${R4_PG_DB:-r4_production}
HEALTH=${R4_GATEWAY_HEALTH:-127.0.0.1:8090/health}; PM2_DIR=${PM2_HOME:-~/.pm2}; PM2_DUMP=$PM2_DIR/dump.pm2
WEBQA=${R4_WEB_QA_CONFIG:-~/.config/r4-web-qa}
# Other ACTIVE places where a copy of the key or of a list would silently undo the rotation (scripts that write env files).
ACTIVE_EXTRA=${R4_ACTIVE_EXTRA:-"$HOME/r4-lane-switch-v2.sh $HOME/r4-inbound-media $HOME/r4-deploy.sh"}
HISTORY=${R4_HISTORY_DIRS:-"$C $BACKUPS $HOME/transport $WEBQA $PM2_DIR"}
export R4_REPO=$R
B=$BACKUPS/identity-rotation-$(date -u +%Y%m%dT%H%M%SZ)
WORKERS="r4-scheduler r4-sales-worker r4-sales-worker-lane"; GATEWAY=r4-channel-gateway; PROCS="$WORKERS $GATEWAY"
step() { echo "== $(date -u +%T) (+${SECONDS}s) $*"; }
db() { docker exec "$PG" psql -U "$PGU" -d "$PGD" -At -c "$1"; }
envrun() { (cd "$R" && set -a && . "$C/production.env" && set +a && "$@"); }
autonomy() { envrun npm run -s production:sales:control -- autonomy status | grep -oE '"autonomy": "[a-z]+"' | head -1 || true; }
setautonomy() { envrun npm run -s production:sales:control -- autonomy "$1" --reason "$2" >/dev/null 2>&1; }
ENVS=(--env-file "$C/production.env" --env-file "$C/production-lane.env")
TOOL="$B/tool"; PHASE=preflight; BEFORE_AUTONOMY=''; STARTED=$(date -u +%FT%TZ)
T_GW_DOWN=0; T_AUTONOMY_OFF=0; T_AUTONOMY_ON=0; T_GW_UP=0

on_exit() {
  local code=$?
  [ "$code" = 0 ] && return
  if [ "$PHASE" = committed ]; then
    echo "!! FAILED AFTER THE DATABASE COMMIT: DATABASE ROTATED. Run: B=$B bash $HERE/rollback-production.sh"
    return
  elif [ "$PHASE" = committing ]; then
    # The apply process died: its transaction either committed or not. Never guess: everything stays stopped.
    echo "!! apply did not finish: production stays STOPPED. Find out which key the bindings verify under:"
    echo "   node $TOOL/rotate.mjs verify ${ENVS[*]} --new-key-file $B/new.key   (ok + rewrittenVerified = total: rotated -> B=$B bash $HERE/rollback-production.sh, or finish by hand from step 7)"
    echo "   node $TOOL/rotate.mjs verify ${ENVS[*]} --key-from-env              (ok: not rotated -> start the processes and set autonomy as it was)"
    return
  elif [ "$PHASE" != preflight ]; then
    echo "!! aborted before the commit: restoring production (nothing in the database changed)"
    for p in $WORKERS; do pm2 start "$p" >/dev/null 2>&1 || true; done
    [ "$BEFORE_AUTONOMY" = '"autonomy": "enabled"' ] && setautonomy on "identity rotation aborted before commit (restored)" || true
    pm2 start "$GATEWAY" >/dev/null 2>&1 || true
    echo "autonomy now: $(autonomy)"
  fi
  # Nothing was rotated: the key files (and any dump) of this attempt are of no use; shred them.
  [ -d "$B" ] && { find "$B" -type f -exec shred -u {} + 2>/dev/null; rm -rf "$B"; echo "attempt files shredded ($B)"; }
}
trap on_exit EXIT
settled() {
  [ "$(db "select count(*) from action_executions where status not in ('succeeded','failed','rejected')")" = 0 ] || { echo "ABORT: an action is not settled"; exit 1; }
  [ "$(db "select count(*) from outbound_messages where status in ('pending','dispatching','unknown')")" = 0 ] || { echo "ABORT: outbound not settled"; exit 1; }
}
wait_for() { for _ in $(seq 1 "$2"); do [ "$(db "$1")" = 0 ] && return 0; sleep 2; done; echo "ABORT: timed out waiting: $3"; exit 1; }
online() { pm2 jlist | PROCS="$1" node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const want=process.env.PROCS.split(" ");const r=JSON.parse(s).filter(p=>want.includes(p.name));for(const p of r)console.log(p.name,p.pm2_env.status);if(r.length!==want.length||r.some(p=>p.pm2_env.status!=="online"))process.exit(1)})'; }
names() { sed "s#$HOME#~#" | sort -u | paste -sd ' ' -; }
# pm2's stored environment for the process is REPLACED by a minimal one: HOME, PATH and, for the processes that compute
# conversation keys, the key, read from its file inside the child (never on a command line). The scheduler never held
# the key and does not get it. The run scripts source the env files themselves; this only purges what pm2 remembers.
restart() {
  if [ "$1" = r4-scheduler ]; then env -i HOME="$HOME" PATH="$PATH" pm2 restart "$1" --update-env >/dev/null
  else env -i HOME="$HOME" PATH="$PATH" bash -c 'export R4_PROD_IDENTITY_HASH_KEY; R4_PROD_IDENTITY_HASH_KEY=$(cat "$1"); exec pm2 restart "$0" --update-env' "$1" "$2" >/dev/null; fi
}

step "0. preconditions (production running)"
[ "$(cd "$R" && git rev-parse --short HEAD)" = "$SHA" ] || { echo "deployed SHA is not $SHA"; exit 1; }
grep -q "^R4_PROD_LANE_PROFILE=$LANE$" "$C/production.env" && grep -q "^R4_PROD_POLICY_PROFILE=$LANE$" "$C/production-lane.env" || { echo "lane is not $LANE"; exit 1; }
online "$PROCS" >/dev/null || { echo "not every R4 process is online ($PROCS)"; exit 1; }
curl -sf -m 5 "$HEALTH" >/dev/null || { echo "gateway /health is not 200"; exit 1; }
settled
BEFORE_AUTONOMY=$(autonomy); echo "autonomy: $BEFORE_AUTONOMY"
[ -n "$BEFORE_AUTONOMY" ] || { echo "ABORT: the autonomy status cannot be read (production:sales:control)"; exit 1; }

step "1. tools; old key and its lists (same parser as the deployment); new key (CSPRNG, 256 bits); copies of the old values"
mkdir -p "$TOOL"; cp "$HERE/rotation.mjs" "$HERE/rotate.mjs" "$HERE/continuity.mjs" "$TOOL/"; echo "$BEFORE_AUTONOMY" > "$B/autonomy.before"
node "$TOOL/rotate.mjs" export-key "${ENVS[@]}" --out "$B/old.key" --values-out "$B/old.values" >/dev/null
node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))' > "$B/new.key"
[ -s "$B/old.key" ] && [ "$(wc -c < "$B/new.key")" -eq 64 ] || { echo "ABORT: key files not written"; exit 1; }
# A managed variable defined anywhere else a process sources would override the rotated value.
shadow=$( { grep -lE '^[[:space:]]*(export[[:space:]]+)?R4_PROD_(IDENTITY_HASH_KEY|ROLLOUT_ALLOWLIST|ROLLOUT_DENYLIST|LANE_ALLOWLIST)=' "$C"/*.env "$C"/secrets/*.env "$C"/run-*.sh 2>/dev/null || true; } | grep -vxF -e "$C/production.env" -e "$C/production-lane.env" || true)
[ -z "$shadow" ] || { echo "ABORT: a managed variable is also defined in: $(echo "$shadow" | names) (keep it only in production.env / production-lane.env)"; exit 1; }
# The web QA deployment has its own key (generated at its deploy): if it holds a production value, rotate it apart first.
webqa=$( { grep -rlF -f "$B/old.values" "$WEBQA" 2>/dev/null || true; } | grep -vE '\.bak|\.pre-|/bak' || true)
[ -z "$webqa" ] || { echo "ABORT: the web QA deployment holds the production key or a list entry ($(echo "$webqa" | names)): rotate it separately first (runbook §7)"; exit 1; }
# Any other active file holding the old key or an old list entry would undo the rotation the next time it is used.
active=$( { grep -lF -f "$B/old.values" "$C"/*.env "$C"/secrets/*.env "$C"/run-*.sh 2>/dev/null; for x in $ACTIVE_EXTRA; do [ -e "$x" ] && grep -rlF -f "$B/old.values" "$x" 2>/dev/null; done; true; } | grep -vxF -e "$C/production.env" -e "$C/production-lane.env" || true)
[ -z "$active" ] || { echo "ABORT: active files hold the old key or an old list entry: $(echo "$active" | names)"; exit 1; }
echo "historical copies of the old values (names only; shred after the rollback window): $( { for d in $HISTORY; do [ -e "$d" ] && grep -rlF -f "$B/old.values" "$d" 2>/dev/null; done; true; } | grep -vF "$B/" | grep -vxF -e "$C/production.env" -e "$C/production-lane.env" | names)"

step "2. plan (read-only, production running): env shape, rollout 0/100 %, every binding and list entry verifiable, no lineage orphan"
node "$TOOL/rotate.mjs" plan "${ENVS[@]}" --new-key-file "$B/new.key" || { echo "ABORT: plan blocked; nothing changed"; exit 1; }
if [ "${PREFLIGHT_ONLY:-0}" = 1 ]; then find "$B" -type f -exec shred -u {} +; rm -rf "$B"; step "PREFLIGHT ONLY: ready; nothing was stopped; the key files were shredded"; exit 0; fi

PHASE=stopping
step "3. stop the workers, drain the outbound, stop the gateway, then engage the kill switch"
for p in $WORKERS; do pm2 stop "$p" >/dev/null; done
wait_for "select count(*) from outbound_messages where status in ('pending','dispatching')" 30 "outbound drain"
pm2 stop "$GATEWAY" >/dev/null; T_GW_DOWN=$SECONDS
setautonomy off "identity HMAC rotation (owner-authorized)"; T_AUTONOMY_OFF=$SECONDS
[ "$(autonomy)" = '"autonomy": "disabled"' ] || { echo "ABORT: kill switch not engaged"; exit 1; }
wait_for "select count(*) from pg_stat_activity where usename='$PGU' and datname='$PGD' and client_addr is not null and application_name like 'r4-%' and application_name not like 'r4-identity-%'" 15 "R4 sessions to close"
settled
[ "$(db "select count(*) from inbound_events where status='received'")" = 0 ] || { echo "ABORT: unsettled inbound (the restart drains it; retry later)"; exit 1; }

step "4. backup (database dump, configuration, pm2 dump)"
docker exec "$PG" pg_dump -U "$PGU" -Fc -d "$PGD" > "$B/r4_production.dump"
cp -p "$C/production.env" "$C/production-lane.env" "$PM2_DUMP" "$B/"
(cd "$B" && sha256sum r4_production.dump production.env production-lane.env dump.pm2 > SHA256SUMS); echo "$B"

step "5. plan again with production stopped; continuity snapshot (lineage, recovered quotes, carried turns, lists)"
node "$TOOL/rotate.mjs" plan "${ENVS[@]}" --new-key-file "$B/new.key" >/dev/null || { echo "ABORT: plan blocked with production stopped"; exit 1; }
node "$TOOL/continuity.mjs" snapshot "${ENVS[@]}" --repo "$R" --out "$B/continuity.json"

step "6. apply (one transaction; refuses on any blocker)"
PHASE=committing
set +e; node "$TOOL/rotate.mjs" apply "${ENVS[@]}" --new-key-file "$B/new.key" --out "$B/lists.env"; rc=$?; set -e
case $rc in
  0) PHASE=committed ;;
  3) PHASE=stopping; echo "ABORT: apply refused and rolled back (nothing changed)"; exit 1 ;;   # the trap restores production
  *) exit 1 ;;                                                                                  # outcome unknown: stays stopped
esac

step "7. install the new key and the recomputed lists in the env files (atomic; checked; no old value survives)"
node "$TOOL/rotate.mjs" install "${ENVS[@]}" --new-key-file "$B/new.key" --lists "$B/lists.env" --old-env-file "$B/production.env" --old-env-file "$B/production-lane.env"

step "8. verify under the key the env files now hold; continuity against the snapshot (before any restart)"
node "$TOOL/rotate.mjs" verify "${ENVS[@]}" --key-from-env
node "$TOOL/continuity.mjs" check "${ENVS[@]}" --repo "$R" --snapshot "$B/continuity.json" || { echo "FAILED: continuity"; exit 1; }

step "9. workers under the new key (pm2 environment replaced), autonomy as found, THEN the gateway"
for p in $WORKERS; do restart "$p" "$B/new.key"; sleep 3; done
if [ "$BEFORE_AUTONOMY" = '"autonomy": "enabled"' ]; then setautonomy on "identity HMAC rotated and verified (owner-authorized)"; fi
T_AUTONOMY_ON=$SECONDS; echo "autonomy now: $(autonomy)"
restart "$GATEWAY" "$B/new.key"; T_GW_UP=$SECONDS
# pm2 keeps the previous dump as dump.pm2.bak: the second save pushes the pre-rotation one out.
sleep 12; pm2 save >/dev/null; pm2 save >/dev/null
left=$(grep -lF -f "$B/old.values" "$PM2_DIR"/dump.pm2* 2>/dev/null || true)
[ -z "$left" ] || { echo "FAILED: pm2 dump files still hold an old value: $(echo "$left" | names)"; exit 1; }
online "$PROCS"
curl -sf -m 5 "$HEALTH" >/dev/null || { echo "FAILED: gateway /health"; exit 1; }
echo "gateway /health 200"

step "10. holds created during the window (expected 0); continuity again with everything running"
echo "kill-switch holds since $STARTED: $(db "select count(*) from inbound_events where disposition = 'held:autonomy_disabled' and received_at >= '$STARTED'") (a person must release any)"
node "$TOOL/continuity.mjs" check "${ENVS[@]}" --repo "$R" --snapshot "$B/continuity.json" || { echo "FAILED: continuity"; exit 1; }
PHASE=done
echo "window: gateway down $((T_GW_UP - T_GW_DOWN)) s; autonomy off $((T_AUTONOMY_ON - T_AUTONOMY_OFF)) s (inside the gateway-down window)"
echo "the old key stays only in $B (0600) for the rollback window; shred it when the owner closes the rotation"
step "ROTATION DONE. After a tester writes: R4_REPO=$R node $TOOL/continuity.mjs check ${ENVS[*]} --repo $R --snapshot $B/continuity.json --require-message"
