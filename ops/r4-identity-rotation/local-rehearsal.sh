#!/usr/bin/env bash
# LOCAL rehearsal of the production rotation (a developer machine, never a host): runs rotate-production.sh and
# rollback-production.sh THEMSELVES against a throwaway database with a stand-in pm2 and gateway, and prints the timings.
#   npm run build && bash ops/r4-identity-rotation/local-rehearsal.sh
# Seed: the continuity integration test (sales-production@22 canary: an issued quote, an idle-closed case, a newer case,
# two allowlisted testers, one on the lane) leaves a copy of its database at the snapshot point; that copy is the
# "production" here. Every check is asserted; the copy, the stand-ins and the files are destroyed on exit.
set -euo pipefail
umask 077
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(cd "$HERE/../.." && { pwd -W 2>/dev/null || pwd; })   # pwd -W: Git Bash, for node
PGC=${R4_LOCAL_PG:-r4-agent-platform-postgres}; NAME=r4_rotation_rehearsal_$$
T=$(mktemp -d); HPID=''
cleanup() {
  [ -n "$HPID" ] && kill "$HPID" 2>/dev/null || true
  docker exec "$PGC" psql -U r4 -d postgres -qc "drop database if exists $NAME with (force)" >/dev/null 2>&1 || true
  rm -rf "$T"
}
trap cleanup EXIT
check() { if [ "$2" = "$3" ]; then echo "ok   $1 ($2)"; else echo "FAIL $1: got '$2', expected '$3'"; exit 1; fi; }
has() { if grep -q -- "$2" "$3"; then echo "ok   $1"; else echo "FAIL $1: '$2' not in the output:"; tail -15 "$3"; exit 1; fi; }
q() { docker exec "$PGC" psql -U r4 -d "$NAME" -At -c "$1"; }
s=$SECONDS

echo "== seed (integration test, sales-production@22 canary)"
(cd "$REPO" && R4_ROTATION_REHEARSAL_DB=$NAME R4_ROTATION_REHEARSAL_DIR=$T npx vitest run --project integration tests/integration/identity-hmac-rotation-continuity.test.ts > "$T/seed.log" 2>&1) || { tail -20 "$T/seed.log"; exit 1; }
set -a; . "$T/seed.env"; set +a
OLD=$R4_PROD_IDENTITY_HASH_KEY
echo "seeded in $((SECONDS - s)) s: $(q "select count(*) from channel_conversation_bindings") bindings ($(q "select count(*) from channel_conversation_bindings where status='open'") open, $(q "select count(*) from channel_conversation_bindings where closed_reason='idle_timeout'") idle_timeout), $(q "select count(*) from agent_tasks") tasks, $(q "select count(*) from sales.quote_v2_issued") quote(s)"

