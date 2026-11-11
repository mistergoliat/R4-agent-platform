#!/usr/bin/env bash
# R4 F1 operational alerts: CloudWatch metric filters over the R4 telemetry the pm2 logs already carry, alarms, and an
# SNS e-mail topic. Run ONCE by an AWS operator with permission for logs, cloudwatch and sns in the instance's region.
# The R4 logs carry no secrets or personal data (event names, opaque ids, codes); the filters read only event fields.
#   REGION=us-east-1 ALERT_EMAIL=<owner-authorized address> ./setup-alarms.sh
set -euo pipefail
: "${REGION:?}" "${ALERT_EMAIL:?}"
G=/r4/production; NS=R4/F1
TOPIC=$(aws sns create-topic --region "$REGION" --name r4-f1-alerts --query TopicArn --output text)
aws sns subscribe --region "$REGION" --topic-arn "$TOPIC" --protocol email --notification-endpoint "$ALERT_EMAIL" >/dev/null
aws logs create-log-group --region "$REGION" --log-group-name "$G" 2>/dev/null || true

filter() { # name pattern
  aws logs put-metric-filter --region "$REGION" --log-group-name "$G" --filter-name "r4-f1-$1" --filter-pattern "$2" \
    --metric-transformations metricName="$1",metricNamespace="$NS",metricValue=1,defaultValue=0
}
alarm() { # name threshold description
  aws cloudwatch put-metric-alarm --region "$REGION" --alarm-name "r4-f1-$1" --alarm-description "$3" --namespace "$NS" --metric-name "$1" \
    --statistic Sum --period 300 --evaluation-periods 1 --threshold "$2" --comparison-operator GreaterThanOrEqualToThreshold \
    --treat-missing-data notBreaching --alarm-actions "$TOPIC" --ok-actions "$TOPIC"
}
# 1. Runtime unavailable (log side; the process side is below).
filter RuntimeErrors '{ ($.event = "worker.stopped") || ($.event = "scheduler.cycle.failed") || ($.event = "task.run_failure.non_retryable") }'
alarm RuntimeErrors 1 'R4 runtime: a worker stopped, a scheduler cycle failed or a non-retryable model failure'
# 2. Repeated Quote failures.
filter QuoteFailures '{ ($.event = "quote.call") && ($.outcome = "failed") }'
alarm QuoteFailures 3 'R4 -> Quote V2: 3 or more failed calls in 5 minutes'
# 3. Unknown outcomes not resolved.
filter UnknownOutcomes '{ ($.event = "reconciliation.unresolved") || ($.event = "action.outcome_uncertain") }'
alarm UnknownOutcomes 1 'R4: a write with an uncertain or unresolved outcome (quote.create held on its key)'
# 4. Idempotency anomalies.
filter IdempotencyConflicts '{ ($.event = "quote.call") && ($.errorCode = "idempotency_key_conflict") }'
alarm IdempotencyConflicts 1 'R4 -> Quote V2: an idempotency key was reused with a different body'
# 5. WhatsApp delivery failures.
filter DeliveryFailures '{ ($.event = "outbound.failed") || ($.event = "outbound.unknown") }'
alarm DeliveryFailures 1 'R4 WhatsApp: a message failed or has an unknown delivery outcome'
# 6. Write budget anomalies.
filter WriteBudgetExhausted '{ $.event = "budget.exhausted" }'
alarm WriteBudgetExhausted 1 'R4: a task exhausted its write budget (6 per task on the F1 lane)'
# Process side of 1: each pm2 process must be running (procstat from the CloudWatch agent).
for p in "production.js --gateway:1" "production.js --worker:2" "start:scheduler:1"; do
  pattern=${p%:*}; expected=${p##*:}
  aws cloudwatch put-metric-alarm --region "$REGION" --alarm-name "r4-f1-process-$(echo "$pattern" | tr -c 'a-z' '-')" \
    --alarm-description "R4 process '$pattern' running fewer than $expected" --namespace "$NS" --metric-name procstat_lookup_pid_count \
    --dimensions Name=pattern,Value="$pattern" Name=pid_finder,Value=native --statistic Minimum --period 60 --evaluation-periods 2 \
    --threshold "$expected" --comparison-operator LessThanThreshold --treat-missing-data breaching --alarm-actions "$TOPIC" --ok-actions "$TOPIC"
done
echo "topic: $TOPIC (confirm the subscription e-mail, then: aws sns publish --region $REGION --topic-arn $TOPIC --subject 'R4 F1 alert test' --message 'test')"
