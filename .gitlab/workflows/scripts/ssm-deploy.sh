#!/bin/bash
# deploy job: the Jenkinsfile's two SSM stages. First every instance in the resource group pulls
# the current deploy.sh from S3 with its own instance profile, then runs it for this version -
# deploy.sh does the release-dir swap, health check and rollback on the instance itself. The
# pipeline never connects to the instances directly.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

: "${RELEASE_VERSION:?RELEASE_VERSION not set - is the workflow rule for this pipeline missing?}"

require_tools
vault_login
trap vault_revoke EXIT
vault_aws_creds "$VAULT_AWS_ROLE_DEPLOY"

ssm_run "Push deploy.sh" \
    "mkdir -p /opt/scripts" \
    "aws s3 cp s3://${DEPLOY_BUCKET}/scripts/deploy.sh /opt/scripts/deploy.sh --region ${AWS_REGION}" \
    "chmod +x /opt/scripts/deploy.sh"

ssm_run "Deploy" \
    "ARTIFACT_BUCKET=${DEPLOY_BUCKET} /opt/scripts/deploy.sh ${RELEASE_VERSION}"

echo "deployed ${RELEASE_VERSION} to resource group ${RESOURCE_GROUP_NAME}"
