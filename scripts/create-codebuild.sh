#!/usr/bin/env bash
# One-time setup for the claude-code-executor CodeBuild project.
# Idempotent-ish: safe to re-run; create calls that hit "already exists" are reported and skipped.
set -euo pipefail

REGION="ap-southeast-2"
ACCOUNT="007460876082"
BUCKET="etrmfactory-agent-artifacts-${ACCOUNT}"
ROLE_NAME="claude-code-executor-role"
PROJECT="claude-code-executor"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "== S3 artifacts bucket =="
if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  echo "bucket $BUCKET already exists"
else
  aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
    --create-bucket-configuration LocationConstraint="$REGION"
  aws s3api put-public-access-block --bucket "$BUCKET" \
    --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  echo "created $BUCKET"
fi

echo "== IAM role =="
if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  echo "role $ROLE_NAME already exists"
else
  aws iam create-role --role-name "$ROLE_NAME" \
    --assume-role-policy-document "file://${REPO_ROOT}/infra/iam/codebuild-trust-policy.json" >/dev/null
  echo "created role $ROLE_NAME"
fi
aws iam put-role-policy --role-name "$ROLE_NAME" \
  --policy-name executor-permissions \
  --policy-document "file://${REPO_ROOT}/infra/iam/codebuild-executor-policy.json"
echo "attached inline policy"

echo "== CodeBuild project =="
BUILDSPEC_JSON=$(python3 -c "import json,sys; print(json.dumps(open(sys.argv[1]).read()))" "${REPO_ROOT}/codebuild/buildspec.yml")
cat > /tmp/codebuild-project.json <<EOF
{
  "name": "${PROJECT}",
  "description": "Runs Claude Code against the target repo with an approved plan; opens a PR.",
  "source": { "type": "NO_SOURCE", "buildspec": ${BUILDSPEC_JSON} },
  "artifacts": { "type": "NO_ARTIFACTS" },
  "environment": {
    "type": "LINUX_CONTAINER",
    "image": "aws/codebuild/standard:7.0",
    "computeType": "BUILD_GENERAL1_SMALL"
  },
  "serviceRole": "arn:aws:iam::${ACCOUNT}:role/${ROLE_NAME}",
  "timeoutInMinutes": 60,
  "logsConfig": { "cloudWatchLogs": { "status": "ENABLED" } }
}
EOF

if aws codebuild batch-get-projects --names "$PROJECT" --region "$REGION" \
     --query 'projects[0].name' --output text 2>/dev/null | grep -q "^${PROJECT}$"; then
  aws codebuild update-project --cli-input-json file:///tmp/codebuild-project.json --region "$REGION" \
    --query 'project.arn' --output text
  echo "updated project $PROJECT"
else
  aws codebuild create-project --cli-input-json file:///tmp/codebuild-project.json --region "$REGION" \
    --query 'project.arn' --output text
  echo "created project $PROJECT"
fi
