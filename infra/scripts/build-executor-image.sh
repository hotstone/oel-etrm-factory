#!/usr/bin/env bash
# Build and push the custom CodeBuild executor image (linux/arm64).
# Re-run to pick up new Claude Code releases, then rerun create-codebuild.sh
# is NOT needed (the project references :latest).
set -euo pipefail

REGION="ap-southeast-2"
ACCOUNT="007460876082"
ECR_REPO="etrm-factory-codebuild"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE_URI="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/${ECR_REPO}"
TAG="$(date +%Y%m%d-%H%M%S)"

aws ecr describe-repositories --repository-names "$ECR_REPO" --region "$REGION" >/dev/null 2>&1 \
  || aws ecr create-repository --repository-name "$ECR_REPO" --region "$REGION" \
       --query 'repository.repositoryUri' --output text

aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"
docker build --platform linux/arm64 -t "${IMAGE_URI}:${TAG}" -t "${IMAGE_URI}:latest" "${REPO_ROOT}/infra/codebuild/executor-image"
docker push "${IMAGE_URI}:${TAG}"
docker push "${IMAGE_URI}:latest"
echo "pushed ${IMAGE_URI}:${TAG} (+latest)"
