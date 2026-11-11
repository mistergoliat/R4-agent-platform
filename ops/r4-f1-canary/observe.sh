#!/usr/bin/env bash
# R4 F1 canary observation (read-only). Reconciles every R4 quote.create against Quote V2 in both directions (totals and,
# under F1-COMMERCIAL-POLICY-v2, shipping: pc-carrier backing, re-quote at issuance, amount, modality, profile) and reports
# idempotency, unknown outcomes, delivery and log health. Writes nothing. Usage: observe.sh [interval, default "24 hours"]
# Exit 1 when a critical condition is found (the operator then follows R4_F1_ACTIVATION_PROCEDURE.md §4.4 / §5).
set -uo pipefail
SINCE=${1:-24 hours}
PRINCIPAL=${PRINCIPAL:-r4-sales-retail-session}
SHIPPING_PROFILES='sales-production@19'   # F1-COMMERCIAL-POLICY-v2; every other profile is v1 (no shipping)
SHIPPING_SOURCE=pc-carrier; REQUOTE_MAX_S=120
# Production processes only: r4-web-qa-* is the web QA deployment and is observed separately.
PROD_LOGS="r4-channel-gateway r4-sales-worker r4-sales-worker-lane r4-scheduler"
r4() { docker exec r4-production-postgres psql -U r4_production -d r4_production -At -F"${2:- | }" -c "$1"; }
qv() { docker exec quote-v2-integration-postgres psql -U postgres -d quote_v2_integration -At -F"${2:- | }" -c "$1"; }
crit=0; flag() { echo "CRITICAL: $*"; crit=1; }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT

echo "== window: last $SINCE ($(date -u +%FT%TZ))"
echo "== R4 quote.create executions"; r4 "select status, count(*) from action_executions where capability_id='quote.create' and created_at > now() - interval '$SINCE' group by 1"
open=$(r4 "select count(*) from action_executions where capability_id='quote.create' and status not in ('succeeded','failed','rejected')")
[ "$open" = "0" ] || flag "$open quote.create not settled (executing/unknown): reconcile before any new issuance"

# R4 receipts: quote id | number | gross | replayed
r4 "select substring(resource_ref from 7), external_operation_ref, (result->'totals'->>'gross'), replayed from action_receipts where capability_id='quote.create' and status='succeeded' and recorded_at > now() - interval '$SINCE' order by 1" > "$T/r4"
# Quote: quote id | number | gross | status, for the R4 principal
qv "select quote_id, quote_number, gross_amount, status, external_reference from quote_service.quotes where created_by_principal_id='$PRINCIPAL' and created_at > now() - interval '$SINCE' order by 1" > "$T/qv"
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
# A Quote quote without an R4 receipt is critical only when its task (the external reference) is a task of this R4;
# otherwise it was issued by another R4 database with the same principal (isolated canary / L3) and is reported only.
for id in $(comm -13 "$T/r4ids" "$T/qvids"); do
  num=$(grep "^$id " "$T/qv" | awk -F' [|] ' '{print $2}'); ref=$(grep "^$id " "$T/qv" | awk -F' [|] ' '{print $5}')
  if [ "$(r4 "select count(*) from agent_tasks where task_id::text = '$ref'")" != "0" ]; then flag "Quote $num has no R4 receipt for its production task (unknown outcome?)"; else echo "info: Quote $num was issued outside this R4 (another database: isolated canary or L3)"; fi
done

echo "== Quote idempotency and scope"
d=$(qv "select count(*) from (select quote_id from quote_service.idempotency_bindings where principal_id='$PRINCIPAL' and bound_at > now() - interval '$SINCE' and quote_id is not null group by 1 having count(*) > 1) x")
[ "$d" = "0" ] || flag "$d quotes with more than one idempotency binding"
s=$(qv "select count(*) from quote_service.quote_shipping s join quote_service.quotes q using (quote_id) where q.created_by_principal_id='$PRINCIPAL' and q.created_at > now() - interval '$SINCE'")
p=$(qv "select count(*) from quote_service.quotes where created_by_principal_id='$PRINCIPAL' and created_at > now() - interval '$SINCE' and validity_policy_id <> 'cl-retail-session-60m-v1'")
[ "$p" = "0" ] || flag "$p F1 quotes outside the 60-minute policy"
c=$(qv "select count(*) from quote_service.cart_preparations where created_at > now() - interval '$SINCE'")
[ "$c" = "0" ] || flag "$c cart preparations (cart is off in F1)"
echo "dup bindings=$d shipping=$s off-policy=$p carts=$c"

