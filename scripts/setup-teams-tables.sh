#!/bin/bash
# setup-teams-tables.sh — Creates DynamoDB tables and GSIs for team-based resource sharing (Issue #137)
# Uses spore-host-infra AWS profile. Safe to re-run (skips existing resources).

set -euo pipefail

AWS_PROFILE="${AWS_PROFILE:-spore-host-infra}"
AWS_REGION="${AWS_REGION:-us-east-1}"

# The spore-host:* service tags (#750). Both tables are part of the dashboard's
# team sharing; dashboard-api is the component that reads them.
# shellcheck source=scripts/lib/service-tags.sh
. "$(dirname "$0")/lib/service-tags.sh"
read -r -a SERVICE_TAGS <<<"$(spore_service_tags_list dashboard-api scripts/setup-teams-tables.sh)"

# tag_table NAME: add the service tags to an existing table (tag-resource merges).
tag_table() {
    local arn
    arn=$(aws dynamodb describe-table --table-name "$1" \
        --profile "$AWS_PROFILE" --region "$AWS_REGION" \
        --query 'Table.TableArn' --output text)
    aws dynamodb tag-resource --resource-arn "$arn" --tags "${SERVICE_TAGS[@]}" \
        --profile "$AWS_PROFILE" --region "$AWS_REGION"
}

echo "==> Setting up teams tables (profile: $AWS_PROFILE, region: $AWS_REGION)"

# Helper: check if DynamoDB table exists
table_exists() {
    aws dynamodb describe-table --table-name "$1" \
        --profile "$AWS_PROFILE" --region "$AWS_REGION" \
        --query 'Table.TableStatus' --output text 2>/dev/null | grep -q "ACTIVE"
}

# Helper: check if GSI exists on a table
gsi_exists() {
    local table="$1"
    local gsi_name="$2"
    aws dynamodb describe-table --table-name "$table" \
        --profile "$AWS_PROFILE" --region "$AWS_REGION" \
        --query "Table.GlobalSecondaryIndexes[?IndexName=='$gsi_name'].IndexName" \
        --output text 2>/dev/null | grep -q "$gsi_name"
}

# ──────────────────────────────────────────────────────────────────────────────
# 1. spawn-teams table
# ──────────────────────────────────────────────────────────────────────────────
if table_exists "spawn-teams"; then
    echo "  ✓ spawn-teams already exists"
    tag_table "spawn-teams"
else
    echo "  Creating spawn-teams..."
    aws dynamodb create-table \
        --table-name "spawn-teams" \
        --attribute-definitions \
            AttributeName=team_id,AttributeType=S \
            AttributeName=owner_arn,AttributeType=S \
        --key-schema \
            AttributeName=team_id,KeyType=HASH \
        --global-secondary-indexes '[
            {
                "IndexName": "owner_arn-index",
                "KeySchema": [{"AttributeName": "owner_arn", "KeyType": "HASH"}],
                "Projection": {"ProjectionType": "ALL"}
            }
        ]' \
        --billing-mode PAY_PER_REQUEST \
        --tags "${SERVICE_TAGS[@]}" \
        --profile "$AWS_PROFILE" --region "$AWS_REGION" \
        --output text > /dev/null
    echo "  ✓ spawn-teams created"
fi

# ──────────────────────────────────────────────────────────────────────────────
# 2. spawn-team-memberships table
# ──────────────────────────────────────────────────────────────────────────────
if table_exists "spawn-team-memberships"; then
    echo "  ✓ spawn-team-memberships already exists"
    tag_table "spawn-team-memberships"
else
    echo "  Creating spawn-team-memberships..."
    aws dynamodb create-table \
        --table-name "spawn-team-memberships" \
        --attribute-definitions \
            AttributeName=team_id,AttributeType=S \
            AttributeName=member_arn,AttributeType=S \
        --key-schema \
            AttributeName=team_id,KeyType=HASH \
            AttributeName=member_arn,KeyType=RANGE \
        --global-secondary-indexes '[
            {
                "IndexName": "member_arn-index",
                "KeySchema": [{"AttributeName": "member_arn", "KeyType": "HASH"}],
                "Projection": {"ProjectionType": "ALL"}
            }
        ]' \
        --billing-mode PAY_PER_REQUEST \
        --tags "${SERVICE_TAGS[@]}" \
        --profile "$AWS_PROFILE" --region "$AWS_REGION" \
        --output text > /dev/null
    echo "  ✓ spawn-team-memberships created"
fi

# ──────────────────────────────────────────────────────────────────────────────
# 3. Add team_id-index GSI to spawn-sweep-orchestration
# ──────────────────────────────────────────────────────────────────────────────
if gsi_exists "spawn-sweep-orchestration" "team_id-index"; then
    echo "  ✓ spawn-sweep-orchestration team_id-index already exists"
else
    echo "  Adding team_id-index to spawn-sweep-orchestration..."
    aws dynamodb update-table \
        --table-name "spawn-sweep-orchestration" \
        --attribute-definitions \
            AttributeName=team_id,AttributeType=S \
            AttributeName=created_at,AttributeType=S \
        --global-secondary-index-updates '[
            {
                "Create": {
                    "IndexName": "team_id-index",
                    "KeySchema": [
                        {"AttributeName": "team_id", "KeyType": "HASH"},
                        {"AttributeName": "created_at", "KeyType": "RANGE"}
                    ],
                    "Projection": {"ProjectionType": "ALL"}
                }
            }
        ]' \
        --profile "$AWS_PROFILE" --region "$AWS_REGION" \
        --output text > /dev/null
    echo "  ✓ spawn-sweep-orchestration team_id-index created (propagating...)"
fi

# ──────────────────────────────────────────────────────────────────────────────
# 4. Add team_id-index GSI to spawn-autoscale-groups-production
# ──────────────────────────────────────────────────────────────────────────────
if gsi_exists "spawn-autoscale-groups-production" "team_id-index"; then
    echo "  ✓ spawn-autoscale-groups-production team_id-index already exists"
else
    echo "  Adding team_id-index to spawn-autoscale-groups-production..."
    aws dynamodb update-table \
        --table-name "spawn-autoscale-groups-production" \
        --attribute-definitions \
            AttributeName=team_id,AttributeType=S \
        --global-secondary-index-updates '[
            {
                "Create": {
                    "IndexName": "team_id-index",
                    "KeySchema": [
                        {"AttributeName": "team_id", "KeyType": "HASH"}
                    ],
                    "Projection": {"ProjectionType": "ALL"}
                }
            }
        ]' \
        --profile "$AWS_PROFILE" --region "$AWS_REGION" \
        --output text > /dev/null
    echo "  ✓ spawn-autoscale-groups-production team_id-index created (propagating...)"
fi

echo ""
echo "==> Done. Tables and GSIs are ready."
echo "    Verify in AWS console: DynamoDB > Tables (account: spore-host-infra)"
