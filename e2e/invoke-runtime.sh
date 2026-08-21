#!/usr/bin/env bash
# Invoke the deployed AgentCore runtime with an issue ID.
# Usage: scripts/invoke-runtime.sh HOT-52
set -euo pipefail

ISSUE_ID="${1:?usage: invoke-runtime.sh <ISSUE_ID>}"
REGION="ap-southeast-2"
RUNTIME_NAME="etrm_factory_pipeline"

ARN=$(aws bedrock-agentcore-control list-agent-runtimes --region "$REGION" \
  --query "agentRuntimes[?agentRuntimeName=='${RUNTIME_NAME}'].agentRuntimeArn" --output text)
[ -n "$ARN" ] || { echo "runtime ${RUNTIME_NAME} not found"; exit 1; }

# Session IDs must be at least 33 characters.
SESSION_ID="etrm-$(date +%s)-$(openssl rand -hex 12)"
OUT="/tmp/agentcore-invoke-$$.json"

echo "invoking $ARN (session $SESSION_ID) for $ISSUE_ID ..."
aws bedrock-agentcore invoke-agent-runtime --region "$REGION" \
  --agent-runtime-arn "$ARN" \
  --runtime-session-id "$SESSION_ID" \
  --content-type application/json \
  --accept application/json \
  --payload "{\"issueId\": \"${ISSUE_ID}\", \"sync\": true}" \
  --cli-binary-format raw-in-base64-out \
  --cli-read-timeout 0 \
  "$OUT"

echo "== response =="
cat "$OUT"; echo
