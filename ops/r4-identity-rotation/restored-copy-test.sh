#!/usr/bin/env bash
# Identity HMAC rotation rehearsal on a RESTORED COPY of production (never on production itself).
#   bash restored-copy-test.sh            (on the EC2 host, as the operator; reads ~/.config/r4/production*.env)
# Fresh pg_dump -> throwaway postgres:16-alpine on tmpfs (127.0.0.1 only) -> plan -> apply -> install into COPIES of the
# env files -> verify under the key those copies hold -> integrity -> rollback (keys swapped) -> every table identical
# to the original -> everything destroyed. Every check is asserted (exit 1 on the first failure). Prints counts and
# checksums only: never a key, a wa_id, a derived key or a connection string.
set -euo pipefail
umask 077
HERE=$(cd "$(dirname "$0")" && pwd)
R=~/R4-agent-platform; C=~/.config/r4
T=$(mktemp -d -p "$HOME" .r4-rotation-rehearsal.XXXXXX); NAME=r4-rotation-copy-$$; PORT=${PORT:-55499}
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; find "$T" -type f -exec shred -u {} + 2>/dev/null || true; rm -rf "$T"; }
trap cleanup EXIT
step() { echo "== $(date -u +%T) $*"; }
check() { if [ "$2" = "$3" ]; then echo "ok   $1 ($2)"; else echo "FAIL $1: got $2, expected $3"; exit 1; fi; }

step "1. fresh dump of production (read-only) and throwaway restore"
docker exec r4-production-postgres pg_dump -U r4_production -Fc -d r4_production > "$T/copy.dump"
PW=$(node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("hex"))')
printf 'POSTGRES_USER=r4_production\nPOSTGRES_DB=r4_production\nPOSTGRES_PASSWORD=%s\n' "$PW" > "$T/pg.env"
docker run -d --name "$NAME" --env-file "$T/pg.env" -p "127.0.0.1:$PORT:5432" --tmpfs /var/lib/postgresql/data postgres:16-alpine >/dev/null
for _ in $(seq 1 60); do docker exec "$NAME" pg_isready -U r4_production -d r4_production -q && break; sleep 1; done
docker exec -i "$NAME" pg_restore -U r4_production -d r4_production --no-owner --exit-on-error < "$T/copy.dump"
copy() { docker exec "$NAME" psql -U r4_production -d r4_production -At -c "$1"; }
echo "restored: $(copy "select count(*) from channel_conversation_bindings") bindings, $(copy "select count(*) from agent_tasks") tasks, $(copy "select count(*) from inbound_events") inbound events"

# Checksum of every table of every non-system schema, to prove that only the binding keys change.
tables() { copy "select string_agg(format('%I.%I', schemaname, tablename), ' ' order by schemaname, tablename) from pg_tables where schemaname not in ('pg_catalog', 'information_schema')"; }
checksums() { for t in $(tables); do echo "$t $(copy "select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from $t x")"; done; }
checksums > "$T/before.sums"
echo "tables checksummed: $(wc -l < "$T/before.sums")"

TOOL="$T/tool"; mkdir -p "$TOOL"; cp "$HERE/rotation.mjs" "$HERE/rotate.mjs" "$TOOL/"; ln -s "$R/node_modules" "$TOOL/node_modules"
cp "$C/production.env" "$T/production.env"; cp "$C/production-lane.env" "$T/production-lane.env"
ENVS=(--env-file "$T/production.env" --env-file "$T/production-lane.env")
node "$TOOL/rotate.mjs" export-key "${ENVS[@]}" --out "$T/old.key" >/dev/null
node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))' > "$T/new.key"
export R4_ROTATION_DATABASE_URL="postgres://r4_production:$PW@127.0.0.1:$PORT/r4_production"

step "2. plan (read-only)"
node "$TOOL/rotate.mjs" plan "${ENVS[@]}" --new-key-file "$T/new.key" || { echo "FAIL plan blocked"; exit 1; }

