#!/usr/bin/env bash
# ROLLBACK of a production identity HMAC rotation (owner-authorized). Uses the backup dir of rotate-production.sh:
#   B=~/backups/r4-production/identity-rotation-<ts> bash rollback-production.sh
# Same tool with the keys swapped: every binding is verified under the NEW key and rewritten under the OLD one; the env
# files are restored from the backup; the database is verified under the key those restored files hold (so a key file
# that does not match the configuration can never be committed unnoticed); the processes restart with the old key.
# Last resort if this fails: pg_restore of $B/r4_production.dump (owner decision).
set -euo pipefail
umask 077
: "${B:?set B=<backup dir of the rotation>}"
R=~/R4-agent-platform; C=~/.config/r4; TOOL="$B/tool"
WORKERS="r4-scheduler r4-sales-worker r4-sales-worker-lane"; GATEWAY=r4-channel-gateway
step() { echo "== $(date -u +%T) $*"; }
db() { docker exec r4-production-postgres psql -U r4_production -d r4_production -At -c "$1"; }
envrun() { (cd "$R" && set -a && . "$C/production.env" && set +a && "$@"); }
for f in old.key new.key production.env production-lane.env lists.env SHA256SUMS; do [ -f "$B/$f" ] || { echo "missing $B/$f"; exit 1; }; done
(cd "$B" && sha256sum -c --quiet SHA256SUMS) || { echo "backup checksums do not match"; exit 1; }

step "1. stop (workers, gateway), kill switch"
for p in $WORKERS $GATEWAY; do pm2 stop "$p" >/dev/null; done
envrun npm run -s production:sales:control -- autonomy off --reason "identity rotation rollback (owner-authorized)" >/dev/null 2>&1
for _ in $(seq 1 15); do [ "$(db "select count(*) from pg_stat_activity where usename='r4_production' and client_addr is not null and application_name like 'r4-%'")" = 0 ] && break; sleep 2; done
[ "$(db "select count(*) from inbound_events where status='received'")" = 0 ] || { echo "unsettled inbound: start the gateway to drain it, then rerun"; exit 1; }

step "2. the rotated configuration as the tool's input (new key + recomputed lists)"
{ echo "R4_PROD_IDENTITY_HASH_KEY='$(cat "$B/new.key")'"; sed "s/^\([A-Z0-9_]*\)=\(.*\)$/\1='\2'/" "$B/lists.env"; grep -E '^R4_PROD_ROLLOUT_PERCENT=' "$B/production.env"; } > "$B/rotated.env"

step "3. apply with the keys swapped (verifies every row under the new key first)"
node "$TOOL/rotate.mjs" apply --env-file "$B/rotated.env" --new-key-file "$B/old.key" --out "$B/back.env"

step "4. restore the env files from the backup; verify the database under the key THEY hold"
cat "$B/production.env" > "$C/production.env"; cat "$B/production-lane.env" > "$C/production-lane.env"
node "$TOOL/rotate.mjs" verify --env-file "$C/production.env" --env-file "$C/production-lane.env" --key-from-env

step "5. restart with the old key (clean pm2 environment), autonomy on"
# Only the processes that compute conversation keys get the key (the scheduler never held it and does not get it).
for p in $WORKERS $GATEWAY; do
  if [ "$p" = r4-scheduler ]; then env -i HOME="$HOME" PATH="$PATH" pm2 restart "$p" --update-env >/dev/null
  else env -i HOME="$HOME" PATH="$PATH" R4_PROD_IDENTITY_HASH_KEY="$(cat "$B/old.key")" pm2 restart "$p" --update-env >/dev/null; fi
  sleep 3
done
sleep 12; pm2 save >/dev/null
curl -sf -m 5 127.0.0.1:8090/health >/dev/null || { echo "FAILED: gateway /health"; exit 1; }
envrun npm run -s production:sales:control -- autonomy on --reason "identity rotation rolled back (owner-authorized)" >/dev/null 2>&1
echo "kill-switch holds created by the rollback window: $(db "select count(*) from inbound_events where disposition = 'held:autonomy_disabled' and received_at >= now() - interval '30 minutes'")"
step "ROLLBACK DONE"
