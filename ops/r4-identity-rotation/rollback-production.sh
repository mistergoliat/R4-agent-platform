#!/usr/bin/env bash
# ROLLBACK of a production identity HMAC rotation (owner-authorized). Uses the backup dir of rotate-production.sh:
#   B=~/backups/r4-production/identity-rotation-<ts> bash rollback-production.sh
# Same tool with the keys swapped: every binding (including those opened after the rotation) is verified under the NEW
# key and rewritten under the OLD one. The input lists are the ones the env files hold NOW (list entries added after the
# rotation are carried back too; an added entry with no binding blocks, like in a rotation). The old key and lists go
# back into the env files (only those lines; if the rotation never installed them, nothing is installed); the database
# is verified under the key the files then hold; continuity is checked against the rotation's snapshot; workers restart
# with the old key, autonomy returns to the state found before this rollback stopped anything, and only then the gateway
# starts. Last resort if this fails: pg_restore of $B/r4_production.dump (owner decision; it loses whatever happened
# after the rotation).
set -euo pipefail
umask 077
: "${B:?set B=<backup dir of the rotation>}"
R=${R4_REPO:-~/R4-agent-platform}; C=${R4_CONFIG:-~/.config/r4}
PG=${R4_PG_CONTAINER:-r4-production-postgres}; PGU=${R4_PG_USER:-r4_production}; PGD=${R4_PG_DB:-r4_production}
HEALTH=${R4_GATEWAY_HEALTH:-127.0.0.1:8090/health}; PM2_DIR=${PM2_HOME:-~/.pm2}
export R4_REPO=$R
TOOL="$B/tool"; PHASE=preflight; BEFORE_AUTONOMY=''
WORKERS="r4-scheduler r4-sales-worker r4-sales-worker-lane"; GATEWAY=r4-channel-gateway
ENVS=(--env-file "$C/production.env" --env-file "$C/production-lane.env")
step() { echo "== $(date -u +%T) (+${SECONDS}s) $*"; }
db() { docker exec "$PG" psql -U "$PGU" -d "$PGD" -At -c "$1"; }
envrun() { (cd "$R" && set -a && . "$C/production.env" && set +a && "$@"); }
autonomy() { envrun npm run -s production:sales:control -- autonomy status | grep -oE '"autonomy": "[a-z]+"' | head -1 || true; }
setautonomy() { envrun npm run -s production:sales:control -- autonomy "$1" --reason "$2" >/dev/null 2>&1; }
wait_for() { for _ in $(seq 1 "$2"); do [ "$(db "$1")" = 0 ] && return 0; sleep 2; done; echo "!! TIMED OUT waiting: $3"; exit 1; }
settled() {
  [ "$(db "select count(*) from action_executions where status not in ('succeeded','failed','rejected')")" = 0 ] || { echo "!! an action is not settled"; exit 1; }
  [ "$(db "select count(*) from outbound_messages where status in ('pending','dispatching','unknown')")" = 0 ] || { echo "!! outbound not settled"; exit 1; }
}
# Same as rotate-production.sh: pm2's stored environment replaced by HOME, PATH and (not for the scheduler) the key,
# read from its file inside the child, never on a command line.
restart() {
  if [ "$1" = r4-scheduler ]; then env -i HOME="$HOME" PATH="$PATH" pm2 restart "$1" --update-env >/dev/null
  else env -i HOME="$HOME" PATH="$PATH" bash -c 'export R4_PROD_IDENTITY_HASH_KEY; R4_PROD_IDENTITY_HASH_KEY=$(cat "$1"); exec pm2 restart "$0" --update-env' "$1" "$2" >/dev/null; fi
}
on_exit() {
  local code=$?
  [ "$code" = 0 ] && return
  case $PHASE in
    preflight) echo "!! ROLLBACK REFUSED before stopping anything: production untouched" ;;
    stopped) echo "!! ROLLBACK FAILED with production STOPPED and the kill switch on; the database is still ROTATED (new key). Fix the cause and rerun this script, or restart under the new key: the env files were not changed" ;;
    applied) echo "!! ROLLBACK FAILED with production STOPPED and the kill switch on; the database is BACK under the OLD key. Finish by hand: install the old key/lists ($B/back.env) if the files still hold the new key, verify, restart with $B/old.key, autonomy as it was ($BEFORE_AUTONOMY), gateway last" ;;
    restarting) echo "!! ROLLBACK FAILED while restarting: database and env files are on the OLD key; check the processes (pm2 jlist), autonomy (was $BEFORE_AUTONOMY) and /health" ;;
  esac
}
trap on_exit EXIT

