#!/usr/bin/env bash
# ROLLBACK of a production identity HMAC rotation (owner-authorized). Uses the backup dir of rotate-production.sh:
#   B=~/backups/r4-production/identity-rotation-<ts> bash rollback-production.sh
# Same tool with the keys swapped: every binding (including those opened after the rotation) is verified under the NEW
# key and rewritten under the OLD one; the old key and lists go back into the env files (only those lines); the database
# is verified under the key the files then hold (a key file that does not match the configuration cannot go unnoticed);
# continuity is checked against the rotation's snapshot; workers restart with the old key, autonomy is restored, and only
# then the gateway starts. Last resort if this fails: pg_restore of $B/r4_production.dump (owner decision; it loses
# whatever happened after the rotation).
set -euo pipefail
umask 077
: "${B:?set B=<backup dir of the rotation>}"
R=${R4_REPO:-~/R4-agent-platform}; C=${R4_CONFIG:-~/.config/r4}
PG=${R4_PG_CONTAINER:-r4-production-postgres}; PGU=${R4_PG_USER:-r4_production}; PGD=${R4_PG_DB:-r4_production}
HEALTH=${R4_GATEWAY_HEALTH:-127.0.0.1:8090/health}
export R4_REPO=$R
TOOL="$B/tool"
WORKERS="r4-scheduler r4-sales-worker r4-sales-worker-lane"; GATEWAY=r4-channel-gateway
step() { echo "== $(date -u +%T) (+${SECONDS}s) $*"; }
db() { docker exec "$PG" psql -U "$PGU" -d "$PGD" -At -c "$1"; }
envrun() { (cd "$R" && set -a && . "$C/production.env" && set +a && "$@"); }
for f in old.key new.key production.env production-lane.env lists.env continuity.json SHA256SUMS tool/rotate.mjs tool/continuity.mjs; do [ -f "$B/$f" ] || { echo "missing $B/$f"; exit 1; }; done
(cd "$B" && sha256sum -c --quiet SHA256SUMS) || { echo "backup checksums do not match"; exit 1; }
STARTED=$(date -u +%FT%TZ)

step "1. stop (workers, gateway), kill switch"
for p in $WORKERS $GATEWAY; do pm2 stop "$p" >/dev/null; done; T_GW_DOWN=$SECONDS
envrun npm run -s production:sales:control -- autonomy off --reason "identity rotation rollback (owner-authorized)" >/dev/null 2>&1
for _ in $(seq 1 15); do [ "$(db "select count(*) from pg_stat_activity where usename='$PGU' and datname='$PGD' and client_addr is not null and application_name like 'r4-%' and application_name not like 'r4-identity-%'")" = 0 ] && break; sleep 2; done
[ "$(db "select count(*) from inbound_events where status='received'")" = 0 ] || { echo "unsettled inbound: start the gateway to drain it, then rerun"; exit 1; }

step "2. the rotated configuration as the tool's input (new key + recomputed lists; the database of the env files)"
{ echo "R4_PROD_IDENTITY_HASH_KEY='$(cat "$B/new.key")'"; sed "s/^\([A-Z0-9_]*\)=\(.*\)$/\1='\2'/" "$B/lists.env"; grep -E '^R4_(PROD_ROLLOUT_PERCENT|DATABASE_URL)=' "$C/production.env"; } > "$B/rotated.env"

step "3. apply with the keys swapped (verifies every row under the new key first)"
node "$TOOL/rotate.mjs" apply --env-file "$B/rotated.env" --new-key-file "$B/old.key" --out "$B/back.env"

step "4. the old key and lists back into the env files (only those lines: later edits survive); verify under the key they hold; continuity"
cp -p "$C/production.env" "$B/production.env.rotated"
node "$TOOL/rotate.mjs" install --env-file "$C/production.env" --env-file "$C/production-lane.env" --new-key-file "$B/old.key" --lists "$B/back.env" --old-env-file "$B/production.env.rotated"
node "$TOOL/rotate.mjs" verify --env-file "$C/production.env" --env-file "$C/production-lane.env" --key-from-env
node "$TOOL/continuity.mjs" check --env-file "$C/production.env" --env-file "$C/production-lane.env" --repo "$R" --snapshot "$B/continuity.json" || { echo "FAILED: continuity after the rollback"; exit 1; }

step "5. workers with the old key (clean pm2 environment), autonomy on, THEN the gateway"
# Only the processes that compute conversation keys get the key (the scheduler never held it and does not get it).
for p in $WORKERS; do
  if [ "$p" = r4-scheduler ]; then env -i HOME="$HOME" PATH="$PATH" pm2 restart "$p" --update-env >/dev/null
  else env -i HOME="$HOME" PATH="$PATH" R4_PROD_IDENTITY_HASH_KEY="$(cat "$B/old.key")" pm2 restart "$p" --update-env >/dev/null; fi
  sleep 3
done
envrun npm run -s production:sales:control -- autonomy on --reason "identity rotation rolled back (owner-authorized)" >/dev/null 2>&1
env -i HOME="$HOME" PATH="$PATH" R4_PROD_IDENTITY_HASH_KEY="$(cat "$B/old.key")" pm2 restart "$GATEWAY" --update-env >/dev/null; T_GW_UP=$SECONDS
sleep 12; pm2 save >/dev/null
curl -sf -m 5 "$HEALTH" >/dev/null || { echo "FAILED: gateway /health"; exit 1; }
echo "kill-switch holds since $STARTED: $(db "select count(*) from inbound_events where disposition = 'held:autonomy_disabled' and received_at >= '$STARTED'")"
echo "window: gateway down $((T_GW_UP - T_GW_DOWN)) s"
step "ROLLBACK DONE"
