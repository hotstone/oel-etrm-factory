#!/usr/bin/env bash
# Deploy the Linear webhook Lambda: role, function, function URL.
# Re-runnable: updates code/config when the function already exists.
set -euo pipefail

REGION="ap-southeast-2"
ACCOUNT="007460876082"
FN_NAME="etrm-factory-trigger"
ROLE_NAME="etrm-factory-trigger-role"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME_ARN=$(aws bedrock-agentcore-control list-agent-runtimes --region "$REGION" \
  --query "agentRuntimes[?agentRuntimeName=='etrm_factory_pipeline'].agentRuntimeArn" --output text)
[ -n "$RUNTIME_ARN" ] || { echo "pipeline runtime not found"; exit 1; }

echo "== package =="
cd "${REPO_ROOT}/trigger"
npm install --no-fund --no-audit --omit=dev >/dev/null
rm -f /tmp/trigger.zip
zip -qr /tmp/trigger.zip index.mjs node_modules package.json

echo "== IAM role =="
if ! aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE_NAME" \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  echo "created role; waiting for propagation"; sleep 12
fi
aws iam put-role-policy --role-name "$ROLE_NAME" \
  --policy-name trigger-permissions \
  --policy-document "file://${REPO_ROOT}/infra/iam/trigger-policy.json"

echo "== Lambda function =="
if aws lambda get-function --function-name "$FN_NAME" --region "$REGION" >/dev/null 2>&1; then
  aws lambda update-function-code --function-name "$FN_NAME" --region "$REGION" \
    --zip-file fileb:///tmp/trigger.zip --query 'LastUpdateStatus' --output text
  aws lambda wait function-updated --function-name "$FN_NAME" --region "$REGION"
  aws lambda update-function-configuration --function-name "$FN_NAME" --region "$REGION" \
    --environment "Variables={RUNTIME_ARN=${RUNTIME_ARN}}" --query 'LastUpdateStatus' --output text
else
  aws lambda create-function --function-name "$FN_NAME" --region "$REGION" \
    --runtime nodejs22.x --handler index.handler --architectures arm64 \
    --timeout 30 --memory-size 256 \
    --role "arn:aws:iam::${ACCOUNT}:role/${ROLE_NAME}" \
    --environment "Variables={RUNTIME_ARN=${RUNTIME_ARN}}" \
    --zip-file fileb:///tmp/trigger.zip --query 'FunctionArn' --output text
fi

echo "== Function URL =="
aws lambda get-function-url-config --function-name "$FN_NAME" --region "$REGION" \
  --query 'FunctionUrl' --output text 2>/dev/null || {
  aws lambda create-function-url-config --function-name "$FN_NAME" --region "$REGION" \
    --auth-type NONE --query 'FunctionUrl' --output text
  aws lambda add-permission --function-name "$FN_NAME" --region "$REGION" \
    --statement-id url-public --action lambda:InvokeFunctionUrl \
    --principal '*' --function-url-auth-type NONE >/dev/null
}
