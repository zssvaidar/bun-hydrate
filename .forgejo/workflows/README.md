# Forgejo Actions deploy pipeline

This is the Forgejo version of the `Jenkinsfile`, and it deploys the same way:

1. `build.sh` builds `node-app-<version>.tar.gz`.
2. The artifact and `deploy.sh` go to S3.
3. SSM runs `deploy.sh` on every instance in the `testing-node-app-bun` resource group.

AWS credentials come from Vault, using the same `aws/creds/*` roles Jenkins uses. `build.sh`,
`deploy.sh` and the `Jenkinsfile` are untouched.

```
.forgejo/workflows/
├── deploy.yml            workflow (GitHub Actions syntax)
└── scripts/
    ├── lib.sh            Vault login, AWS creds from Vault, SSM send + wait (sourced)
    ├── upload.sh         artifact + deploy.sh -> S3   (Vault role deploy-ssm-role)
    └── ssm-deploy.sh     SSM push deploy.sh, SSM run it (Vault role jenkins)
```

## When it runs

| Trigger | What happens | Version |
|---|---|---|
| Push a tag `vX.Y.Z` | build → upload → deploy | the tag, e.g. `v1.4.0` |
| **Actions → deploy → Run workflow** | build → upload → deploy | `<run number>-<short sha>` |
| Push to a branch | build only | `<run number>-<short sha>` |

To release, push a tag:

```bash
git tag v1.4.0 && git push forgejo v1.4.0
```

## Setup
1. **Forgejo and a runner.** `cd-stack-gen/project-8/forgejo` sets up both. Its default
   `RUNNER_LABELS` already includes `bun-hydrate-deploy:docker://node:20-bookworm`, which is what
   `runs-on: bun-hydrate-deploy` here needs. The runner must be inside the network that can reach
   Vault (`192.168.0.26`).
2. **Push this repo to Forgejo.** Actions don't run on pull mirrors, so push to Forgejo rather than
   mirroring from GitHub.
3. **Repo secrets.** Add these under **Settings → Actions → Secrets**. They're the same AppRole
   Jenkins uses as `vault-approle`.

   | Secret | Value |
   |---|---|
   | `VAULT_ROLE_ID` | AppRole role_id |
   | `VAULT_SECRET_ID` | AppRole secret_id |

4. **Vault policy.** The AppRole's policy needs read on the two AWS roles:
   ```hcl
   path "aws/creds/deploy-ssm-role" { capabilities = ["read"] }   # upload: S3 put
   path "aws/creds/jenkins"         { capabilities = ["read"] }   # deploy: ssm send-command/list-*
   ```

Each job revokes its Vault token when it finishes, which also revokes the dynamic AWS
credentials created for it.

## Design notes
- **Upload is a step in the build job, not its own job.** S3 is already the hand-off to the
  instances, so there's no Actions artifact to pass between jobs.
- **Tools are installed per job.** The job image is `node:20-bookworm` (JavaScript actions like
  `actions/checkout` need node). `lib.sh` installs `awscli` and `jq` with apt, and the build
  installs Bun with `npm install -g bun`.
- **No manual approval step.** Forgejo has no "wait for a click" job, so running the workflow
  from the Actions tab is itself the manual trigger. The runner's capacity of 1 also
  means two deploys never run at the same time.
- **Vault login is AppRole only for now.** `lib.sh` still supports `VAULT_AUTH_METHOD=jwt`.
  Forgejo 15 added OIDC ID tokens for Actions, so AppRole can be swapped for a Vault JWT role
  bound to this repo once that's configured on the Forgejo side.
