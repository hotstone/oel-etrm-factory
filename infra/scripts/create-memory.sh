#!/usr/bin/env bash
# One-time: findings table + AgentCore Memory store for the lessons loop.
# Re-runnable: existing resources are reported and kept.
set -euo pipefail

REGION="ap-southeast-2"
MEMORY_NAME="etrm_factory_lessons"
TABLE="etrm-factory-findings"

echo "== Findings table =="
if aws dynamodb describe-table --table-name "$TABLE" --region "$REGION" >/dev/null 2>&1; then
  echo "table $TABLE exists"
else
  # PK: issue id; SK: reviewedAt#index so multiple reviews per issue coexist.
  aws dynamodb create-table --table-name "$TABLE" --region "$REGION" \
    --attribute-definitions AttributeName=issueId,AttributeType=S AttributeName=findingKey,AttributeType=S \
    --key-schema AttributeName=issueId,KeyType=HASH AttributeName=findingKey,KeyType=RANGE \
    --billing-mode PAY_PER_REQUEST --query 'TableDescription.TableStatus' --output text
  aws dynamodb wait table-exists --table-name "$TABLE" --region "$REGION"
  echo "created table $TABLE"
fi

echo "== AgentCore Memory store =="
EXISTING=$(aws bedrock-agentcore-control list-memories --region "$REGION" \
  --query "memories[?id != null] | [?starts_with(id, '${MEMORY_NAME}')].id | [0]" --output text 2>/dev/null || echo "None")
if [ -n "$EXISTING" ] && [ "$EXISTING" != "None" ]; then
  echo "memory store exists: $EXISTING"
  MEMORY_ID="$EXISTING"
else
  # Semantic strategy so records get embeddings + semantic retrieval. Records
  # are written directly by the curator (no event extraction), so eventExpiry
  # is minimal. Namespace per target repo: /lessons/{repo-slug}.
  MEMORY_ID=$(aws bedrock-agentcore-control create-memory --region "$REGION" \
    --name "$MEMORY_NAME" \
    --description "Distilled lessons from pipeline review cycles; namespace per target repo" \
    --event-expiry-duration 7 \
    --memory-strategies '[{"semanticMemoryStrategy": {"name": "lessons", "description": "Reviewer-derived lessons", "namespaces": ["/lessons/{actorId}"]}}]' \
    --query 'memory.id' --output text)
  echo "created memory store: $MEMORY_ID"
fi

STATUS=$(aws bedrock-agentcore-control get-memory --region "$REGION" --memory-id "$MEMORY_ID" --query 'memory.status' --output text)
echo "memory status: $STATUS (CREATING can take a few minutes)"
STRATEGY_ID=$(aws bedrock-agentcore-control get-memory --region "$REGION" --memory-id "$MEMORY_ID" --query 'memory.strategies[0].strategyId' --output text)
echo "MEMORY_ID=$MEMORY_ID"
echo "STRATEGY_ID=$STRATEGY_ID"
