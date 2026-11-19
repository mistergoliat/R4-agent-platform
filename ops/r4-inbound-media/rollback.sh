#!/usr/bin/env bash
# Rollback (owner-authorized).
#   bash rollback.sh 1                       perception off: images held for a person as before (code unchanged)
#   PREV_FULL=<full sha> bash rollback.sh 2  code back to PREV with deploy.sh (current lane kept)
# Level 2 first converts any UNSETTLED media row (a pre-0016 build would read it as text) and runs level 1; then the
# coordinated deploy of PREV. The lane is read from production.env (it was hard-coded to @19), and EXPECT_HEAD is the
# newest Core migration PREV ships: deploy.sh refuses before stopping anything if the database is ahead of it.
# The console's «Volver a la versión anterior» (ADR-049/050) is the usual way back: a plain deploy.sh of the previous
# SHA, without turning perception off. Use level 2 here only when images must be held too.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
R=~/R4-agent-platform; C=~/.config/r4
case "${1:-}" in
1) bash "$HERE/images-lane.sh" disable ;;
2)
  : "${PREV_FULL:?set PREV_FULL=<full sha of the previous deploy>}"
  bash "$HERE/images-lane.sh" disable
  [ "$(docker exec r4-production-postgres psql -U r4_production -d r4_production -At -c "select count(*) from inbound_events where status = 'received' and content_kind = 'media'")" = 0 ] || { echo "unsettled media rows remain"; exit 1; }
  LANE=$(grep -oE '^R4_PROD_LANE_PROFILE=.*' "$C/production.env" | cut -d= -f2)
  EXPECT_HEAD=$(cd "$R" && git fetch -q origin && git ls-tree --name-only "$PREV_FULL" packages/persistence-postgres/migrations/ | sed 's|.*/||; s|\.sql$||' | sort | tail -1)
  TARGET="$PREV_FULL" PREV="$(cd "$R" && git rev-parse --short HEAD)" LANE="$LANE" EXPECT_HEAD="$EXPECT_HEAD" bash "$HERE/deploy.sh"
  ;;
*) echo "usage: rollback.sh 1 | PREV_FULL=<sha> rollback.sh 2"; exit 2 ;;
esac