# F1-COMMERCIAL-POLICY-v2 (@19 only): a quote may carry shipping only when the Shipping owner (pc-carrier) priced it, it
# was re-quoted in the issuance call, it was issued under a v2 profile, and R4 and Quote agree on amount and modality.
# @17/@18 (v1) never carry shipping. Fields are '|'-separated so empty values and names with spaces survive.
echo "== shipping (F1-COMMERCIAL-POLICY-v2: $SHIPPING_PROFILES, $SHIPPING_SOURCE, re-quoted <= ${REQUOTE_MAX_S}s before issuance)"
r4 "select substring(r.resource_ref from 7), r.external_operation_ref, r.result->'shipping'->'amounts'->>'gross', r.result->'shipping'->'amounts'->>'net', r.result->'shipping'->>'carrierName', r.result->'shipping'->>'serviceType', coalesce((select b.profile from channel_conversation_bindings b where b.task_id = r.task_id limit 1), '') from action_receipts r where r.capability_id='quote.create' and r.status='succeeded' and r.recorded_at > now() - interval '$SINCE' and jsonb_typeof(r.result->'shipping') = 'object' order by 1" '|' > "$T/r4s"
qv "select q.quote_id, q.quote_number, s.gross_amount, s.net_amount, s.tax_amount, s.carrier_name, s.service_type_name, coalesce(s.source_quote_system, ''), coalesce(extract(epoch from q.created_at - s.source_quote_as_of)::int::text, '') from quote_service.quote_shipping s join quote_service.quotes q using (quote_id) where q.created_by_principal_id='$PRINCIPAL' and q.created_at > now() - interval '$SINCE' order by 1" '|' > "$T/qvs"
while IFS='|' read -r id num g n t car svc src age; do
  [ -z "$id" ] && continue
  [ "$src" = "$SHIPPING_SOURCE" ] || flag "$num shipping has no $SHIPPING_SOURCE backing (source '${src:-none}')"
  { [ -n "$age" ] && [ "$age" -ge -5 ] && [ "$age" -le "$REQUOTE_MAX_S" ]; } || flag "$num shipping rate not re-quoted at issuance (rate asOf ${age:-missing} s before issuance, max ${REQUOTE_MAX_S}s)"
  [ "$((n + t))" = "$g" ] || flag "$num shipping net $n + tax $t != gross $g in Quote"
  r=$(grep "^$id|" "$T/r4s" || true)
  if [ -z "$r" ]; then
    if grep -qx "$id" "$T/r4ids"; then flag "$num carries shipping in Quote but not in its R4 receipt"; else echo "info: $num shipping issued outside this R4 (no receipt here)"; fi
    continue
  fi
  IFS='|' read -r _ _ rg rn rcar rsvc prof <<< "$r"
  [ "$rg" = "$g" ] && [ "$rn" = "$n" ] || flag "$num shipping amount differs (R4 gross $rg net $rn; Quote gross $g net $n)"
  [ "$rcar" = "$car" ] && [ "$rsvc" = "$svc" ] || flag "$num shipping modality differs (R4 '$rcar / $rsvc'; Quote '$car / $svc')"
  case " $SHIPPING_PROFILES " in *" $prof "*) ;; *) flag "$num carries shipping but was issued under '${prof:-unknown profile}' (v1: no shipping)";; esac
  echo "$num shipping $car / $svc gross=$g net=$n (R4 gross=$rg) source=$src asOf=${age}s before issuance profile=$prof"
