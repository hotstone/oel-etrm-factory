#!/usr/bin/env bash
# Manually trigger the executor with a plan file. Used to prove Step 1 before
# the orchestrator exists. Usage:
#   scripts/run-executor.sh <ISSUE_ID> <plan-file> "<issue title>" <issue-url>
set -euo pipefail

ISSUE_ID="${1:?usage: run-executor.sh <ISSUE_ID> <plan-file> <issue-title> <issue-url>}"
PLAN_FILE="${2:?plan file required}"
ISSUE_TITLE="${3:?issue title required}"
ISSUE_URL="${4:?issue url required}"

REGION="ap-southeast-2"
BUCKET="etrmfactory-agent-artifacts-007460876082"
PROJECT="claude-code-executor"
RUN_ID="$(date +%Y%m%d-%H%M%S)"
PLAN_S3_URI="s3://${BUCKET}/plans/${ISSUE_ID}/${RUN_ID}/plan.md"

aws s3 cp "$PLAN_FILE" "$PLAN_S3_URI" --region "$REGION"
echo "plan uploaded: $PLAN_S3_URI"

BUILD_ID=$(aws codebuild start-build --project-name "$PROJECT" --region "$REGION" \
  --environment-variables-override \
    "name=ISSUE_ID,value=${ISSUE_ID},type=PLAINTEXT" \
    "name=ISSUE_TITLE,value=${ISSUE_TITLE},type=PLAINTEXT" \
    "name=ISSUE_URL,value=${ISSUE_URL},type=PLAINTEXT" \
    "name=PLAN_S3_URI,value=${PLAN_S3_URI},type=PLAINTEXT" \
  --query 'build.id' --output text)
echo "build started: $BUILD_ID"
echo "logs: https://${REGION}.console.aws.amazon.com/codesuite/codebuild/projects/${PROJECT}/build/${BUILD_ID}"

while true; do
  STATUS=$(aws codebuild batch-get-builds --ids "$BUILD_ID" --region "$REGION" \
    --query 'builds[0].buildStatus' --output text)
  PHASE=$(aws codebuild batch-get-builds --ids "$BUILD_ID" --region "$REGION" \
    --query 'builds[0].currentPhase' --output text)
  echo "$(date +%H:%M:%S) status=$STATUS phase=$PHASE"
  [ "$STATUS" != "IN_PROGRESS" ] && break
  sleep 20
done

echo "== exported variables =="
aws codebuild batch-get-builds --ids "$BUILD_ID" --region "$REGION" \
  --query 'builds[0].exportedEnvironmentVariables' --output table

[ "$STATUS" = "SUCCEEDED" ] || { echo "build finished with status $STATUS"; exit 1; }
