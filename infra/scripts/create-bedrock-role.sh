#!/usr/bin/env bash
# One-time: the bedrock-only role Claude Code sessions assume. Re-runnable.
set -euo pipefail
ROLE_NAME="etrm-agent-bedrock-only"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

if ! aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE_NAME" \
    --assume-role-policy-document "file://${REPO_ROOT}/infra/iam/bedrock-only-trust.json" >/dev/null
  echo "created role $ROLE_NAME; waiting for propagation"; sleep 12
else
  aws iam update-assume-role-policy --role-name "$ROLE_NAME" \
    --policy-document "file://${REPO_ROOT}/infra/iam/bedrock-only-trust.json"
fi
aws iam put-role-policy --role-name "$ROLE_NAME" \
  --policy-name bedrock-only \
  --policy-document "file://${REPO_ROOT}/infra/iam/bedrock-only-policy.json"
echo "role $ROLE_NAME ready"
