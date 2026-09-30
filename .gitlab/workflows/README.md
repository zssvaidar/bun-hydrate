# GitLab deploy pipeline

GitLab CI/CD version of the `Jenkinsfile`, and it deploys the same way. `build.sh` builds
`node-app-<version>.tar.gz`. The artifact and `deploy.sh` go to S3. Then SSM runs `deploy.sh` on
every instance in the `testing-node-app-bun` resource group. AWS credentials come from Vault, the
same `aws/creds/*` roles Jenkins uses. `build.sh`, `deploy.sh` and the `Jenkinsfile` are untouched,
so both pipelines can run side by side.

```
.gitlab/workflows/
├── deploy.yml            pipeline definition
└── scripts/
    ├── lib.sh            Vault login, AWS creds from Vault, SSM send + wait (sourced)
    ├── upload.sh         upload job: artifact + deploy.sh -> S3   (Vault role deploy-ssm-role)
    └── ssm-deploy.sh     deploy job: SSM push deploy.sh, SSM run it (Vault role jenkins)
```

## When it runs

| Trigger | Jobs | Version |
|---|---|---|
| Push a tag `vX.Y.Z` (a release) | build → upload → deploy → release | the tag, e.g. `v1.4.0` |
| **Build → Pipelines → Run pipeline** | build → upload → deploy (**manual** ▶) | `<pipeline iid>-<short sha>` |
| Push to a branch / MR | build only | `<pipeline iid>-<short sha>` |

Releasing is just tagging:

```bash
git tag v1.4.0 && git push origin v1.4.0
```

`deploy` uses `resource_group: production`, so two releases never deploy at the same time. The
`production` environment in **Operate → Environments** shows what's live, and each release tag also
gets a GitLab Release.

## One-time setup

### 1. Point the project at this file
The pipeline isn't at the default `.gitlab-ci.yml`, so point GitLab at it:
**Settings → CI/CD → General pipelines → CI/CD configuration file** = `.gitlab/workflows/deploy.yml`

### 2. A runner that can reach Vault
Vault is at a private address (`http://192.168.0.26:8200`). GitLab.com's shared runners can't
reach it, so register your own GitLab Runner inside that network and give it the tag
`bun-hydrate-deploy`. If you use a different tag, change `DEPLOY_RUNNER_TAG` in `deploy.yml`.
Use the **docker** executor, because the jobs use `oven/bun:1`, `amazon/aws-cli` and
`release-cli` images:

```bash
gitlab-runner register --url https://gitlab.com --token <runner token from Settings → CI/CD → Runners> \
  --executor docker --docker-image alpine:3
```
Add the `bun-hydrate-deploy` tag when you create the runner in the UI. The runner needs outbound
access to AWS too, since every AWS call goes from the runner.

### 3. Vault login: choose one (`VAULT_AUTH_METHOD` in `deploy.yml`)

**`approle` (default).** Uses the same AppRole as Jenkins' `vault-approle` credential. Add these
under **Settings → CI/CD → Variables**:

| Variable | Flags |
|---|---|
| `VAULT_ROLE_ID` | Masked |
| `VAULT_SECRET_ID` | Masked, **Protected** |

Protected variables only reach pipelines on protected branches and tags. So protect the release
tags (**Settings → Repository → Protected tags** → `v*`), or tag pipelines won't be able to log in.

**`jwt` (no stored secret).** The job logs in with its own short-lived GitLab ID token, so there's
no secret to store or rotate. Set it up once in Vault:

```bash
vault auth enable jwt
vault write auth/jwt/config \
    oidc_discovery_url="https://gitlab.com" bound_issuer="https://gitlab.com"

vault write auth/jwt/role/bun-hydrate-deploy - <<'EOF'
{
  "role_type": "jwt",
  "user_claim": "user_login",
  "bound_audiences": ["http://192.168.0.26:8200"],
  "bound_claims": { "project_path": "<group>/bun-hydrate", "ref_protected": "true" },
  "token_policies": ["bun-hydrate-deploy"],
  "token_ttl": "15m"
}
EOF
```

Then set `VAULT_AUTH_METHOD: jwt` in `deploy.yml`. For self-managed GitLab, use your GitLab URL
in place of `https://gitlab.com` (Vault must be able to reach it). `bound_audiences` must match
`VAULT_ADDR`, because that's the `aud` the job requests.

### 4. Vault policy
Whichever login you use, its policy needs read access to the two AWS roles:

```hcl
# vault policy write bun-hydrate-deploy bun-hydrate-deploy.hcl
path "aws/creds/deploy-ssm-role" { capabilities = ["read"] }   # upload: S3 put
path "aws/creds/jenkins"         { capabilities = ["read"] }   # deploy: ssm send-command/list-*
```

These are the same roles and permissions Jenkins uses today. To give GitLab its own roles, create
them in Vault and change `VAULT_AWS_ROLE_UPLOAD` / `VAULT_AWS_ROLE_DEPLOY`.

When each job finishes, its Vault token is revoked. That also revokes the dynamic AWS
credentials created for it, so they don't live out their TTL.

## Settings in `deploy.yml`

| Variable | Default | Same as Jenkinsfile |
|---|---|---|
| `AWS_REGION` | `ap-northeast-1` | `AWS_REGION` |
| `DEPLOY_BUCKET` | `testing-node-app-142369633239` | `DEPLOY_BUCKET` |
| `SSM_LOG_BUCKET` | `my-deploy-logs-bucket1` | `--output-s3-bucket-name` |
| `RESOURCE_GROUP_NAME` | `testing-node-app-bun` | `RESOURCE_GROUP_NAME` |
| `SSM_TIMEOUT_SECONDS` | `300` | `timeout(5 MINUTES)` |
| `VAULT_ADDR` | `http://192.168.0.26:8200` | `VAULT_ADDR` |
| `DEPLOY_RUNNER_TAG` | `bun-hydrate-deploy` | `agent any` |

## Differences from the Jenkinsfile
- **The deploy fails if the resource group matches no instances.** Jenkins would report
  success after deploying nowhere.
- **Each instance's SSM output is printed in the job log**, so you don't have to dig through the
  S3 log bucket.
- **A deploy that times out is left running rather than cancelled.** Cancelling `deploy.sh` between
  its symlink swap and its health check would skip its rollback.
- **The debug `aws ec2 describe-instances` call is gone.** It dumped every instance into the log.
