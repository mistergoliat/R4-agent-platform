#!/usr/bin/env bash
# R4 F1 canary observation (read-only). Reconciles every R4 quote.create against Quote V2 in both directions and reports
# idempotency, unknown outcomes, delivery and log health. Writes nothing. Usage: observe.sh [interval, default "24 hours"]
# Exit 1 when a critical condition is found (the operator then follows R4_F1_ACTIVATION_PROCEDURE.md §4.4 / §5).
set -uo pipefail
SINCE=${1:-24 hours}
PRINCIPAL=r4-sales-retail-session
r4() { docker exec r4-production-postgres psql -U r4_production -d r4_production -At -F' | ' -c "$1"; }
qv() { docker exec quote-v2-integration-postgres psql -U postgres -d quote_v2_integration -At -F' | ' -c "$1"; }
crit=0; flag() { echo "CRITICAL: $*"; crit=1; }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT

echo "== window: last $SINCE ($(date -u +%FT%TZ))"
echo "== R4 quote.create executions"; r4 "select status, count(*) from action_executions where capability_id='quote.create' and created_at > now() - interval '$SINCE' group by 1"
open=$(r4 "select count(*) from action_executions where capability_id='quote.create' and status not in ('succeeded','failed','rejected')")
[ "$open" = "0" ] || flag "$open quote.create not settled (executing/unknown): reconcile before any new issuance"

# R4 receipts: quote id | number | gross | replayed
r4 "select substring(resource_ref from 7), external_operation_ref, (result->'totals'->>'gross'), replayed from action_receipts where capability_id='quote.create' and status='succeeded' and recorded_at > now() - interval '$SINCE' order by 1" > "$T/r4"
# Quote: quote id | number | gross | status, for the R4 principal
qv "select quote_id, quote_number, gross_amount, status from quote_service.quotes where created_by_principal_id='$PRINCIPAL' and created_at > now() - interval '$SINCE' order by 1" > "$T/qv"
echo "== issued: R4 $(grep -c . "$T/r4") / Quote $(grep -c . "$T/qv")"
while IFS=' | ' read -r id num gross rep; do
  [ -z "$id" ] && continue
  q=$(grep "^$id " "$T/qv" || true)
  if [ -z "$q" ]; then flag "R4 receipt $num has no Quote record"; continue; fi
  qg=$(echo "$q" | awk -F' [|] ' '{print $3}'); qs=$(echo "$q" | awk -F' [|] ' '{print $4}')
  [ "$qg" = "$gross" ] || flag "$num gross differs (R4 $gross, Quote $qg)"
  echo "$num gross=$gross quote_status=$qs replayed=$rep"
done < "$T/r4"
cut -d' ' -f1 "$T/r4" | sort > "$T/r4ids"; cut -d' ' -f1 "$T/qv" | sort > "$T/qvids"
for id in $(comm -13 "$T/r4ids" "$T/qvids"); do flag "Quote $(grep "^$id " "$T/qv" | awk -F' [|] ' '{print $2}') has no R4 receipt (unknown outcome?)"; done

echo "== Quote idempotency and scope"
d=$(qv "select count(*) from (select quote_id from quote_service.idempotency_bindings where principal_id='$PRINCIPAL' and bound_at > now() - interval '$SINCE' and quote_id is not null group by 1 having count(*) > 1) x")
[ "$d" = "0" ] || flag "$d quotes with more than one idempotency binding"
s=$(qv "select count(*) from quote_service.quote_shipping s join quote_service.quotes q using (quote_id) where q.created_by_principal_id='$PRINCIPAL' and q.created_at > now() - interval '$SINCE'")
[ "$s" = "0" ] || flag "$s F1 quotes carry shipping"
p=$(qv "select count(*) from quote_service.quotes where created_by_principal_id='$PRINCIPAL' and created_at > now() - interval '$SINCE' and validity_policy_id <> 'cl-retail-session-60m-v1'")
[ "$p" = "0" ] || flag "$p F1 quotes outside the 60-minute policy"
c=$(qv "select count(*) from quote_service.cart_preparations where created_at > now() - interval '$SINCE'")
[ "$c" = "0" ] || flag "$c cart preparations (cart is off in F1)"
echo "dup bindings=$d shipping=$s off-policy=$p carts=$c"

echo "== WhatsApp delivery (R4 outbound)"; r4 "select status, count(*) from outbound_messages where created_at > now() - interval '$SINCE' group by 1 order by 1"
u=$(r4 "select count(*) from outbound_messages where created_at > now() - interval '$SINCE' and status in ('failed','unknown')")
[ "$u" = "0" ] || flag "$u outbound failed/unknown"
st=$(r4 "select count(*) from outbound_messages where status in ('pending','dispatching') and created_at < now() - interval '2 minutes'")
[ "$st" = "0" ] || flag "$st outbound stuck for more than 2 minutes"

echo "== logs (warn/error, Quote failures, timeouts, budget, reconciliation)"
cutoff=$(date -u -d "-$SINCE" +%FT%T)
awk -v c="$cutoff" -F'"time":"' '{split($2,a,"\""); if (a[1] >= c) print}' ~/.pm2/logs/r4-*-out.log > "$T/log"
echo "warn/error: $(grep -cE '"level":"(warn|error|fatal)"' "$T/log")"
qf=$(grep '"event":"quote.call"' "$T/log" | grep -vc '"outcome":"ok"'); echo "quote.call not ok: $qf"
[ "$qf" = "0" ] || flag "$qf Quote calls not ok"
for e in budget.exhausted reconciliation.unresolved action.outcome_uncertain task.run_failure.non_retryable; do
  n=$(grep -c "\"event\":\"$e\"" "$T/log"); echo "$e: $n"; [ "$n" = "0" ] || flag "$n $e"
done
grep -ciE 'timeout|timed_out' "$T/log" | sed 's/^/timeouts: /'

echo "== processes"; pm2 jlist | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const p of JSON.parse(s).filter(p=>p.name.startsWith("r4-")))console.log(p.name,p.pm2_env.status,"restarts="+p.pm2_env.restart_time)})'
echo "== lane: $(grep -E '^R4_PROD_LANE_PROFILE=' ~/.config/r4/production.env | cut -d= -f2)"
[ "$crit" = "0" ] && echo "RESULT: OK" || { echo "RESULT: CRITICAL"; exit 1; }
