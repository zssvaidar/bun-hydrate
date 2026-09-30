#!/bin/bash
# upload step (build job): puts the build artifact and deploy.sh in S3 for the instances to pull - the
# Jenkinsfile's "Upload Artifact" stage, with credentials from the same Vault role.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

: "${RELEASE_VERSION:?RELEASE_VERSION not set - set by the workflow}"
ARTIFACT_NAME="${ARTIFACT_NAME:-node-app-${RELEASE_VERSION}.tar.gz}"
[[ -f "$ARTIFACT_NAME" ]] || { echo "error: $ARTIFACT_NAME not found - did build.sh run in this job?" >&2; exit 1; }

require_tools
vault_login
trap vault_revoke EXIT
vault_aws_creds "$VAULT_AWS_ROLE_UPLOAD"

aws s3 cp "$ARTIFACT_NAME" "s3://${DEPLOY_BUCKET}/${ARTIFACT_NAME}" --region "$AWS_REGION"
aws s3 cp deploy.sh "s3://${DEPLOY_BUCKET}/scripts/deploy.sh" --region "$AWS_REGION"

echo "uploaded $ARTIFACT_NAME and deploy.sh to s3://${DEPLOY_BUCKET}"
