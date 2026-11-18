#!/usr/bin/env bash
# Isolated image L3 evaluator (PR #70 code) on the production host, beside — never inside — production.
#   EVAL_SHA=<sha> bash image-l3-eval.sh up [dispatch]   build + own DB + migrate + bootstrap + start (dispatch: replies are SENT)
#   bash image-l3-eval.sh status
#   bash image-l3-eval.sh down                           stop, destroy the DB, shred the eval config and logs, remove the copy
# The evaluator is its own checkout copy (~/r4-eval-pr70), its own Postgres (tmpfs, 127.0.0.1:55497), its own gateway
# (127.0.0.1:8093, never nginx-facing unless the owner-authorized tee routes to it) and its own lane worker
# (sales-production@19). Commercial writes are impossible: the evaluator has NO Quote credential and its Quote base URL is
# a closed loopback port (tripwire), so any issuance fails before leaving the host (@19 itself refuses a write budget of 0,
# by design). Image perception: DeepSeek deepseek-flash. Production's checkout, database, processes and configuration are
# only READ.
set -euo pipefail
umask 077
P=~/R4-agent-platform; PC=~/.config/r4
E=~/r4-eval-pr70; EC=~/.config/r4-eval; DB=r4-image-l3-eval-db; PORT_DB=55497; PORT_GW=8093
step() { echo "== $(date -u +%T) $*"; }
evrun() { local f=$1; shift; (cd "$E" && set -a && . "$EC/$f" && set +a && "$@"); }
# The evaluator's processes are exactly those whose working directory is the evaluator copy (never production's).
evalpids() { for d in /proc/[0-9]*; do [ "$(readlink "$d/cwd" 2>/dev/null)" = "$(readlink -f "$E")" ] && echo "${d#/proc/}"; done; }

case "${1:-}" in
up)
  : "${EVAL_SHA:?set EVAL_SHA=<PR #70 sha>}"
  DISPATCH=false; [ "${2:-}" = dispatch ] && DISPATCH=true
  step "1. evaluator code: copy of the production checkout at $EVAL_SHA, built (production's checkout untouched)"
  [ -d "$E" ] || cp -a "$P" "$E"
  if [ "$(cd "$E" && git rev-parse --short HEAD)" != "$EVAL_SHA" ]; then
    (cd "$E" && { git fetch -q origin "$EVAL_SHA" 2>/dev/null || git fetch -q origin; } && git checkout -q --detach "$EVAL_SHA" && npm run -s build >/dev/null < /dev/null) || { echo "build failed"; exit 1; }
  fi
  echo "evaluator at $(cd "$E" && git rev-parse --short HEAD); production checkout still at $(cd "$P" && git rev-parse --short HEAD)"

  step "2. own database (tmpfs, 127.0.0.1:$PORT_DB)"
  mkdir -p "$EC" "$E/eval-logs"
  if ! docker ps --format '{{.Names}}' | grep -qx "$DB"; then
    node -e 'process.stdout.write("POSTGRES_USER=r4_eval\nPOSTGRES_DB=r4_eval\nPOSTGRES_PASSWORD="+require("crypto").randomBytes(24).toString("hex")+"\n")' > "$EC/pg.env"
    docker run -d --name "$DB" --env-file "$EC/pg.env" -p "127.0.0.1:$PORT_DB:5432" --tmpfs /var/lib/postgresql/data postgres:16-alpine >/dev/null
    for _ in $(seq 1 60); do docker exec "$DB" pg_isready -U r4_eval -d r4_eval -q && break; sleep 1; done
  fi

  step "3. eval configuration derived from production's (values never printed)"
  node - "$PC" "$EC" "$PORT_DB" "$PORT_GW" "$DISPATCH" <<'NODE'