echo "== a host layout with the production file names"
H=$T/host; C=$H/.config/r4; W=$H/.config/r4-web-qa; mkdir -p "$C/secrets" "$W" "$H/backups" "$H/.pm2" "$H/r4-inbound-media" "$T/bin" "$T/pm2"
cat > "$C/production.env" <<EOF
R4_EXECUTION_MODE=production
R4_PROD_POLICY_PROFILE=sales-production@3
R4_PROD_LANE_PROFILE=sales-production@22
R4_PROD_ROLLOUT_PERCENT=0
R4_PROD_IDENTITY_HASH_KEY='$OLD'
R4_PROD_ROLLOUT_ALLOWLIST='$R4_PROD_ROLLOUT_ALLOWLIST'
R4_PROD_LANE_ALLOWLIST='$R4_PROD_LANE_ALLOWLIST'
R4_PROD_ALLOW_NETWORK=false
R4_PROD_CASE_IDLE_CLOSE_HOURS=24
R4_DATABASE_URL=$R4_DATABASE_URL
R4_LOG_LEVEL=warn
EOF
printf 'R4_PROD_POLICY_PROFILE=sales-production@22\nR4_WORKER_ID=lane-1\n' > "$C/production-lane.env"
printf 'R4_CATALOG_V2_API_KEY=x\n' > "$C/secrets/catalog-v2.env"
printf '#!/usr/bin/env bash\nset -a; . ~/.config/r4/production.env; . ~/.config/r4/secrets/catalog-v2.env; set +a\nexec npm run production:sales:gateway\n' > "$C/run-gateway.sh"
printf 'R4_PROD_IDENTITY_HASH_KEY=%s\nR4_PROD_ROLLOUT_PERCENT=100\n' "$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))')" > "$W/web.env"
printf '#!/usr/bin/env bash\n# lane switch: sed on R4_PROD_LANE_PROFILE / R4_PROD_POLICY_PROFILE only\n' > "$H/r4-lane-switch-v2.sh"
cp "$C/production.env" "$C/production.env.bak-20261110"   # a historical copy, as on the host
# Stand-in pm2 (state in files; `env -i` wipes the environment, so its paths are literal) and gateway /health.
cat > "$T/bin/pm2" <<EOF
#!/usr/bin/env bash
S='$T/pm2'; D='$H/.pm2/dump.pm2'
case "\$1" in
  start|restart|stop) [ "\${FAKE_PM2_FAIL:-}" = "\$1 \$2" ] && { echo "pm2: \$1 \$2 failed" >&2; exit 1; }
    [ "\$1" = stop ] && echo stopped > "\$S/\$2.status" || echo online > "\$S/\$2.status"
    [ "\$1" = restart ] && printf '%s' "\${R4_PROD_IDENTITY_HASH_KEY:-}" > "\$S/\$2.key"; exit 0 ;;
  save) for f in "\$S"/*.status; do n=\$(basename "\$f" .status); echo "\$n \$(cat "\$f") R4_PROD_IDENTITY_HASH_KEY=\$(cat "\$S/\$n.key" 2>/dev/null)"; done > "\$D" ;;
  jlist) node -e 'const fs=require("fs");const S=process.argv[1];console.log(JSON.stringify(fs.readdirSync(S).filter(f=>f.endsWith(".status")).map(f=>({name:f.slice(0,-7),pm2_env:{status:fs.readFileSync(S+"/"+f,"utf8").trim()}}))))' "\$S" ;;
esac
EOF
chmod +x "$T/bin/pm2"
for p in r4-scheduler r4-sales-worker r4-sales-worker-lane r4-channel-gateway; do echo online > "$T/pm2/$p.status"; [ "$p" = r4-scheduler ] || printf '%s' "$OLD" > "$T/pm2/$p.key"; done
PATH="$T/bin:$PATH" pm2 save
PORT=$((20000 + $$ % 20000)); node -e "require('http').createServer((q,s)=>s.end('ok')).listen($PORT,'127.0.0.1')" & HPID=$!
export PATH="$T/bin:$PATH" PM2_HOME="$H/.pm2" R4_REPO="$REPO" R4_CONFIG="$C" R4_BACKUPS="$H/backups" R4_PG_CONTAINER="$PGC" R4_PG_USER=r4 R4_PG_DB="$NAME"
export R4_GATEWAY_HEALTH="127.0.0.1:$PORT/health" R4_WEB_QA_CONFIG="$W" R4_ACTIVE_EXTRA="$H/r4-lane-switch-v2.sh $H/r4-inbound-media" R4_HISTORY_DIRS="$C $H/backups $W"
export SHA; SHA=$(cd "$REPO" && git rev-parse --short HEAD); export LANE=sales-production@22
ctl() { (cd "$REPO" && set -a && . "$C/production.env" && set +a && npm run -s production:sales:control -- autonomy "$@"); }
ctl on --reason "local rehearsal: production running" >/dev/null
sleep 1
sums() { q "select md5(string_agg(binding_id::text || conversation_key, ',' order by binding_id)) from channel_conversation_bindings"; }
ORIGINAL=$(sums)
ROT="$HERE/rotate-production.sh"

echo "== abort points (nothing may change)"
cp "$C/production.env" "$C/secrets/leftover.env"
PREFLIGHT_ONLY=1 bash "$ROT" > "$T/a1.log" 2>&1 && { echo "FAIL a copy of the key in secrets/ was not refused"; exit 1; } || true
has "a managed variable in another sourced file is refused" "also defined in: .*secrets/leftover.env" "$T/a1.log"; rm "$C/secrets/leftover.env"
grep -E '^R4_PROD_(IDENTITY_HASH_KEY|LANE_ALLOWLIST)=' "$C/production.env" | sed 's/^R4_PROD_/OLD_/' > "$H/r4-inbound-media/stash.env"
PREFLIGHT_ONLY=1 bash "$ROT" > "$T/a2.log" 2>&1 && { echo "FAIL an active copy of the old values was not refused"; exit 1; } || true
has "an active script holding the old values is refused" "active files hold the old key or an old list entry: .*stash.env" "$T/a2.log"; rm "$H/r4-inbound-media/stash.env"
cp "$W/web.env" "$T/web.env.own"; sed -i "s/^R4_PROD_IDENTITY_HASH_KEY=.*/R4_PROD_IDENTITY_HASH_KEY=$OLD/" "$W/web.env"
PREFLIGHT_ONLY=1 bash "$ROT" > "$T/a3.log" 2>&1 && { echo "FAIL a web QA sharing the key was not refused"; exit 1; } || true
has "web QA sharing the production key is refused" "web QA deployment holds the production key" "$T/a3.log"; cp "$T/web.env.own" "$W/web.env"
PREFLIGHT_ONLY=1 bash "$ROT" > "$T/a4.log" 2>&1 || { tail -15 "$T/a4.log"; exit 1; }
has "preflight passes on the clean layout" "PREFLIGHT ONLY: ready" "$T/a4.log"
has "the historical copy is listed by name" "production.env.bak-20261110" "$T/a4.log"
check "no key file left behind by the aborted and preflight runs" "$(ls "$H/backups" | wc -l | tr -d " ")" 0
FAKE_PM2_FAIL="stop r4-channel-gateway" bash "$ROT" > "$T/a5.log" 2>&1 && { echo "FAIL the injected stop failure did not abort"; exit 1; } || true
has "a failure after the stop restores production" "aborted before the commit: restoring production" "$T/a5.log"
check "bindings unchanged after the abort" "$(sums)" "$ORIGINAL"
check "processes online after the abort" "$(cat "$T"/pm2/*.status | sort -u)" online
check "autonomy restored after the abort" "$(ctl status | grep -oE '"autonomy": "[a-z]+"' | head -1)" '"autonomy": "enabled"'
check "no key file left behind by the four aborts" "$(ls "$H/backups" | wc -l | tr -d " ")" 0