step "3. apply on the copy"
node "$TOOL/rotate.mjs" apply "${ENVS[@]}" --new-key-file "$T/new.key" --out "$T/lists.env"

step "4. install into COPIES of the env files, then verify under the key they hold"
cp "$T/production.env" "$T/production.env.orig"
node "$TOOL/rotate.mjs" install "${ENVS[@]}" --new-key-file "$T/new.key" --lists "$T/lists.env" --old-env-file "$T/production.env.orig"
node "$TOOL/rotate.mjs" verify "${ENVS[@]}" --key-from-env
check "old key left in the env copies" "$(cat "$T/production.env" "$T/production-lane.env" | grep -cF -f "$T/old.key" || true)" 0
check "lines of the env copies other than the managed ones unchanged" "$(diff <(grep -vE '^R4_PROD_(IDENTITY_HASH_KEY|ROLLOUT_ALLOWLIST|ROLLOUT_DENYLIST|LANE_ALLOWLIST)=' "$T/production.env.orig") <(grep -vE '^R4_PROD_(IDENTITY_HASH_KEY|ROLLOUT_ALLOWLIST|ROLLOUT_DENYLIST|LANE_ALLOWLIST)=' "$T/production.env") | grep -c . || true)" 0

step "5. integrity"
checksums > "$T/after.sums"
check "tables changed other than the bindings" "$(diff <(grep -v '^public.channel_conversation_bindings ' "$T/before.sums") <(grep -v '^public.channel_conversation_bindings ' "$T/after.sums") | grep -c '^>' || true)" 0
check "bindings table changed" "$(diff -q <(grep '^public.channel_conversation_bindings ' "$T/before.sums") <(grep '^public.channel_conversation_bindings ' "$T/after.sums") >/dev/null && echo no || echo yes)" yes
check "open duplicates" "$(copy "select count(*) from (select channel, conversation_key from channel_conversation_bindings where status='open' group by 1,2 having count(*)>1) d")" 0
check "binding identity trigger enabled" "$(copy "select tgenabled from pg_trigger where tgname='channel_conversation_bindings_identity_immutable'")" O
check "an ordinary key update is refused again" "$(docker exec "$NAME" psql -U r4_production -d r4_production -At -c "update channel_conversation_bindings set conversation_key = repeat('a',64) where binding_id = (select binding_id from channel_conversation_bindings limit 1)" 2>&1 | grep -c 'identity is immutable' || true)" 1

step "6. rollback rehearsal (keys swapped) -> every table identical to the original"
{ echo "R4_PROD_IDENTITY_HASH_KEY='$(cat "$T/new.key")'"; sed "s/^\([A-Z0-9_]*\)=\(.*\)$/\1='\2'/" "$T/lists.env"; grep -E '^R4_PROD_ROLLOUT_PERCENT=' "$T/production.env.orig"; } > "$T/rotated.env"
node "$TOOL/rotate.mjs" apply --env-file "$T/rotated.env" --new-key-file "$T/old.key" --out "$T/back.env" >/dev/null
checksums > "$T/back.sums"
check "every table identical to the original after rollback" "$(diff -q "$T/before.sums" "$T/back.sums" >/dev/null && echo yes || echo no)" yes
check "rollback lists identical to the original lists" "$(node --input-type=module -e "
import { keyListsOf, parseEnvFile } from '$TOOL/rotation.mjs';
import { readFileSync } from 'node:fs';
const a = keyListsOf(Object.assign({}, parseEnvFile(readFileSync('$T/production.env.orig','utf8')), parseEnvFile(readFileSync('$C/production-lane.env','utf8'))));
const b = keyListsOf(parseEnvFile(readFileSync('$T/back.env','utf8')));
process.stdout.write(Object.keys(a).every((k) => a[k].length === 0 || JSON.stringify(a[k]) === JSON.stringify(b[k])) ? 'yes' : 'no');")" yes
step "REHEARSAL PASSED (copy destroyed on exit)"
