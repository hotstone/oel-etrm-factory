#!/usr/bin/env bash
# Build the runtime container, push to ECR, and create/update the AgentCore
# runtime. Re-runnable: existing resources are updated, not recreated.
set -euo pipefail

REGION="ap-southeast-2"
ACCOUNT="007460876082"
ECR_REPO="etrm-factory-runtime"
ROLE_NAME="etrm-factory-runtime-role"
RUNTIME_NAME="etrm_factory_pipeline"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE_URI="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/${ECR_REPO}"
TAG="$(date +%Y%m%d-%H%M%S)"

echo "== ECR repository =="
aws ecr describe-repositories --repository-names "$ECR_REPO" --region "$REGION" >/dev/null 2>&1 \
  || aws ecr create-repository --repository-name "$ECR_REPO" --region "$REGION" \
       --query 'repository.repositoryUri' --output text

echo "== Build & push image (linux/arm64 — AgentCore requirement) =="
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"
docker build --platform linux/arm64 -t "${IMAGE_URI}:${TAG}" -t "${IMAGE_URI}:latest" "${REPO_ROOT}/src/runtime"
docker push "${IMAGE_URI}:${TAG}"
docker push "${IMAGE_URI}:latest"
echo "pushed ${IMAGE_URI}:${TAG}"

echo "== IAM execution role =="
if ! aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE_NAME" \
    --assume-role-policy-document "file://${REPO_ROOT}/infra/iam/runtime-trust-policy.json" >/dev/null
  echo "created role $ROLE_NAME; waiting for propagation"
  sleep 12
fi
aws iam put-role-policy --role-name "$ROLE_NAME" \
  --policy-name runtime-permissions \
  --policy-document "file://${REPO_ROOT}/infra/iam/runtime-policy.json"
ROLE_ARN="arn:aws:iam::${ACCOUNT}:role/${ROLE_NAME}"

echo "== AgentCore runtime =="
EXISTING=$(aws bedrock-agentcore-control list-agent-runtimes --region "$REGION" \
  --query "agentRuntimes[?agentRuntimeName=='${RUNTIME_NAME}'].agentRuntimeId" --output text)

if [ -n "$EXISTING" ] && [ "$EXISTING" != "None" ]; then
  aws bedrock-agentcore-control update-agent-runtime --region "$REGION" \
    --agent-runtime-id "$EXISTING" \
    --agent-runtime-artifact "{\"containerConfiguration\": {\"containerUri\": \"${IMAGE_URI}:${TAG}\"}}" \
    --network-configuration '{"networkMode": "PUBLIC"}' \
    --environment-variables AGENT_OBSERVABILITY_ENABLED=true \
    --role-arn "$ROLE_ARN" \
    --query 'agentRuntimeArn' --output text
  echo "updated runtime $RUNTIME_NAME to ${TAG}"
else
  aws bedrock-agentcore-control create-agent-runtime --region "$REGION" \
    --agent-runtime-name "$RUNTIME_NAME" \
    --description "Linear ticket-to-PR pipeline (Strands graph + Claude Code)" \
    --agent-runtime-artifact "{\"containerConfiguration\": {\"containerUri\": \"${IMAGE_URI}:${TAG}\"}}" \
    --network-configuration '{"networkMode": "PUBLIC"}' \
    --environment-variables AGENT_OBSERVABILITY_ENABLED=true \
    --role-arn "$ROLE_ARN" \
    --query 'agentRuntimeArn' --output text
  echo "created runtime $RUNTIME_NAME"
fi
