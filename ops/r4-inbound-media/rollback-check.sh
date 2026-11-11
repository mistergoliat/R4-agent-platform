#!/usr/bin/env bash
# Rehearsal of rollback level 2 on a RESTORED COPY (never on production): fresh dump -> throwaway Postgres -> apply
# 0016_inbound_media exactly as the new code does -> ask the code deployed today (PREV) whether that database is ready
# for it (no pending, no modified migration) -> destroy. Usage: bash rollback-check.sh <path to 0016_inbound_media.sql>
set -euo pipefail
umask 077
SQL=${1:?path to 0016_inbound_media.sql}
R=~/R4-agent-platform; T=$(mktemp -d -p "$HOME" .r4-rollback-check.XXXXXX); NAME=r4-rollback-check-$$; PORT=55496
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; find "$T" -type f -exec shred -u {} + 2>/dev/null || true; rm -rf "$T"; }
trap cleanup EXIT
check() { if [ "$2" = "$3" ]; then echo "ok   $1 ($2)"; else echo "FAIL $1: got $2, expected $3"; exit 1; fi; }
docker exec r4-production-postgres pg_dump -U r4_production -Fc -d r4_production > "$T/copy.dump"
PW=$(node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("hex"))')
printf 'POSTGRES_USER=r4_production\nPOSTGRES_DB=r4_production\nPOSTGRES_PASSWORD=%s\n' "$PW" > "$T/pg.env"
docker run -d --name "$NAME" --env-file "$T/pg.env" -p "127.0.0.1:$PORT:5432" --tmpfs /var/lib/postgresql/data postgres:16-alpine >/dev/null
for _ in $(seq 1 60); do docker exec "$NAME" pg_isready -U r4_production -d r4_production -q && break; sleep 1; done
docker exec -i "$NAME" pg_restore -U r4_production -d r4_production --no-owner --exit-on-error < "$T/copy.dump"
CHK=$(node -e 'const fs=require("fs");const s=fs.readFileSync(process.argv[1],"utf8").replace(/\r\n/g,"\n");process.stdout.write(require("crypto").createHash("sha256").update(s).digest("hex"))' "$SQL")
docker exec -i "$NAME" psql -U r4_production -d r4_production -v ON_ERROR_STOP=1 -q < "$SQL"
docker exec "$NAME" psql -U r4_production -d r4_production -v ON_ERROR_STOP=1 -q -c "insert into r4_schema_migrations (id, checksum) values ('0016_inbound_media', '$CHK')"
docker exec "$NAME" psql -U r4_production -d r4_production -v ON_ERROR_STOP=1 -q -c "insert into inbound_events (inbound_id, channel, provider_event_id, status, content_kind, content_type, correlation_id, settled_at, failure_code) values (gen_random_uuid(), 'whatsapp', 'rollback-check-media', 'rejected', 'media', 'image', 'rollback-check', clock_timestamp(), 'rehearsal')"
OUT=$(cd "$R" && R4_CHECK_URL="postgres://r4_production:$PW@127.0.0.1:$PORT/r4_production" node --input-type=module -e "
import { createPool, migrationStatus, coreSchemaHead } from './packages/persistence-postgres/dist/index.js';
const pool = createPool({ connectionString: process.env.R4_CHECK_URL, applicationName: 'r4-rollback-check', max: 1 });
const s = await migrationStatus(pool);
const head = await coreSchemaHead();
process.stdout.write(JSON.stringify({ pending: s.pending.length, modified: s.modified.length, appliedHasNew: s.applied.includes('0016_inbound_media'), codeHead: head }));
await pool.end();")
echo "PREV code ($(cd "$R" && git rev-parse --short HEAD)) against a database with 0016 applied: $OUT"
check "pending migrations for PREV" "$(echo "$OUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).pending))')" 0
check "modified migrations for PREV" "$(echo "$OUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).modified))')" 0
check "a settled media row is readable" "$(docker exec "$NAME" psql -U r4_production -d r4_production -At -c "select count(*) from inbound_events where content_kind = 'media'")" 1
echo "ROLLBACK CHECK PASSED: PREV treats the 0016 database as current (gateway and worker compute the same head, $(echo "$OUT" | grep -oE '"codeHead":"[^"]*"'))"