done < "$T/qvs"
for id in $(cut -d'|' -f1 "$T/r4s"); do
  grep -q "^$id|" "$T/qvs" || flag "R4 receipt $(grep "^$id|" "$T/r4s" | cut -d'|' -f2) has shipping that Quote does not"
done

echo "== WhatsApp delivery (R4 outbound)"; r4 "select status, count(*) from outbound_messages where created_at > now() - interval '$SINCE' group by 1 order by 1"
u=$(r4 "select count(*) from outbound_messages where created_at > now() - interval '$SINCE' and status in ('failed','unknown')")
[ "$u" = "0" ] || flag "$u outbound failed/unknown"
st=$(r4 "select count(*) from outbound_messages where status in ('pending','dispatching') and created_at < now() - interval '2 minutes'")
[ "$st" = "0" ] || flag "$st outbound stuck for more than 2 minutes"

echo "== quote PDF documents (@18+)"
r4 "select o.status, count(*), count(*) filter (where d.bytes is null) from outbound_documents d join outbound_messages o using (outbound_id) where d.created_at > now() - interval '$SINCE' group by 1 order by 1" | sed 's/^/documents status|count|purged: /'
sd=$(r4 "select count(*) from outbound_documents d join outbound_messages o using (outbound_id) where o.status in ('pending','dispatching') and o.created_at < now() - interval '2 minutes'")
[ "$sd" = "0" ] || flag "$sd quote documents pending for more than 2 minutes"
nq=$(r4 "select count(*) from action_receipts where capability_id = 'quote.create' and recorded_at > now() - interval '$SINCE' and result->'document'->>'delivery' = 'not_queued'")
[ "$nq" = "0" ] || flag "$nq issued quotes whose PDF was not queued (quote.document.not_queued)"
fd=$(r4 "select count(*) from outbound_documents d join outbound_messages o using (outbound_id) where d.created_at > now() - interval '$SINCE' and o.status in ('failed','unknown','cancelled')")
[ "$fd" = "0" ] || flag "$fd quote documents failed/unknown/cancelled (the PDF did not reach the contact; a person sends it from Quote)"

echo "== production logs in the window (warn/error, Quote failures, timeouts, budget, reconciliation)"
cutoff=$(date -u -d "-$SINCE" +%FT%T)
for p in $PROD_LOGS; do f=~/.pm2/logs/$p-out.log; [ -f "$f" ] && awk -v c="$cutoff" -F'"time":"' '{split($2,a,"\""); if (a[1] >= c) print}' "$f"; done > "$T/log"
echo "warn/error: $(grep -cE '"level":"(warn|error|fatal)"' "$T/log")"
qf=$(grep '"event":"quote.call"' "$T/log" | grep -vc '"outcome":"ok"'); echo "quote.call not ok: $qf"
[ "$qf" = "0" ] || flag "$qf Quote calls not ok"
for e in budget.exhausted reconciliation.unresolved action.outcome_uncertain task.run_failure.non_retryable; do
  n=$(grep -c "\"event\":\"$e\"" "$T/log"); echo "$e: $n"; [ "$n" = "0" ] || flag "$n $e"
done
grep -ciE 'timeout|timed_out' "$T/log" | sed 's/^/timeouts: /'

echo "== processes"; pm2 jlist | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const p of JSON.parse(s).filter(p=>p.name.startsWith("r4-")))console.log(p.name,p.pm2_env.status,"restarts="+p.pm2_env.restart_time)})'
echo "== deployed: $(cd ~/R4-agent-platform && git rev-parse --short HEAD)"
echo "== lane: $(grep -E '^R4_PROD_LANE_PROFILE=' ~/.config/r4/production.env | cut -d= -f2) (worker $(grep -E '^R4_PROD_POLICY_PROFILE=' ~/.config/r4/production-lane.env | cut -d= -f2)); $(grep -E '^R4_PROD_ROLLOUT_PERCENT=' ~/.config/r4/production.env)"
[ "$crit" = "0" ] && echo "RESULT: OK" || { echo "RESULT: CRITICAL"; exit 1; }