const fs = require('fs');
const [pc, ec, portDb, portGw, dispatch] = process.argv.slice(2);
const parse = (f) => Object.fromEntries(fs.readFileSync(f, 'utf8').split('\n').map((l) => /^([A-Z0-9_]+)=['"]?(.*?)['"]?$/.exec(l.trim())).filter(Boolean).map((m) => [m[1], m[2]]));
const pg = parse(`${ec}/pg.env`);
const url = `postgres://${pg.POSTGRES_USER}:${pg.POSTGRES_PASSWORD}@127.0.0.1:${portDb}/${pg.POSTGRES_DB}`;
const prod = parse(`${pc}/production.env`);
delete prod.R4_PROD_SMOKE_RECIPIENT; // not needed here: no raw number in the eval configuration
const common = { ...prod, R4_DATABASE_URL: url };
const write = (name, vars) => fs.writeFileSync(`${ec}/${name}`, Object.entries(vars).map(([k, v]) => `${k}='${String(v).replace(/'/g, '')}'`).join('\n') + '\n', { mode: 0o600 });
write('gateway.env', { ...common, R4_GATEWAY_PORT: portGw, R4_GATEWAY_ID: 'r4-image-l3-eval', R4_GATEWAY_DISPATCH: dispatch, R4_GATEWAY_WORKING_SIGNAL: 'off',
  R4_MEDIA_PERCEPTION: 'enabled', R4_MEDIA_PERCEPTION_PROFILES: 'sales-production@19', R4_PERCEPTION_VISION_API_KEY: prod.R4_MODEL_API_KEY, R4_PERCEPTION_VISION_MODEL: 'deepseek-flash' });
// Quote: no real credential and a closed loopback port (tripwire): no commercial write can leave the evaluator.
write('lane.env', { ...common, ...parse(`${pc}/secrets/catalog-v2.env`), ...parse(`${pc}/quote-v2-retail.env`), ...parse(`${pc}/production-lane.env`), R4_DATABASE_URL: url,
  R4_QUOTE_BASE_URL: 'http://127.0.0.1:14999', R4_QUOTE_BEARER_TOKEN: 'eval-tripwire-' + require('crypto').randomBytes(24).toString('hex') });
console.log('gateway.env and lane.env written (0600); Quote = closed-port tripwire without credential; perception profiles sales-production@19');
NODE

  step "4. migrate, bootstrap (main + lane), autonomy on — all in the eval database"
  evrun gateway.env npm run -s db:migrate > "$E/eval-logs/migrate.log" 2>&1 && evrun gateway.env npm run -s sales:migrate >> "$E/eval-logs/migrate.log" 2>&1
  echo "eval core head: $(docker exec "$DB" psql -U r4_eval -d r4_eval -At -c 'select id from r4_schema_migrations order by id desc limit 1')"
  evrun gateway.env npm run -s production:sales:bootstrap > "$E/eval-logs/bootstrap.log" 2>&1 && evrun lane.env npm run -s production:sales:bootstrap -- --lane >> "$E/eval-logs/bootstrap.log" 2>&1
  grep -hoE '"registered":\[[^]]*\]' "$E/eval-logs/bootstrap.log" | paste -sd ' '
  evrun gateway.env npm run -s production:sales:control -- autonomy on --reason "image L3 evaluator (isolated)" > /dev/null 2>&1

  step "5. start the evaluator gateway (dispatch=$DISPATCH) and lane worker (own processes, not pm2)"
  for pid in $(evalpids); do kill "$pid" 2>/dev/null || true; done; sleep 3
  for svc in gateway lane; do
    f=gateway.env; cmd=production:sales:gateway; [ $svc = lane ] && f=lane.env && cmd=production:sales:worker
    # The whole subshell is detached with every descriptor redirected (an ssh session never waits for it).
    (cd "$E" && set -a && . "$EC/$f" && set +a && exec nohup npm run -s "$cmd") < /dev/null > "$E/eval-logs/$svc.log" 2>&1 &
    echo $! > "$E/eval-logs/$svc.pid"
  done
  sleep 15
  ! (exec 3<>/dev/tcp/127.0.0.1/14999) 2>/dev/null && echo "Quote tripwire 127.0.0.1:14999: closed (nothing listens)" || { echo "something listens on 14999: refusing"; exit 1; }
  curl -sf -m 5 "127.0.0.1:$PORT_GW/health" >/dev/null && echo "evaluator gateway /health 200 on 127.0.0.1:$PORT_GW"
  for svc in gateway lane; do kill -0 "$(cat "$E/eval-logs/$svc.pid")" 2>/dev/null && echo "evaluator $svc running" || { echo "$svc not running:"; tail -c 400 "$E/eval-logs/$svc.log"; exit 1; }; done
  echo "evaluator processes (cwd = evaluator copy): $(evalpids | wc -w)"
  grep -hoE '"event":"service.composed"[^}]*"profile":"[^"]*"' "$E/eval-logs/lane.log" | grep -oE '"profile":"[^"]*"' | tail -1
  ;;
status)
  for svc in gateway lane; do echo "$svc: $( [ -f "$E/eval-logs/$svc.pid" ] && kill -0 "$(cat "$E/eval-logs/$svc.pid")" 2>/dev/null && echo running || echo stopped)"; done
  echo "evaluator processes (cwd = evaluator copy): $(evalpids | wc -w)"
  docker ps --format '{{.Names}} {{.Status}}' | grep "$DB" || echo "db: absent"
  ;;
down)
  step "stop, destroy, shred"
  for pid in $(evalpids); do kill "$pid" 2>/dev/null || true; done; sleep 3
  for pid in $(evalpids); do kill -9 "$pid" 2>/dev/null || true; done
  docker rm -f "$DB" >/dev/null 2>&1 || true
  [ -d "$EC" ] && find "$EC" -type f -exec shred -u {} + && rmdir "$EC"
  [ -d "$E" ] && find "$E/eval-logs" -type f -exec shred -u {} + 2>/dev/null; rm -rf "$E"
  echo "evaluator removed"
  ;;
*) echo "usage: image-l3-eval.sh up [dispatch] | status | down"; exit 2 ;;
esac
