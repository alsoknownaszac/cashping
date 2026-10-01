#!/usr/bin/env bash
# Scratch runner for the Step 27/28 Testnet e2e (deleted before the final commit).
set -uo pipefail

export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=eu-west-1

KEY=$(aws --endpoint-url http://localhost:5055 kms create-key --description cashping-seeds --query KeyMetadata.Arn --output text)
echo "created key: $KEY"

set -a
. ./.env
set +a

export RUN_STELLAR_IT=1
export AWS_ENDPOINT_URL=http://localhost:5055
export AWS_KMS_KEY_ID="$KEY"
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test

npx vitest run --config ./vitest.config.e2e.ts test/submission.e2e-spec.ts
echo "VITEST_EXIT=$?"
