#!/usr/bin/env bash
# Identity HMAC rotation rehearsal on a RESTORED COPY of production (never on production itself).
#   bash restored-copy-test.sh            (on the EC2 host, as the operator; reads ~/.config/r4/production*.env)
# Fresh pg_dump -> throwaway postgres:16-alpine on tmpfs (127.0.0.1 only) -> plan -> apply -> verify -> integrity
# checks -> rollback (keys swapped) -> the bindings table is byte-identical to the original -> everything destroyed.
# Prints counts and checksums only: never a key, a wa_id, a derived key or a connection string.
set -euo pipefail
umask 077
HERE=$(cd "$(dirname "$0")" && pwd)
R=~/R4-agent-platform; C=~/.config/r4
T=$(mktemp -d); NAME=r4-rotation-copy-$$; PORT=${PORT:-55499}
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; find "$T" -type f -exec shred -u {} + 2>/dev/null || true; rm -rf "$T"; }
trap cleanup EXIT
step() { echo "== $(date -u +%T) $*"; }

step "1. fresh dump of production (read-only) and throwaway restore"
docker exec r4-production-postgres pg_dump -U r4_production -Fc -d r4_production > "$T/copy.dump"
PW=$(node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("hex"))')
docker run -d --name "$NAME" -e POSTGRES_USER=r4_production -e POSTGRES_DB=r4_production -e POSTGRES_PASSWORD="$PW" -p "127.0.0.1:$PORT:5432" --tmpfs /var/lib/postgresql/data postgres:16-alpine >/dev/null
for i in $(seq 1 60); do docker exec "$NAME" pg_isready -U r4_production -d r4_production -q && break; sleep 1; done
docker exec -i "$NAME" pg_restore -U r4_production -d r4_production --no-owner --exit-on-error < "$T/copy.dump"
copy() { docker exec "$NAME" psql -U r4_production -d r4_production -At -c "$1"; }
echo "restored: $(copy "select count(*) from channel_conversation_bindings") bindings, $(copy "select count(*) from agent_tasks") tasks, $(copy "select count(*) from inbound_events") inbound events"

# Checksum of every table's content (by table), to prove that only the binding keys change.
tables() { copy "select string_agg(format('%I', tablename), ' ' order by tablename) from pg_tables where schemaname = 'public'"; }
checksums() { for t in $(tables); do echo "$t $(copy "select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from $t x")"; done; }
checksums > "$T/before.sums"

TOOL="$T/tool"; mkdir -p "$TOOL"; cp "$HERE/rotation.mjs" "$HERE/rotate.mjs" "$TOOL/"; ln -s "$R/node_modules" "$TOOL/node_modules"
node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))' > "$T/new.key"
node -e 'const f=require("fs");const m=f.readFileSync(process.argv[1],"utf8").match(/^R4_PROD_IDENTITY_HASH_KEY=\x27?([^\x27\n]+)\x27?$/m);f.writeFileSync(process.argv[2],m[1])' "$C/production.env" "$T/old.key"
export R4_ROTATION_DATABASE_URL="postgres://r4_production:$PW@127.0.0.1:$PORT/r4_production"
ENVS=(--env-file "$C/production.env" --env-file "$C/production-lane.env")

step "2. plan (read-only)"
node "$TOOL/rotate.mjs" plan "${ENVS[@]}" --new-key-file "$T/new.key" || { echo "PLAN BLOCKED (see blockers): rehearsal stops here"; exit 1; }

step "3. apply on the copy"
node "$TOOL/rotate.mjs" apply "${ENVS[@]}" --new-key-file "$T/new.key" --out "$T/lists.env"
echo "recomputed lists: $(cut -d= -f1 "$T/lists.env" | paste -sd ' ') ($(tr ',' '\n' < "$T/lists.env" | grep -c .) keys)"

step "4. verify under the new key and check integrity"
node "$TOOL/rotate.mjs" verify --env-file "$C/production.env" --new-key-file "$T/new.key"
checksums > "$T/after.sums"
echo "tables changed: $(diff <(grep -v '^channel_conversation_bindings ' "$T/before.sums") <(grep -v '^channel_conversation_bindings ' "$T/after.sums") | grep -c '^>' || true) (expected 0)"
echo "bindings changed: $(diff <(grep '^channel_conversation_bindings ' "$T/before.sums") <(grep '^channel_conversation_bindings ' "$T/after.sums") >/dev/null && echo no || echo yes) (expected yes)"
echo "orphan checks: inputs whose task lost its binding $(copy "select count(*) from agent_tasks t where exists (select 1 from channel_conversation_bindings b0 where b0.task_id = t.task_id) and not exists (select 1 from channel_conversation_bindings b where b.task_id = t.task_id)"), open duplicates $(copy "select count(*) from (select channel, conversation_key from channel_conversation_bindings where status='open' group by 1,2 having count(*)>1) d"), trigger $(copy "select tgenabled from pg_trigger where tgname='channel_conversation_bindings_identity_immutable'")"
echo "immutability back in force: $(docker exec "$NAME" psql -U r4_production -d r4_production -At -c "update channel_conversation_bindings set conversation_key = repeat('a',64) where binding_id = (select binding_id from channel_conversation_bindings limit 1)" 2>&1 | grep -c 'identity is immutable' || true) (expected 1)"

step "5. rollback rehearsal (keys swapped) -> bindings byte-identical to the original"
{ echo "R4_PROD_IDENTITY_HASH_KEY='$(cat "$T/new.key")'"; sed "s/^\([A-Z_]*\)=\(.*\)$/\1='\2'/" "$T/lists.env"; } > "$T/rotated.env"
node "$TOOL/rotate.mjs" apply --env-file "$T/rotated.env" --new-key-file "$T/old.key" --out "$T/back.env" >/dev/null
checksums > "$T/back.sums"
echo "after rollback, identical to the original: $(diff -q "$T/before.sums" "$T/back.sums" >/dev/null && echo yes || echo NO)"
step "REHEARSAL DONE (copy destroyed on exit)"
