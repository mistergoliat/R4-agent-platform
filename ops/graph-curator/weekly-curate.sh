#!/usr/bin/env bash
# ADR-058 G3: the weekly curator run, Sundays 22:00 America/Santiago (owner decision, 2026-11-23).
# pm2 starts this every hour (cron_restart "0 * * * *", no autorestart) and it runs only in that hour, so Chile's
# clock changes need no edit. It proposes; nothing changes the graph until a person approves and signs in the console.
#   pm2 start ~/R4-agent-platform/ops/graph-curator/weekly-curate.sh --name r4-graph-weekly --cron-restart "0 * * * *" --no-autorestart
set -euo pipefail
[ "$(TZ=America/Santiago date +%u%H)" = "722" ] || exit 0
R=~/R4-agent-platform; C=~/.config/r4
cd "$R"
set -a; . "$C/production.env"; . "$C/secrets/catalog-v2.env"; set +a
exec npm run -s graph:curate -- --started-by schedule:weekly
