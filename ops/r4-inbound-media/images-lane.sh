#!/usr/bin/env bash
# Image perception for the lane profile only (owner decision 2026-11-11), and the Quote tripwire of the first image L3.
#   bash images-lane.sh enable          gateway-only secrets file: images for sales-production@19 via deepseek-flash; restart gateway
#   bash images-lane.sh disable         perception off (media held for a person as before); unsettled media rows converted
#   bash images-lane.sh tripwire-on     lane worker's Quote URL -> closed loopback port (no quote can be issued); restart lane worker
#   bash images-lane.sh tripwire-off    lane worker's Quote configuration restored from its backup; restart lane worker
#   bash images-lane.sh status
# Audio stays disabled: no transcription credential is configured, so audio is held for a person exactly as before.
# Prints no secret: only variable NAMES and booleans.
set -euo pipefail
umask 077
R=~/R4-agent-platform; C=~/.config/r4; S="$C/secrets/perception.env"; Q="$C/quote-v2-retail.env"; QB="$C/quote-v2-retail.env.pre-image-l3"
TRIPWIRE='http://127.0.0.1:14999'
db() { docker exec r4-production-postgres psql -U r4_production -d r4_production -At -c "$1"; }
procenv() { local pid; pid=$(pgrep -P "$(pgrep -P "$(pm2 pid "$1")" | head -1)" | head -1 || true); [ -z "$pid" ] && pid=$(pgrep -P "$(pm2 pid "$1")" | head -1); tr '\0' '\n' < "/proc/$pid/environ"; }
show() {
  echo "gateway perception: $(procenv r4-channel-gateway | grep -E '^R4_MEDIA_PERCEPTION(_PROFILES)?=' | paste -sd ' ') vision-key=$(procenv r4-channel-gateway | grep -q '^R4_PERCEPTION_VISION_API_KEY=.' && echo yes || echo no) stt-key=$(procenv r4-channel-gateway | grep -q '^R4_PERCEPTION_STT_API_KEY=.' && echo yes || echo no)"
  echo "lane worker Quote: $(procenv r4-sales-worker-lane | grep -q "^R4_QUOTE_BASE_URL=$TRIPWIRE\$" && echo TRIPWIRE || echo real)"
  echo "tripwire port 14999: $( (exec 3<>/dev/tcp/127.0.0.1/14999) 2>/dev/null && echo OPEN || echo closed)"
}
health() { sleep 12; curl -sf -m 5 127.0.0.1:8090/health >/dev/null && echo "gateway /health 200"; pm2 jlist | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const p of JSON.parse(s).filter(p=>["r4-channel-gateway","r4-sales-worker-lane"].includes(p.name)))console.log(p.name,p.pm2_env.status)})'; }

case "${1:-}" in
enable)
  mkdir -p "$C/secrets"; cp -p "$C/run-gateway.sh" "$C/run-gateway.sh.pre-images"
  node -e '
    const fs = require("fs");
    const prod = Object.fromEntries(fs.readFileSync(process.argv[1], "utf8").split("\n").map((l) => /^([A-Z0-9_]+)=[\x27"]?(.*?)[\x27"]?$/.exec(l.trim())).filter(Boolean).map((m) => [m[1], m[2]]));
    if (!prod.R4_MODEL_API_KEY) throw new Error("no DeepSeek key in production.env");
    fs.writeFileSync(process.argv[2], ["R4_MEDIA_PERCEPTION=enabled", "R4_MEDIA_PERCEPTION_PROFILES=sales-production@19", `R4_PERCEPTION_VISION_API_KEY=${prod.R4_MODEL_API_KEY}`, "R4_PERCEPTION_VISION_MODEL=deepseek-flash", ""].join("\n"), { mode: 0o600 });
  ' "$C/production.env" "$S"
  grep -qF "source $S" "$C/run-gateway.sh" || sed -i "s#^source /home/ec2-user/.config/r4/production.env\$#&\nsource $S#" "$C/run-gateway.sh"
  grep -qF "source $S" "$C/run-gateway.sh" || { echo "could not wire the secrets file into run-gateway.sh"; exit 1; }
  pm2 restart r4-channel-gateway >/dev/null; health; show
  ;;
disable)
  [ -f "$S" ] && sed -i 's/^R4_MEDIA_PERCEPTION=.*/R4_MEDIA_PERCEPTION=disabled/' "$S"
  echo "unsettled media rows converted to held-unsupported: $(db "update inbound_events set content_kind = 'unsupported', content = '[unsupported inbound content: ' || content_type || ']', content_sha256 = null where status = 'received' and content_kind = 'media' returning 1" | grep -c . || true)"
  pm2 restart r4-channel-gateway >/dev/null; health; show
  ;;
tripwire-on)
  ! (exec 3<>/dev/tcp/127.0.0.1/14999) 2>/dev/null || { echo "something listens on 14999: refusing"; exit 1; }
  [ -f "$QB" ] || cp -p "$Q" "$QB"
  sed -i "s#^R4_QUOTE_BASE_URL=.*#R4_QUOTE_BASE_URL=$TRIPWIRE#" "$Q"
  pm2 restart r4-sales-worker-lane >/dev/null; health; show
  ;;
tripwire-off)
  [ -f "$QB" ] || { echo "no backup of the Quote configuration"; exit 1; }
  cat "$QB" > "$Q" && rm -f "$QB"
  pm2 restart r4-sales-worker-lane >/dev/null; health; show
  ;;
status) show ;;
*) echo "usage: images-lane.sh enable|disable|tripwire-on|tripwire-off|status"; exit 2 ;;
esac
