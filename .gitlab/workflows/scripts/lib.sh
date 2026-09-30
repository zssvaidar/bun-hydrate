#!/bin/bash
# Shared helpers for the GitLab deploy jobs - sourced, not run. Vault login, AWS credentials from
# Vault's AWS secrets engine (the same thing the Jenkinsfile's withVault blocks do), and an SSM
# send-command + wait that fails the job if any instance didn't succeed (the Jenkinsfile's
# waitForSsmCommand).

# The jobs run in amazon/aws-cli (Amazon Linux 2), which has aws and curl but not jq.
require_tools() {
    command -v jq >/dev/null 2>&1 || yum install -y -q jq >/dev/null
    command -v curl >/dev/null 2>&1 || yum install -y -q curl >/dev/null
    command -v aws >/dev/null 2>&1 || { echo "error: aws cli not found in this image" >&2; exit 1; }
}

# vault_request METHOD PATH [JSON_BODY] - prints the response body, fails on a non-2xx status.
# Errors print Vault's error list only, never the response body of a successful secret read.
vault_request() {
    local method="$1" path="$2" data="${3:-}" out code body
    local args=(-sS -X "$method" -w '\n%{http_code}')
    [[ -n "${VAULT_TOKEN:-}" ]] && args+=(-H "X-Vault-Token: $VAULT_TOKEN")
    [[ -n "$data" ]] && args+=(--data "$data")

    out=$(curl "${args[@]}" "${VAULT_ADDR%/}/v1/${path}") || { echo "error: could not reach Vault at $VAULT_ADDR" >&2; return 1; }
    code="${out##*$'\n'}"
    body="${out%$'\n'*}"
    if [[ "$code" != 2* ]]; then
        echo "error: Vault $method $path -> HTTP $code: $(jq -c '.errors // empty' <<< "$body" 2>/dev/null)" >&2
        return 1
    fi
    printf '%s' "$body"
}

# Logs in and exports VAULT_TOKEN. VAULT_AUTH_METHOD picks how:
#   approle - VAULT_ROLE_ID + VAULT_SECRET_ID (masked CI/CD variables), like Jenkins' vault-approle
#   jwt     - the job's GitLab ID token (VAULT_ID_TOKEN, from id_tokens in deploy.yml)
vault_login() {
    local payload path resp
    case "${VAULT_AUTH_METHOD:-approle}" in
        approle)
            : "${VAULT_ROLE_ID:?set VAULT_ROLE_ID as a masked CI/CD variable}"
            : "${VAULT_SECRET_ID:?set VAULT_SECRET_ID as a masked, protected CI/CD variable}"
            payload=$(jq -nc --arg r "$VAULT_ROLE_ID" --arg s "$VAULT_SECRET_ID" '{role_id: $r, secret_id: $s}')
            path="auth/${VAULT_APPROLE_MOUNT:-approle}/login"
            ;;
        jwt)
            : "${VAULT_ID_TOKEN:?no VAULT_ID_TOKEN - is id_tokens set on this job?}"
            payload=$(jq -nc --arg r "$VAULT_JWT_ROLE" --arg j "$VAULT_ID_TOKEN" '{role: $r, jwt: $j}')
            path="auth/${VAULT_JWT_MOUNT:-jwt}/login"
            ;;
        *)
            echo "error: VAULT_AUTH_METHOD must be approle or jwt, got '$VAULT_AUTH_METHOD'" >&2
            return 1
            ;;
    esac

    resp=$(VAULT_TOKEN="" vault_request POST "$path" "$payload") || return 1
    VAULT_TOKEN=$(jq -r '.auth.client_token' <<< "$resp")
    [[ -n "$VAULT_TOKEN" && "$VAULT_TOKEN" != "null" ]] || { echo "error: Vault login returned no token" >&2; return 1; }
    export VAULT_TOKEN
    echo "logged in to Vault via $VAULT_AUTH_METHOD"
}

# Revoking the job's token also revokes the leases it created, so dynamic AWS credentials die
# with the job instead of living out their TTL. Best effort - never fails the job.
vault_revoke() {
    [[ -n "${VAULT_TOKEN:-}" ]] || return 0
    vault_request POST auth/token/revoke-self >/dev/null 2>&1 || true
    unset VAULT_TOKEN
}