for f in old.key new.key production.env production-lane.env lists.env continuity.json SHA256SUMS tool/rotate.mjs tool/continuity.mjs; do [ -f "$B/$f" ] || { echo "missing $B/$f"; exit 1; }; done
(cd "$B" && sha256sum -c --quiet SHA256SUMS) || { echo "backup checksums do not match"; exit 1; }
BEFORE_AUTONOMY=$(autonomy); [ -n "$BEFORE_AUTONOMY" ] || { echo "the autonomy status cannot be read"; exit 1; }
echo "autonomy: $BEFORE_AUTONOMY"
node "$TOOL/rotate.mjs" export-key "${ENVS[@]}" --out "$B/current.key" >/dev/null
if cmp -s "$B/current.key" "$B/old.key"; then INSTALLED=0; elif cmp -s "$B/current.key" "$B/new.key"; then INSTALLED=1; else echo "the env files hold neither key of this rotation: stop"; exit 1; fi
shred -u "$B/current.key" 2>/dev/null || rm -f "$B/current.key"
STARTED=$(date -u +%FT%TZ)

PHASE=stopped
step "1. stop the workers, drain the outbound, stop the gateway, kill switch"
for p in $WORKERS; do pm2 stop "$p" >/dev/null; done
wait_for "select count(*) from outbound_messages where status in ('pending','dispatching')" 30 "outbound drain"
pm2 stop "$GATEWAY" >/dev/null; T_GW_DOWN=$SECONDS
setautonomy off "identity rotation rollback (owner-authorized)"
[ "$(autonomy)" = '"autonomy": "disabled"' ] || { echo "!! kill switch not engaged"; exit 1; }
wait_for "select count(*) from pg_stat_activity where usename='$PGU' and datname='$PGD' and client_addr is not null and application_name like 'r4-%' and application_name not like 'r4-identity-%'" 15 "R4 sessions to close"
settled
[ "$(db "select count(*) from inbound_events where status='received'")" = 0 ] || { echo "!! unsettled inbound: start the gateway to drain it, then rerun"; exit 1; }

step "2. the tool's input: the env files as they are now (new key, current lists), or the rotation's key and lists if they were never installed"
if [ "$INSTALLED" = 1 ]; then
  IN=("${ENVS[@]}")
else
  { echo "R4_PROD_IDENTITY_HASH_KEY='$(cat "$B/new.key")'"; sed "s/^\([A-Z0-9_]*\)=\(.*\)$/\1='\2'/" "$B/lists.env"; grep -E '^R4_(PROD_ROLLOUT_PERCENT|DATABASE_URL)=' "$C/production.env"; } > "$B/rotated.env"
  IN=(--env-file "$B/rotated.env")
fi

step "3. apply with the keys swapped (verifies every row under the new key first)"
set +e; node "$TOOL/rotate.mjs" apply "${IN[@]}" --new-key-file "$B/old.key" --out "$B/back.env"; rc=$?; set -e
[ "$rc" = 0 ] || { [ "$rc" = 3 ] && echo "!! apply refused and rolled back" || echo "!! apply OUTCOME UNKNOWN: check with verify under each key"; exit 1; }
PHASE=applied

step "4. the old key and lists back into the env files (only those lines); verify under the key they hold; continuity"
if [ "$INSTALLED" = 1 ]; then
  cp -p "$C/production.env" "$B/production.env.rotated"; cp -p "$C/production-lane.env" "$B/production-lane.env.rotated"
  node "$TOOL/rotate.mjs" install "${ENVS[@]}" --new-key-file "$B/old.key" --lists "$B/back.env" --old-env-file "$B/production.env.rotated" --old-env-file "$B/production-lane.env.rotated"
else
  echo "the env files already hold the old key: nothing to install"
fi
node "$TOOL/rotate.mjs" verify "${ENVS[@]}" --key-from-env
node "$TOOL/continuity.mjs" check "${ENVS[@]}" --repo "$R" --snapshot "$B/continuity.json" || { echo "!! continuity after the rollback"; exit 1; }

PHASE=restarting
step "5. workers with the old key, autonomy as found before this rollback, THEN the gateway"
for p in $WORKERS; do restart "$p" "$B/old.key"; sleep 3; done
if [ "$BEFORE_AUTONOMY" = '"autonomy": "enabled"' ]; then setautonomy on "identity rotation rolled back (owner-authorized)"
elif [ "$(cat "$B/autonomy.before" 2>/dev/null)" = '"autonomy": "enabled"' ]; then echo "NOTE: autonomy stays disabled (found so); it was enabled before the rotation: turn it on by hand once checked"; fi
echo "autonomy now: $(autonomy)"
restart "$GATEWAY" "$B/old.key"; T_GW_UP=$SECONDS
sleep 12; pm2 save >/dev/null; pm2 save >/dev/null
left=$(grep -lF -f "$B/new.key" "$PM2_DIR"/dump.pm2* 2>/dev/null || true)
[ -z "$left" ] || { echo "!! pm2 dump files still hold the rotated key"; exit 1; }
curl -sf -m 5 "$HEALTH" >/dev/null || { echo "!! gateway /health"; exit 1; }
echo "kill-switch holds since $STARTED: $(db "select count(*) from inbound_events where disposition = 'held:autonomy_disabled' and received_at >= '$STARTED'")"
PHASE=done
echo "window: gateway down $((T_GW_UP - T_GW_DOWN)) s"
step "ROLLBACK DONE"
