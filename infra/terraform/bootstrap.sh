#!/usr/bin/env bash
# Run once, before the first terraform init. Creates the private bucket that
# holds Terraform's own state. Safe to run again.
set -euo pipefail

REGION="ap-south-1"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
BUCKET="eyra-terraform-state-${ACCOUNT}"

if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  echo "State bucket $BUCKET already exists."
else
  aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
    --create-bucket-configuration "LocationConstraint=${REGION}" >/dev/null
  echo "Created $BUCKET"
fi

aws s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
aws s3api put-bucket-versioning --bucket "$BUCKET" --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket "$BUCKET" \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

echo "State bucket ready: $BUCKET"
