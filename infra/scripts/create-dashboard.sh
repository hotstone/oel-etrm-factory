#!/usr/bin/env bash
# Create/update the CloudWatch dashboard and failure alarm for the pipeline.
# Metrics come from EMF lines emitted by the runtime (namespace EtrmFactory/Pipeline).
set -euo pipefail

REGION="ap-southeast-2"
NS="EtrmFactory/Pipeline"
DASHBOARD="etrm-factory-pipeline"

cat > /tmp/dashboard.json <<EOF
{
  "widgets": [
    {
      "type": "metric", "x": 0, "y": 0, "width": 8, "height": 6,
      "properties": {
        "title": "Runs by outcome (1h)", "region": "${REGION}", "view": "timeSeries", "stacked": true,
        "period": 3600, "stat": "Sum",
        "metrics": [
          ["${NS}", "PipelineRuns", "Outcome", "completed", {"color": "#2ca02c"}],
          ["${NS}", "PipelineRuns", "Outcome", "blocked", {"color": "#ff7f0e"}],
          ["${NS}", "PipelineRuns", "Outcome", "failed", {"color": "#d62728"}]
        ]
      }
    },
    {
      "type": "metric", "x": 8, "y": 0, "width": 8, "height": 6,
      "properties": {
        "title": "Pipeline duration", "region": "${REGION}", "view": "timeSeries",
        "period": 3600,
        "metrics": [
          ["${NS}", "PipelineDurationMs", "Outcome", "completed", {"stat": "p50", "label": "p50 completed"}],
          ["${NS}", "PipelineDurationMs", "Outcome", "completed", {"stat": "p90", "label": "p90 completed"}]
        ]
      }
    },
    {
      "type": "metric", "x": 16, "y": 0, "width": 8, "height": 6,
      "properties": {
        "title": "Stage duration (avg)", "region": "${REGION}", "view": "timeSeries",
        "period": 3600, "stat": "Average",
        "metrics": [
          ["${NS}", "StageDurationMs", "Stage", "analyze"],
          ["${NS}", "StageDurationMs", "Stage", "plan"],
          ["${NS}", "StageDurationMs", "Stage", "implement"],
          ["${NS}", "StageDurationMs", "Stage", "review"]
        ]
      }
    },
    {
      "type": "metric", "x": 0, "y": 6, "width": 8, "height": 6,
      "properties": {
        "title": "Tokens by stage (sum)", "region": "${REGION}", "view": "timeSeries", "stacked": true,
        "period": 3600, "stat": "Sum",
        "metrics": [
          ["${NS}", "InputTokens", "Stage", "analyze"],
          ["${NS}", "OutputTokens", "Stage", "analyze"]
        ]
      }
    },
    {
      "type": "metric", "x": 8, "y": 6, "width": 8, "height": 6,
      "properties": {
        "title": "Loop iterations (sum)", "region": "${REGION}", "view": "timeSeries",
        "period": 3600, "stat": "Sum",
        "metrics": [
          ["${NS}", "CritiqueIterations", "Outcome", "completed"],
          ["${NS}", "RevisionRuns", "Outcome", "completed"]
        ]
      }
    },
    {
      "type": "log", "x": 16, "y": 6, "width": 8, "height": 6,
      "properties": {
        "title": "Recent runs", "region": "${REGION}",
        "query": "SOURCE '/aws/bedrock-agentcore/runtimes/etrm_factory_pipeline-WNJDR0HSAQ-DEFAULT' | fields @timestamp, issue, Outcome, PipelineDurationMs, prUrl, detail | filter summaryType = 'pipeline-run' | sort @timestamp desc | limit 20",
        "view": "table"
      }
    }
  ]
}
EOF

aws cloudwatch put-dashboard --region "$REGION" \
  --dashboard-name "$DASHBOARD" \
  --dashboard-body file:///tmp/dashboard.json \
  --query 'DashboardValidationMessages' --output json
echo "dashboard: https://${REGION}.console.aws.amazon.com/cloudwatch/home?region=${REGION}#dashboards/dashboard/${DASHBOARD}"

# Alarm: any failed run in the last hour. No actions wired yet (no SNS topic);
# it shows in the console/alarm views — add an SNS action when a channel exists.
aws cloudwatch put-metric-alarm --region "$REGION" \
  --alarm-name etrm-factory-pipeline-failed \
  --alarm-description "A ticket pipeline run failed (outcome=failed)" \
  --namespace "$NS" --metric-name PipelineRuns \
  --dimensions Name=Outcome,Value=failed \
  --statistic Sum --period 3600 --evaluation-periods 1 \
  --threshold 1 --comparison-operator GreaterThanOrEqualToThreshold \
  --treat-missing-data notBreaching
echo "alarm: etrm-factory-pipeline-failed"
