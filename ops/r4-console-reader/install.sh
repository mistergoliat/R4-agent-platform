#!/usr/bin/env bash
# ADR-049 Decision 6: r4-api in production as the console's READ-ONLY backend (owner-authorized).
#   READER_SHA256=<sha256 hex of the console token> [API_PORT=8088] bash install.sh
# Idempotent. Creates (or keeps) a read-only Postgres role, an empty agent-definitions dir, the env file and
# the pm2 process `r4-api` bound to 127.0.0.1. Prints no secret. Production processes are not touched.
set -euo pipefail
umask 077
: "${READER_SHA256:?set READER_SHA256=<64 hex>}"
[[ "$READER_SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "READER_SHA256 must be 64 lowercase hex"; exit 1; }
PORT=${API_PORT:-8088}
R=~/R4-agent-platform; C=~/.config/r4; ENV="$C/r4-api.env"; RUN="$C/run-r4-api.sh"; EMPTY=~/.local/share/r4-api-agents
psql_prod() { docker exec -i r4-production-postgres psql -U r4_production -d r4_production -v ON_ERROR_STOP=1 -At "$@"; }

echo "== 1. port $PORT free on loopback"
if ss -ltn "sport = :$PORT" | grep -q LISTEN && ! pm2 describe r4-api >/dev/null 2>&1; then echo "port $PORT in use: choose API_PORT"; exit 1; fi

echo "== 2. read-only role r4_console_reader"
if [ ! -f "$ENV" ]; then
  PW=$(openssl rand -hex 24)
  psql_prod <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = 'r4_console_reader') then
    create role r4_console_reader login password '$PW';
  else
    alter role r4_console_reader login password '$PW';
  end if;
end \$\$;
grant connect on database r4_production to r4_console_reader;
grant usage on schema public to r4_console_reader;
grant select on all tables in schema public to r4_console_reader;
alter default privileges for role r4_production in schema public grant select on tables to r4_console_reader;
alter role r4_console_reader set default_transaction_read_only = on;
SQL
  # Same host/port/database as production, other credentials.
  URL=$(set -a; . "$C/production.env"; node -e 'const u=new URL(process.env.R4_DATABASE_URL);u.username="r4_console_reader";u.password=process.argv[1];console.log(u.toString())' "$PW")
  printf 'R4_DATABASE_URL=%s\nR4_HTTP_HOST=127.0.0.1\nR4_HTTP_PORT=%s\nR4_LOG_LEVEL=info\nR4_AGENT_DEFINITIONS_DIR=%s\nR4_DB_POOL_MAX=3\n' "$URL" "$PORT" "$EMPTY" > "$ENV"
fi
grep -v '^R4_SERVICE_READER_TOKEN_SHA256=' "$ENV" > "$ENV.tmp" && echo "R4_SERVICE_READER_TOKEN_SHA256=$READER_SHA256" >> "$ENV.tmp" && mv "$ENV.tmp" "$ENV"
chmod 600 "$ENV"

echo "== 3. empty agent-definitions dir (the API registers nothing at boot)"
mkdir -p "$EMPTY"; [ -z "$(ls -A "$EMPTY")" ] || { echo "$EMPTY is not empty"; exit 1; }

echo "== 4. pm2 process r4-api"
printf '#!/usr/bin/env bash\nset -a; . %s; set +a\nexec node %s/apps/api/dist/main.js\n' "$ENV" "$R" > "$RUN"; chmod 700 "$RUN"
if pm2 describe r4-api >/dev/null 2>&1; then pm2 restart r4-api >/dev/null; else pm2 start "$RUN" --name r4-api >/dev/null; fi
for _ in $(seq 1 20); do curl -sf -m 2 "127.0.0.1:$PORT/ready" >/dev/null && break; sleep 1; done
curl -sf -m 2 "127.0.0.1:$PORT/ready" >/dev/null || { echo "r4-api not ready: pm2 logs r4-api --lines 30"; exit 1; }
pm2 save >/dev/null

echo "== 5. verify: reads need the token, writes are impossible"
[ "$(curl -s -o /dev/null -w '%{http_code}' -m 3 "127.0.0.1:$PORT/v1/production/metrics")" = 422 ] || { echo "metrics answered without token"; exit 1; }
writable=$(psql_prod -c "select count(*) from information_schema.table_privileges where grantee = 'r4_console_reader' and privilege_type <> 'SELECT'")
ro=$(psql_prod -c "select coalesce((select setting from pg_db_role_setting s join pg_roles r on r.oid = s.setrole, unnest(s.setconfig) setting where r.rolname = 'r4_console_reader' and setting = 'default_transaction_read_only=on'), 'missing')")
[ "$writable" = 0 ] && [ "$ro" = 'default_transaction_read_only=on' ] || { echo "reader role can write: stop r4-api now (pm2 stop r4-api)"; exit 1; }
echo "r4-api ready on 127.0.0.1:$PORT (role r4_console_reader: SELECT only, read-only transactions)"
echo "from the owner's machine: ssh -L $PORT:127.0.0.1:$PORT <host>, and R4_API_URL=http://127.0.0.1:$PORT in the console"
