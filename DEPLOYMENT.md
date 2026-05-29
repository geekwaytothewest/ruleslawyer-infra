# Deploying an environment from scratch

How to stand up a brand-new, fully CDK-managed environment (`nonprod` or `prod`)
in an AWS account that has **no existing deployment**. Everything is created
fresh — there is no `cdk import`.

> Migrating the existing hand-built prod onto CDK instead? See
> [CUTOVER.md](CUTOVER.md) — it's this guide plus the DB migration and DNS
> cutover from the live environment.

Throughout, replace `<env>` with `nonprod` or `prod`.

## Prerequisites

- Node.js 20+ and AWS CDK v2 (`npm install -g aws-cdk`).
- Docker (to build the app images).
- AWS credentials for the target account with permission to deploy.
- DNS access at your provider (e.g. Squarespace) — DNS is **not** in AWS, so you
  add records by hand.
- An Auth0 tenant for this environment, plus a Machine-to-Machine app authorized
  for the Management API and the Auth0 Deploy CLI (`npm i -g auth0-deploy-cli`).
  The tenant is config-as-code in [`auth0/`](auth0/) — see its
  [README](auth0/README.md).

## 1. Configure the environment

In `lib/config.ts`, fill in the `<env>` block:

- `account` — the 12-digit account ID (replace the `TODO_*_ACCOUNT_ID` placeholder).
- `domainName` — the public hostname for this env (e.g. `library.geekway.com`).
- `secrets: {}` — leave empty so CDK **creates** the secrets for you to populate
  later. (An ARN here would instead *import* an existing secret.)
- `dbPubliclyAccessible` — `true` puts the RDS in public subnets with a public
  endpoint (gated by `dbAllowedCidrs`); `false` keeps it private/isolated,
  reachable only from the ECS tasks. This is a **create-time** choice — flipping
  it later changes the subnet group and forces an RDS replacement.
- `dbAllowedCidrs` — IP/CIDRs allowed direct Postgres access when the DB is
  public. Editing this list later is a safe SG-only change (no replacement).
- `githubOidcProviderExists` — `false`, unless the account already has a GitHub
  Actions OIDC provider (`aws iam list-open-id-connect-providers`); then `true`.
- `githubRepos` — the repos allowed to deploy via the OIDC role.

## 2. Install and bootstrap

```bash
npm install
cdk bootstrap aws://<account-id>/us-east-1
```

## 3. Deploy network + data

```bash
cdk deploy geekway-<env>-network geekway-<env>-data --context env=<env>
```

- **The ACM cert blocks the deploy until you validate it.** Get the validation
  CNAME from the ACM console (or `aws acm describe-certificate`) and add it at your
  DNS provider. Once ACM sees it, the deploy continues. **Leave that CNAME in
  place permanently** — ACM re-checks it on auto-renewal. (The same cert is used
  by CloudFront, which is created in this stack too.)
- This creates the VPC, ALB, cert, the S3 SPA bucket + CloudFront distribution,
  the RDS (which generates its own master credentials secret), and the
  placeholder secret `geekway-<env>-db-credentials`. No services yet, so nothing
  waits on container images.

## 4. Deploy services + seed images

The services reference the `:latest` image, which doesn't exist yet — and a
Fargate service can't reach steady state without an image, so you **must** get an
image into ECR during this step or the deploy will hang and roll back.

```bash
cdk deploy geekway-<env>-services --context env=<env>
```

This creates the ECR repos and the services. **While the deploy is still waiting
for the services to stabilize, push `:latest` to each repo** — run the app
pipelines against this account (see step 8) or build/push manually. Once the
images are present the tasks start, the services stabilize, and the deploy
completes.

> Deterministic alternative: temporarily set the services' `desiredCount` to 0 for
> this first deploy so it completes immediately, push images, then restore to 1 and
> redeploy. The backend has no `desiredCount` (it's CPU-autoscaled, min capacity 1),
> so for it either push its image first or temporarily set `autoScaling.minCapacity:
> 0`; the frontend uses `desiredCount`. The ECR repos use `removalPolicy:
> RETAIN`, so a failed/rolled-back deploy orphans them — delete or import them
> before retrying.

## 5. Provision the Auth0 tenant

Auth0 is deployed separately from CDK, with the Auth0 Deploy CLI against the
config in [`auth0/`](auth0/). It creates the API (audience), the post-login
Action that injects the `user_email` / `user_name` claims the backend requires,
and the five application clients (Next.js frontend, Swagger, three SPAs). Full
background is in
[`ruleslawyer-backend/Documentation/AUTH0_TENANT_SETUP.md`](../ruleslawyer-backend/Documentation/AUTH0_TENANT_SETUP.md).

```bash
cd auth0
# Point config.json's keyword mappings at this env's hosts: the public
# domainName / CloudFront URL (callbacks, origins) and the API audience.
export AUTH0_DOMAIN=<tenant>.us.auth0.com
export AUTH0_CLIENT_ID=<m2m client id>
export AUTH0_CLIENT_SECRET=<m2m client secret>
a0deploy import -c config.json -i tenant.yaml
```

- The callback/origin/logout URLs must match the env's public hostname (the
  CloudFront URL from step 3) — the same ones CDK routes. `tenant.yaml` already
  includes the local Docker dev URLs for `docker compose up`.
