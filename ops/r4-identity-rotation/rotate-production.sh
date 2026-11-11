#!/usr/bin/env bash
# PRODUCTION rotation of R4_PROD_IDENTITY_HASH_KEY. NOT to be run without the owner's explicit authorization, and only
# after restored-copy-test.sh passed on a fresh copy. Prints counts only (never a key, a wa_id or a derived key).
#   SHA=<deployed short sha> bash rotate-production.sh
# Aborts (and leaves production as it was, autonomy back as found) on: a plan blocker (unverifiable open binding, key
# collision, unsettled inbound, live identity verification, an allowlisted number with no verifiable identity), an
# unsettled action or outbound, or any failed verification. From step 6 on, a failure means: ROLLBACK below.
#
# ROLLBACK (B = the backup dir printed in step 4):
#   kill switch on; pm2 stop the 4 R4 processes;
#   node rotate.mjs apply --env-file B/rotated.env --new-key-file B/old.key --out B/back.env   (keys swapped)
#   cat B/production.env > ~/.config/r4/production.env; cat B/production-lane.env > ~/.config/r4/production-lane.env
#   restart with --update-env (step 8), pm2 save, autonomy on. Last resort: pg_restore of B/r4_production.dump.
set -euo pipefail
umask 077
: "${SHA:?set SHA=<deployed short sha>}"
HERE=$(cd "$(dirname "$0")" && pwd)
R=~/R4-agent-platform; C=~/.config/r4
B=~/backups/r4-production/identity-rotation-$(date -u +%Y%m%dT%H%M%SZ)
PROCS="r4-scheduler r4-sales-worker r4-sales-worker-lane r4-channel-gateway"
step() { echo "== $(date -u +%T) $*"; }
db() { docker exec r4-production-postgres psql -U r4_production -d r4_production -At -c "$1"; }
envrun() { (cd "$R" && set -a && . $C/production.env && set +a && "$@"); }
autonomy() { envrun npm run -s production:sales:control -- autonomy status | grep -oE '"autonomy": "[a-z]+"' | head -1 || true; }
ENVS=(--env-file "$C/production.env" --env-file "$C/production-lane.env")
TOOL="$B/tool"

step "0. preconditions"
[ "$(cd "$R" && git rev-parse --short HEAD)" = "$SHA" ] || { echo "deployed SHA is not $SHA"; exit 1; }
[ "$(db "select count(*) from action_executions where status not in ('succeeded','failed','rejected')")" = 0 ] || { echo "an action is not settled"; exit 1; }
[ "$(db "select count(*) from outbound_messages where status in ('pending','dispatching','unknown')")" = 0 ] || { echo "outbound not settled"; exit 1; }
BEFORE_AUTONOMY=$(autonomy)

step "1. new key (CSPRNG, 256 bits) and tools, in a 0700 backup dir"
mkdir -p "$TOOL"; cp "$HERE/rotation.mjs" "$HERE/rotate.mjs" "$TOOL/"; ln -s "$R/node_modules" "$TOOL/node_modules"
node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))' > "$B/new.key"
node -e 'const f=require("fs");const m=f.readFileSync(process.argv[1],"utf8").match(/^R4_PROD_IDENTITY_HASH_KEY=\x27?([^\x27\n]+)\x27?$/m);f.writeFileSync(process.argv[2],m[1])' "$C/production.env" "$B/old.key"

step "2. plan (read-only, production running)"
node "$TOOL/rotate.mjs" plan "${ENVS[@]}" --new-key-file "$B/new.key" || { echo "ABORT: plan blocked; nothing changed"; exit 1; }

