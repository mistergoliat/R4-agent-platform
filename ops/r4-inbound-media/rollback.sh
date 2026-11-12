#!/usr/bin/env bash
# Rollback of inbound multimodal v1 (owner-authorized).
#   bash rollback.sh 1                       perception off: images held for a person as before (code unchanged)
#   PREV_FULL=<788f1f9 full sha> bash rollback.sh 2    code back to PREV (Core head stays 0016: PREV treats it as current)
# Level 2 first converts any UNSETTLED media row (PREV would read it as text) and runs level 1; then the coordinated
# deploy of PREV. Migration 0016 is not reverted: it only widened a check constraint, and PREV never writes `media`.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
R=~/R4-agent-platform
case "${1:-}" in
1) bash "$HERE/images-lane.sh" disable ;;
2)
  : "${PREV_FULL:?set PREV_FULL=<full sha of the previous deploy>}"
  bash "$HERE/images-lane.sh" disable
  [ "$(docker exec r4-production-postgres psql -U r4_production -d r4_production -At -c "select count(*) from inbound_events where status = 'received' and content_kind = 'media'")" = 0 ] || { echo "unsettled media rows remain"; exit 1; }
  TARGET="$PREV_FULL" PREV="$(cd "$R" && git rev-parse --short HEAD)" LANE=sales-production@19 EXPECT_HEAD=0016_inbound_media bash "$HERE/deploy.sh"
  ;;
*) echo "usage: rollback.sh 1 | PREV_FULL=<sha> rollback.sh 2"; exit 2 ;;
esac
