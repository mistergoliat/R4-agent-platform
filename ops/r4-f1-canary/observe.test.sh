#!/usr/bin/env bash
# Offline check of observe.sh's shipping reconciliation (F1-COMMERCIAL-POLICY-v2): a fake docker returns one quote whose
# shipping disagrees with R4 on every axis; each must be flagged. Usage: bash ops/r4-f1-canary/observe.test.sh
set -u
D=$(mktemp -d); trap 'rm -rf "$D"' EXIT
cat > "$D/docker" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *jsonb_typeof*) echo "q1|PC-9|5000|4202|Pesas Chile|Despacho Directo|sales-production@18" ;;
  *s.source_quote_system*) echo "q1|PC-9|4990|4193|797|Blue Express|EXPRESS|pc-carrier|600" ;;
  *"substring(resource_ref"*) echo "q1 | PC-9 | 17980 | f" ;;
  *"quote_number, gross_amount, status"*) echo "q1 | PC-9 | 17980 | issued | t1" ;;
  *"count(*)"*) echo 0 ;;
esac
EOF
printf '#!/usr/bin/env bash\necho "[]"\n' > "$D/pm2"; chmod +x "$D/docker" "$D/pm2"
out=$(PATH="$D:$PATH" bash "$(dirname "$0")/observe.sh" "1 hour" 2>/dev/null); code=$?
fail=0
for want in 'not re-quoted at issuance' 'shipping amount differs' 'shipping modality differs' "issued under 'sales-production@18'" 'RESULT: CRITICAL'; do
  grep -qF "$want" <<< "$out" || { echo "MISSING: $want"; fail=1; }
done
[ "$code" = 1 ] || { echo "exit code $code, expected 1"; fail=1; }
[ "$fail" = 0 ] && echo "observe.sh shipping checks: OK" || exit 1
