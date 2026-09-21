#!/bin/bash
# EC2 user-data: installs cloudflared and starts the tunnel pointing app.northest.stream ->
# localhost:8080. Targets Amazon Linux 2023 (dnf), falls back to Amazon Linux 2 (yum) - same
# convention as project-9/ec2-deploy/bootstrap/cloud-init-docker.sh in cd-stack-gen.
#
# Requires the instance's IAM role to have ssm:GetParameter on
# /cloudflare/bun-hydrate/tunnel-token (see the `aws iam put-role-policy` from setup).
set -e

AWS_REGION="ap-northeast-1"
CLOUDFLARE_TOKEN_PARAM="/cloudflare/bun-hydrate/tunnel-token"

curl -fsSL https://pkg.cloudflare.com/cloudflared.repo | tee /etc/yum.repos.d/cloudflared.repo

if command -v dnf >/dev/null 2>&1; then
    dnf install -y cloudflared
else
    yum install -y cloudflared
fi

TUNNEL_TOKEN=$(aws ssm get-parameter \
    --name "${CLOUDFLARE_TOKEN_PARAM}" \
    --with-decryption \
    --region "${AWS_REGION}" \
    --query 'Parameter.Value' --output text)

cloudflared service install "${TUNNEL_TOKEN}"
systemctl enable --now cloudflared