echo "== rotation (rotate-production.sh)"
s=$SECONDS
bash "$ROT" > "$T/rotate.log" 2>&1 || { cat "$T/rotate.log"; exit 1; }
ROTATE_S=$((SECONDS - s))
grep -E '^== |^window|holds since|"(ok|rewritten|rewrittenVerified|subjects)"|^#' "$T/rotate.log" || true
has "rotation done" "ROTATION DONE" "$T/rotate.log"
B=$(ls -d "$H/backups"/identity-rotation-* | head -1)
NEW=$(cat "$B/new.key")
check "new key file mode" "$(stat -c %a "$B/new.key")" 600
check "old key left in the active env files" "$(cat "$C/production.env" "$C/production-lane.env" | grep -cF -f "$B/old.values" || true)" 0
check "workers and gateway carry the new key" "$(for p in r4-sales-worker r4-sales-worker-lane r4-channel-gateway; do [ "$(cat "$T/pm2/$p.key")" = "$NEW" ] && echo y; done | wc -l | tr -d ' ')" 3
check "the scheduler carries no key" "$(cat "$T/pm2/r4-scheduler.key")" ""
check "old key in the pm2 dump" "$(grep -cF -f "$B/old.key" "$H/.pm2/dump.pm2" || true)" 0
check "no key, list entry or synthetic contact printed" "$(grep -cF -e "$OLD" -e "$NEW" -e synthetic: -f "$B/old.values" "$T/rotate.log" || true)" 0
check "bindings changed" "$([ "$(sums)" != "$ORIGINAL" ] && echo yes)" yes

echo "== rollback (rollback-production.sh)"
s=$SECONDS
B=$B bash "$HERE/rollback-production.sh" > "$T/rollback.log" 2>&1 || { cat "$T/rollback.log"; exit 1; }
ROLLBACK_S=$((SECONDS - s))
grep -E '^== |^window|"ok"' "$T/rollback.log" || true
has "rollback done" "ROLLBACK DONE" "$T/rollback.log"
check "every binding back to its original key" "$(sums)" "$ORIGINAL"
check "env files hold the old key again" "$(grep -c "^R4_PROD_IDENTITY_HASH_KEY='$OLD'$" "$C/production.env")" 1
check "workers and gateway carry the old key" "$(for p in r4-sales-worker r4-sales-worker-lane r4-channel-gateway; do [ "$(cat "$T/pm2/$p.key")" = "$OLD" ] && echo y; done | wc -l | tr -d ' ')" 3
echo "== timings: rotate-production.sh ${ROTATE_S} s, rollback-production.sh ${ROLLBACK_S} s; $(grep '^window' "$T/rotate.log")"
echo "REHEARSAL PASSED (copy, stand-ins and files destroyed on exit)"
