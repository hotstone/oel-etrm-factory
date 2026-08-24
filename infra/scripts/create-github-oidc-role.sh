#!/usr/bin/env bash
# CI role assumed by GitHub Actions via OIDC (repo hotstone/oel-etrm-factory).
# Re-runnable. The OIDC provider itself already exists in the account.
set -euo pipefail
ROLE_NAME="etrm-factory-github-actions"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

if ! aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE_NAME" \
    --assume-role-policy-document "file://${REPO_ROOT}/infra/iam/github-actions-trust.json" >/dev/null
  echo "created role $ROLE_NAME"; sleep 12
else
  aws iam update-assume-role-policy --role-name "$ROLE_NAME" \
    --policy-document "file://${REPO_ROOT}/infra/iam/github-actions-trust.json"
fi
aws iam put-role-policy --role-name "$ROLE_NAME" \
  --policy-name ci-permissions \
  --policy-document "file://${REPO_ROOT}/infra/iam/github-actions-policy.json"
echo "role $ROLE_NAME ready: arn:aws:iam::007460876082:role/$ROLE_NAME"