step "3. kill switch, drain, stop the R4 processes (web QA untouched)"
envrun npm run -s production:sales:control -- autonomy off --reason "identity HMAC rotation (owner-authorized)" >/dev/null 2>&1
[ "$(autonomy)" = '"autonomy": "disabled"' ] || { echo "ABORT: kill switch not engaged"; exit 1; }
for i in $(seq 1 30); do [ "$(db "select count(*) from outbound_messages where status in ('pending','dispatching')")" = 0 ] && break; sleep 2; done
for p in $PROCS; do pm2 stop "$p" >/dev/null; done
for i in $(seq 1 15); do [ "$(db "select count(*) from pg_stat_activity where usename='r4_production' and client_addr is not null")" = 0 ] && break; sleep 1; done
[ "$(db "select count(*) from inbound_events where status='received'")" = 0 ] || { echo "ABORT: unsettled inbound; restart the processes to drain, then retry"; for p in $PROCS; do pm2 start "$p" >/dev/null; done; exit 1; }

step "4. backup (database dump, configuration, pm2 dump)"
docker exec r4-production-postgres pg_dump -U r4_production -Fc -d r4_production > "$B/r4_production.dump"
cp -p $C/production.env $C/production-lane.env ~/.pm2/dump.pm2 "$B/"
(cd "$B" && sha256sum r4_production.dump production.env production-lane.env dump.pm2 > SHA256SUMS); echo "$B"

step "5. apply (one transaction; refuses on any blocker)"
node "$TOOL/rotate.mjs" apply "${ENVS[@]}" --new-key-file "$B/new.key" --out "$B/lists.env"
{ echo "R4_PROD_IDENTITY_HASH_KEY='$(cat "$B/new.key")'"; sed "s/^\([A-Z_]*\)=\(.*\)$/\1='\2'/" "$B/lists.env"; } > "$B/rotated.env"

step "6. configuration: the new key and the recomputed lists, in place"
node -e '
const fs = require("fs");
const [rotated, ...files] = process.argv.slice(1);
const next = Object.fromEntries(fs.readFileSync(rotated, "utf8").trim().split("\n").map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }));
for (const f of files) {
  const lines = fs.readFileSync(f, "utf8").split("\n");
  let n = 0;
  const out = lines.map((l) => { const k = /^([A-Z0-9_]+)=/.exec(l)?.[1]; if (k && k in next) { n++; return `${k}=${next[k]}`; } return l; });
  fs.writeFileSync(f, out.join("\n"));
  console.log(`${f.split("/").pop()}: ${n} line(s) updated`);
}' "$B/rotated.env" $C/production.env $C/production-lane.env
grep -c "^R4_PROD_IDENTITY_HASH_KEY=" $C/production.env

step "7. verify under the new key"
node "$TOOL/rotate.mjs" verify --env-file "$C/production.env" --new-key-file "$B/new.key" || { echo "FAILED: follow ROLLBACK"; exit 1; }

step "8. start with the new environment, save the pm2 dump"
# The wrappers source the files at each start; --update-env with ONLY the new key also purges the old value that pm2
# kept in its stored environment (and, after `pm2 save`, in its dump). Nothing else is added to any process.
NEWKEY=$(cat "$B/new.key")
for p in $PROCS; do R4_PROD_IDENTITY_HASH_KEY="$NEWKEY" pm2 restart "$p" --update-env >/dev/null; sleep 3; done
unset NEWKEY
sleep 12; pm2 save >/dev/null
pm2 jlist | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).filter(p=>p.name.startsWith("r4-"));for(const p of r)console.log(p.name,p.pm2_env.status);if(r.some(p=>p.pm2_env.status!=="online"))process.exit(1)})'
curl -sf -m 5 127.0.0.1:8090/health >/dev/null && echo "gateway /health 200"

step "9. autonomy back to its previous state"
[ "$BEFORE_AUTONOMY" = '"autonomy": "enabled"' ] && envrun npm run -s production:sales:control -- autonomy on --reason "identity HMAC rotated and verified (owner-authorized)" >/dev/null 2>&1
autonomy
echo "the old key stays only in $B (0600) for the rollback window; shred it when the owner closes the rotation"
step "ROTATION DONE: the allowlisted owner sends one message; it must land on the existing conversation (same binding)"