- The API identifier and issuer must match the backend task-def env
  (`AUTH0_AUDIENCE`, `AUTH0_ISSUER_URL` in `lib/config.ts` / `services-stack.ts`).
- After import, note the values the next steps need: the **ruleslawyer-frontend**
  client secret (→ step 6) and each **SPA** client ID (→ frontends CI).

## 6. Populate the created secrets

They came up empty/placeholder:

- `ruleslawyer-frontend-<env>-secrets` — `AUTH_SECRET` was generated; set
  `AUTH0_CLIENT_SECRET` from the `ruleslawyer-frontend` client created in step 5.
- `geekway-<env>-db-credentials` — set `POSTGRES_HOST` and `DATABASE_URL` to point
  at the new RDS endpoint, using the RDS-generated master credentials (Prisma
  reads `DATABASE_URL`).
- Add a BoardGameGeek secret + the `boardgamegeek` ARN in `config.ts` if the
  backend needs BGG (otherwise it runs without it).

The SPAs' Auth0 client IDs are not secrets — each is baked in at build time by
the frontends CI (`AUTH_CLIENT_ID` build arg), using the per-SPA client IDs from
step 5.

Restart the services so they pick up the populated secrets:

```bash
aws ecs update-service --cluster geekway-<env> --service <name> --force-new-deployment
```

## 7. Point DNS at CloudFront

Take the CloudFront domain from the network stack output
(`DistributionDomainName`) and add a CNAME at your DNS provider:

```
<domainName>   CNAME   <distribution-id>.cloudfront.net
```

`domainName` is a subdomain, so a plain CNAME works (no ALIAS/ANAME needed).
CloudFront is the front door; it serves the SPA prefixes from S3 and forwards
`/api*` and `/ruleslawyer*` to the ALB (which stays internet-facing as the
origin).

## 8. Wire up CI/CD

### App releases

The backend and Next.js frontend deploy by: build → push `:sha` + `:latest` →
`aws ecs update-service --force-new-deployment`. The three SPAs deploy instead
by: build the static bundle → `aws s3 sync` to the bucket prefix
(`/admin`, `/librarian`, `/playandwin`) → `aws cloudfront create-invalidation`
(the deploy role already grants those S3/CloudFront actions). Both need
credentials for this account:

- Set the GitHub Actions secrets the workflows use (`ACCESS_KEY_ID` /
  `SECRET_ACCESS_KEY` + the role ARN), **or**
- Switch to the OIDC role this stack creates (`geekway-<env>-github-deploy`) and
  add `permissions: id-token: write` to the jobs.

### Infra (`cdk deploy`) via GitHub Actions

This repo ships `.github/workflows/cdk.yml`: it runs `cdk diff` on PRs and, on
merge to `main`, deploys nonprod and prod as independent parallel jobs — nonprod
automatically, prod behind a manual-approval gate. Auth is GitHub OIDC — no static keys. The services stack creates a dedicated
role per env, `geekway-<env>-github-infra-deploy` (output
`GithubInfraDeployRoleArn`), which can **only** assume the CDK bootstrap roles;
CloudFormation applies the changes via the bootstrap cfn-exec role, so the
privileged permissions never live on the GitHub-assumable role.

The first bootstrap + deploy of each account is manual (steps 2–4 above) — the
role the workflow assumes doesn't exist until then. Once an env is up, enable CI:

1. **Repo variables** (Settings → Secrets and variables → Actions → Variables):
   `NONPROD_DEPLOY_ROLE_ARN` and `PROD_DEPLOY_ROLE_ARN`, each set to that
   account's `GithubInfraDeployRoleArn` output.
2. **Environments** (Settings → Environments): create `nonprod` and `prod`; add
   **required reviewers** to `prod` — that approval is the deploy gate (CI uses
   `--require-approval never`, which only disables CDK's own interactive prompt).
3. **Branch protection** on `main`: require a PR review. The PR `diff` job assumes
   the deploy role, so the review gate is what stops a PR from rewriting the
   workflow to deploy. (The workflow already blocks fork PRs.)

## 9. Verify

```bash
aws ecs describe-services --cluster geekway-<env> \
  --services ruleslawyer-backend ruleslawyer-frontend \
  --query 'services[].{name:serviceName,running:runningCount,desired:desiredCount,state:deployments[0].rolloutState}'
```

Then smoke-test the endpoints under your domain (all via CloudFront): `/api`,
`/admin`, `/librarian`, `/playandwin`, `/ruleslawyer`.

## After: day-to-day

- Releases: build → push `:sha` + `:latest` → `update-service --force-new-deployment`
  (the pipelines do this).
- Env var / secret / sizing changes are **infra changes**: edit `config.ts`,
  `cdk deploy`, then redeploy the app.
- The backend is CPU-autoscaled (target-tracking @ 50%, min/max from
  `backend.autoScaling`). To pre-warm for the convention, raise `minCapacity` in
  `config.ts` and `cdk deploy`, then lower it afterward.