# vault_aws_creds ROLE - reads <VAULT_AWS_MOUNT>/creds/ROLE and exports AWS_ACCESS_KEY_ID,
# AWS_SECRET_ACCESS_KEY and AWS_SESSION_TOKEN (access_key / secret_key / security_token).
vault_aws_creds() {
    local role="$1" resp
    resp=$(vault_request GET "${VAULT_AWS_MOUNT:-aws}/creds/${role}") || return 1

    AWS_ACCESS_KEY_ID=$(jq -r '.data.access_key' <<< "$resp")
    AWS_SECRET_ACCESS_KEY=$(jq -r '.data.secret_key' <<< "$resp")
    AWS_SESSION_TOKEN=$(jq -r '.data.security_token // empty' <<< "$resp")
    export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
    # iam_user roles have no session token - an empty one would make every AWS call fail
    if [[ -n "$AWS_SESSION_TOKEN" ]]; then export AWS_SESSION_TOKEN; else unset AWS_SESSION_TOKEN; fi

    # freshly created IAM users take a few seconds to become usable - wait instead of failing
    # the first real call
    local i
    for i in $(seq 1 10); do
        if aws sts get-caller-identity --query Arn --output text 2>/dev/null; then
            echo "using AWS credentials from Vault role '$role'"
            return 0
        fi
        sleep 3
    done
    echo "error: AWS credentials from Vault role '$role' were never accepted by AWS" >&2
    return 1
}

# ssm_run LABEL COMMAND... - runs the commands on every instance in RESOURCE_GROUP_NAME, waits,
# prints each instance's output, and fails if the command matched no instances or didn't
# succeed everywhere. Full output is also in s3://$SSM_LOG_BUCKET.
ssm_run() {
    local label="$1"; shift
    local params cmd_id status target_count
    params=$(printf '%s\n' "$@" | jq -R . | jq -sc '{commands: .}')

    cmd_id=$(aws ssm send-command \
        --region "$AWS_REGION" \
        --document-name "AWS-RunShellScript" \
        --targets "Key=resource-groups:Name,Values=${RESOURCE_GROUP_NAME}" \
        --parameters "$params" \
        --comment "$(printf '%s %s (pipeline %s)' "$label" "$RELEASE_VERSION" "${CI_PIPELINE_ID:-local}" | cut -c1-100)" \
        --output-s3-bucket-name "$SSM_LOG_BUCKET" \
        --query 'Command.CommandId' --output text)
    echo "$label: SSM command $cmd_id"

    # Not cancelled on timeout: killing deploy.sh between the symlink swap and its health check
    # would skip its rollback - better to leave it running and fail the job.
    local deadline=$((SECONDS + ${SSM_TIMEOUT_SECONDS:-300}))
    while :; do
        read -r status target_count < <(aws ssm list-commands --region "$AWS_REGION" \
            --command-id "$cmd_id" --query 'Commands[0].[Status,TargetCount]' --output text)
        case "$status" in
            Pending|InProgress|Cancelling) ;;
            *) break ;;
        esac
        if (( SECONDS >= deadline )); then
            echo "error: $label still $status after ${SSM_TIMEOUT_SECONDS:-300}s (command $cmd_id left running)" >&2
            return 1
        fi
        sleep 5
    done

    aws ssm list-command-invocations --region "$AWS_REGION" --command-id "$cmd_id" --details --output json \
        | jq -r '.CommandInvocations[] | "--- \(.InstanceId): \(.Status)\n\(.CommandPlugins[0].Output // "")"'

    if [[ "$target_count" == "0" ]]; then
        echo "error: $label matched no instances in resource group '$RESOURCE_GROUP_NAME'" >&2
        return 1
    fi

    local failed
    failed=$(aws ssm list-command-invocations --region "$AWS_REGION" --command-id "$cmd_id" \
        --query "CommandInvocations[?Status!='Success'].InstanceId" --output text)
    if [[ "$status" != "Success" || -n "$failed" ]]; then
        echo "error: $label ended $status - failed on: ${failed:-see s3://$SSM_LOG_BUCKET}" >&2
        return 1
    fi
    echo "$label: succeeded on $target_count instance(s)"
}
