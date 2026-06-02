# Deploying an environment from scratch

How to stand up a brand-new, fully CDK-managed environment (`nonprod` or `prod`)
in an AWS account that has **no existing deployment**. Everything is created
fresh — there is no `cdk import`.

Throughout, replace `<env>` with `nonprod` or `prod`.

## Prerequisites

- Node.js 22+ (CI runs Node 22) and AWS CDK v2 — pinned as a devDependency, so run it with
  `npx cdk` after `npm install` (or `npm install -g aws-cdk`); see the README's
  Requirements.
- Docker (to build the app images).
- AWS CLI **v2** (`aws`) — for credentials and the `aws ecs`/`aws sts` commands.
  Check with `aws --version` (must report `aws-cli/2.x`); on Arch:
  `sudo pacman -S aws-cli-v2`. The v1 `aws-cli` package conflicts and lacks `aws
  configure sso`, so replace it if present:
  `sudo pacman -R aws-cli && sudo pacman -S aws-cli-v2`.
- AWS credentials for the target account with permission to deploy — see step 2.
- DNS access at your provider (e.g. Squarespace) — DNS is **not** in AWS, so you
  add records by hand.
- An Auth0 tenant for this environment, plus a Machine-to-Machine app authorized
  for the Management API and the Auth0 Deploy CLI (`npm i -g auth0-deploy-cli`).
  The tenant is config-as-code in [`auth0/`](auth0/) — see its
  [README](auth0/README.md).

## 1. Configure the environment

In `lib/config.ts`, fill in the `<env>` block:

- `account` — the 12-digit account ID (replace the `TODO_*_ACCOUNT_ID` placeholder).
- `domainName` — the public hostname for this env (e.g. `library.ruleslawyer.com`).
- `secrets: {}` — leave empty so CDK **creates** the secrets for you to populate
  later. (An ARN here would instead *import* an existing secret.)
- `dbPubliclyAccessible` — `true` puts the RDS in public subnets with a public
  endpoint (gated by `dbAllowedCidrs`); `false` keeps it private/isolated,
  reachable only from the ECS tasks. This is a **create-time** choice — flipping
  it later changes the subnet group and forces an RDS replacement.
- `dbAllowedCidrs` — IPs/CIDRs allowed direct Postgres (5432) access when the DB
  is public. A list where each entry is either a bare **IPv4 CIDR string** or
  `{ cidr, description }` (the description becomes the SG rule's label so you can
  tell whose IP is whose):
  ```ts
  dbAllowedCidrs: [
    '203.0.113.4/32',
    { cidr: '198.51.100.0/24', description: 'office' },
  ],
  ```
  A single host still needs the `/32` suffix, and IPv6 is not supported (each
  entry becomes an `ec2.Peer.ipv4` SG rule). `[]` means no external access (only
  the ECS tasks reach the DB). To find your own public IP for an entry:
  `curl -s https://checkip.amazonaws.com` → append `/32`. Editing this list later
  is a safe SG-only change (no replacement); it has effect only when
  `dbPubliclyAccessible` is `true`.
- `githubOidcProviderExists` — `false`, unless the account already has a GitHub
  Actions OIDC provider (`aws iam list-open-id-connect-providers`); then `true`.
- `githubRepos` — the repos allowed to deploy via the OIDC role.

## 2. Install and bootstrap

`npm install` puts the pinned CDK CLI in `node_modules`; run it with `npx cdk`
(or install globally — see the README's Requirements). The `cdk …` commands below
all assume that; a `cdk: command not found` means the CLI isn't on your PATH.

**Credentials for the target account.** Set up a CLI profile/credentials that
resolve to the account you're deploying into, then point your shell at it:

```bash
export AWS_PROFILE=<your-profile>
aws sts get-caller-identity   # Account must equal <account-id> from config.ts
```

How you get those credentials depends on the account:

- A **new AWS Organizations sub-account** has no IAM users — assume the admin role
  you named when creating it (the default is `OrganizationAccountAccessRole`; prod
  uses `RulesLawyersAccessRole`) *from* your management account. That's a
  `role_arn` + `source_profile` profile, where `source_profile` is a profile
  holding real management-account credentials (`aws configure --profile
  management`). Or, with IAM Identity Center (AWS SSO), `aws configure sso`.
  Define these profiles in `.aws/config` (gitignored).
- A **standalone account** — an IAM user/role with admin (or deploy) permissions,
  set up via `aws configure` (access key) or `aws configure sso`.

Always confirm `get-caller-identity` shows the **right account** before
bootstrapping — bootstrapping or deploying into the wrong account is the easy
mistake here.

```bash
npm install
npx cdk bootstrap aws://<account-id>/us-east-1 --context env=<env>
```

`--context env=<env>` matters even though the target account/region is given
explicitly: CDK still synthesizes the app to bootstrap, and `env` defaults to
`nonprod` (see `bin/ruleslawyer-infra.ts`). Bootstrapping the prod account without
`--context env=prod` synthesizes against the nonprod config — whose `account` is
still the `TODO_NONPROD_ACCOUNT_ID` placeholder — so pass the env that matches the
account you confirmed above.

## 3. Deploy network + data

```bash
npx cdk deploy ruleslawyer-<env>-network ruleslawyer-<env>-data --context env=<env>
```

- **The ACM cert blocks the deploy until you validate it.** Get the validation
  CNAME from the ACM console (or `aws acm describe-certificate`) and add it at your
  DNS provider. Once ACM sees it, the deploy continues. **Leave that CNAME in
  place permanently** — ACM re-checks it on auto-renewal. (The same cert is used
  by CloudFront, which is created in this stack too.)
- This creates the VPC, ALB, cert, the S3 SPA bucket + CloudFront distribution,
  the RDS (which generates its own master credentials secret), and the
  placeholder secret `ruleslawyer-<env>-db-credentials`. No services yet, so nothing
  waits on container images.

## 4. Deploy services + seed images

The services reference the `:latest` image, which doesn't exist yet — and a
Fargate service can't reach steady state without an image, so you **must** get an
image into ECR during this step or the deploy will hang and roll back.

```bash
npx cdk deploy ruleslawyer-<env>-services --context env=<env>
```

This creates the ECR repos and the services. **While the deploy is still waiting
for the services to stabilize, push `:latest` to each repo** — run the app
pipelines against this account (see step 8) or build/push manually. Once the
images are present the tasks start, the services stabilize, and the deploy
completes.

> Deterministic alternative: **both** services are CPU-autoscaled (min capacity 1),
> so neither pins a fixed `desiredCount` — CDK omits it whenever `autoScaling` is set
> (it is, for backend and frontend, in both envs). To make this first deploy complete
> without images, either push the images during the stabilize wait, or temporarily set
> `autoScaling.minCapacity: 0` on both services in `config.ts`, deploy, push the
> images, then restore `minCapacity` to 1 and redeploy. The ECR repos use
> `removalPolicy: RETAIN`, so a failed/rolled-back deploy orphans them — delete or
> import them before retrying.

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
  CloudFront URL from step 3) — the same ones CDK routes. These come from
  `auth0/config.json`'s `AUTH0_KEYWORD_REPLACE_MAPPINGS` (`APP_BASE_URL`,
  `SPA_BASE_URL`, `API_HOST`), which fill the `##…##` placeholders in `tenant.yaml`.
  `tenant.yaml` already includes the local Docker dev URLs for `docker compose up`.
- The API identifier (audience) and issuer are **hardcoded in
  `lib/services-stack.ts`** (not `config.ts`): the backend task-def sets
  `AUTH0_AUDIENCE=https://library.ruleslawyer.com` and
  `AUTH0_ISSUER_URL=https://ruleslawyer.auth0.com/`, and the frontend task-def sets
  `AUTH0_DOMAIN=ruleslawyer.auth0.com`. So set `auth0/config.json`'s `API_AUDIENCE`
  mapping to `https://library.ruleslawyer.com` (it becomes the resource-server
  `identifier`), and point the tenant at the `ruleslawyer.auth0.com` tenant — otherwise
  token validation fails. `tenant.yaml` defines **five** clients (Next.js frontend,
  Swagger, and the three SPAs `board-game-admin` / `librarian` / `play-prize-entry`)
  plus the `Add User Claims` post-login Action.
- After import, note the values the next steps need: the **ruleslawyer-frontend**
  client secret (→ step 6) and each **SPA** client ID (→ frontends CI).

## 6. Populate the created secrets

CDK created three secrets with placeholder/generated values to fill in now:

- `ruleslawyer-frontend-<env>-secrets` — the `AUTH_SECRET` key was generated; set
  the empty `AUTH0_CLIENT_SECRET` key from the `ruleslawyer-frontend` client created
  in step 5. (The backend container reads these as the `AUTH0_SECRET` and
  `AUTH0_CLIENT_SECRET` env vars.)
- `ruleslawyer-<env>-db-credentials` — the template ships with `POSTGRES_USER` already
  set to `ruleslawyer` and an auto-generated `POSTGRES_PASSWORD`, but **that generated
  password is not the database's password** — the RDS instance generated its own
  master-credentials secret (`rds.Credentials.fromGeneratedSecret('ruleslawyer')`). Copy
  the real values across: set `POSTGRES_HOST` to the new RDS endpoint (the
  `DbEndpoint` output / `aws rds describe-db-instances`), overwrite `POSTGRES_PASSWORD`
  with the RDS master password, and set `DATABASE_URL` to the full Prisma Postgres
  connection string (Prisma reads `DATABASE_URL`, provider `postgresql`):

  ```
  postgresql://ruleslawyer:<password>@<rds-endpoint>:5432/ruleslawyer?schema=public
  ```

  where user and database name are both `ruleslawyer` (set in `data-stack.ts`), the port
  is 5432, `<rds-endpoint>` is the same host you put in `POSTGRES_HOST`, and
  `<password>` is the RDS master password (URL-encode any special characters in it).
  The backend reads all four keys
  (`POSTGRES_HOST`/`POSTGRES_USER`/`POSTGRES_PASSWORD`/`DATABASE_URL`).
- `ruleslawyer-bgg-<env>-secret` — CDK always creates this with a placeholder
  `API_TOKEN` and wires it into the backend as `BOARDGAMEGEEK_API_TOKEN`. Set the
  real BoardGameGeek `API_TOKEN` value if the backend needs BGG (it's no longer an
  optional `config.ts` ARN; the secret and env var always exist).

The SPAs' Auth0 client IDs are not secrets — each is baked in at build time by
the frontends CI (`AUTH_CLIENT_ID` build arg), using the per-SPA client IDs from
step 5.

Restart the services so they pick up the populated secrets:

```bash
aws ecs update-service --cluster ruleslawyer-<env> --service <name> --force-new-deployment
```

## 7. Point DNS at CloudFront

Take the CloudFront domain from the network stack output
(`DistributionDomainName`) and add a CNAME at your DNS provider:

```
<domainName>   CNAME   <distribution-id>.cloudfront.net
```

`domainName` is a subdomain, so a plain CNAME works (no ALIAS/ANAME needed).
CloudFront is the front door; it serves the legacy SPAs (each under
`/legacy/<app>/`, with the convention in the path as
`/legacy/<app>/org/{id}/con/{id}`) from S3 and forwards `/api*` and the apex `/`
(the dashboard) to the ALB (which stays internet-facing as the origin).

## 8. Wire up CI/CD

### App releases

The backend and Next.js frontend deploy by: build → push `:sha` + `:latest` →
`aws ecs update-service --force-new-deployment`. The three SPAs deploy instead
by: build the static bundle → `aws s3 sync` to the bucket prefix
(`legacy/admin`, `legacy/librarian`, `legacy/playandwin`) → `aws cloudfront create-invalidation`
(the deploy role already grants those S3/CloudFront actions).

All of these pipelines authenticate via **GitHub OIDC** — no static keys. The
services stack creates a **separate least-privilege deploy role per app repo** (not
one shared role), each trusting only that repo and carrying only its actions:

| App repo               | Role name                          | Output                       |
| ---------------------- | ---------------------------------- | ---------------------------- |
| `ruleslawyer-backend`  | `ruleslawyer-<env>-github-deploy-backend`  | `GithubDeployRoleBackendArn`  |
| `ruleslawyer-frontend` | `ruleslawyer-<env>-github-deploy-frontend` | `GithubDeployRoleFrontendArn` |
| `frontends`            | `ruleslawyer-<env>-github-deploy-frontends`| `GithubDeployRoleFrontendsArn`|

(all distinct from this repo's infra roles). Each role's trust is pinned to
`repo:<repo>:environment:<env>`, so **each app repo must define a GitHub Environment
named `nonprod`/`prod` and its deploy job must declare `environment: <env>`** — the
role cannot be assumed otherwise (a PR or arbitrary branch run carries a different
`sub` and is rejected). Each workflow also declares `permissions: id-token: write`.

In each app repo set the GitHub Actions **secrets** the workflows read:

- `PROD_ROLE_ARN` / `NONPROD_ROLE_ARN` — **that repo's own** deploy-role ARN from the
  table above (backend repo → `GithubDeployRoleBackendArn`, etc.). The secret *names*
  are shared across all repos by convention, but each repo's value is its own role; a
  repo secret overrides an org secret of the same name, so the workflows need no edits.
- `AWS_REGION` — `us-east-1`.
- Plus the app-specific build secrets each workflow needs (API host, Auth0
  client IDs/domain, etc.).

### Infra (`cdk deploy`) via GitHub Actions

This repo ships `.github/workflows/cdk.yml`: it runs `cdk diff` on PRs and, on
merge to `main`, deploys nonprod and prod as independent parallel jobs — prod
behind a manual-approval gate, and nonprod gated behind the `NONPROD_ROLE_ARN`
*variable* so it stays dormant until that account exists (see below). Auth is
GitHub OIDC — no static keys. The services stack creates **two** dedicated roles
per env:

- **Deploy** — `ruleslawyer-<env>-github-infra-deploy` (output `GithubInfraDeployRoleArn`),
  assumed by the merge-to-`main` deploy jobs. Trust pinned to
  `repo:<repo>:environment:<env>`. It can **only** assume the CDK bootstrap roles;
  CloudFormation applies the changes via the bootstrap cfn-exec role, so the
  privileged permissions never live on the GitHub-assumable role.
- **Diff** — `ruleslawyer-<env>-github-infra-diff` (output `GithubInfraDiffRoleArn`),
  assumed by the PR `diff` job **and** the pre-approval `diff-prod` job.
  **Read-only**; trust accepts two subs — `repo:<repo>:pull_request` (PR runs) and
  `repo:<repo>:ref:refs/heads/main` (push-to-`main` runs). It canNOT assume any
  bootstrap role, so it can't deploy regardless of which context assumes it — that
  privilege boundary is the structural guard, not the sub list: a PR (or a main
  push) cannot deploy via this role. (CI runs `cdk diff --no-change-set`; the
  default changeset diff would need write perms this role intentionally lacks, and
  CDK will warn it can't assume the deploy role and fall back to the diff creds —
  expected. `--strict` is also passed so CDK doesn't silently omit changes it flags
  as non-ASCII.)

The PR job runs `cdk diff` for both envs as a matrix, then a small `diff-gate`
job aggregates the matrix into a single pass/fail check (see branch protection,
step 3). On `push` to `main`: the **`diff-prod`** job renders the prod diff to its
job summary *before* the `deploy-prod` approval gate (which `needs:` it), so a
reviewer reads the diff before approving; `deploy-nonprod` (ungated) runs its
own informational `cdk diff` just before applying. Both push-side diffs are
`continue-on-error`, so a diff hiccup never blocks a deploy — and that also covers
the first run, before the widened diff-role trust has been deployed.

The first bootstrap + deploy of each account is manual (steps 2–4 above) — the
roles the workflow assumes don't exist until then. Once an env is up, enable CI:

1. **Role ARNs** (Settings → Secrets and variables → Actions). The workflow reads
   **four secrets** — a deploy and a diff ARN per env:
   - `PROD_ROLE_ARN` / `PROD_DIFF_ROLE_ARN` — **secrets**, set to the prod account's
     `GithubInfraDeployRoleArn` and `GithubInfraDiffRoleArn` outputs.
   - `NONPROD_ROLE_ARN` / `NONPROD_DIFF_ROLE_ARN` — when nonprod comes online, set the
     two **secrets** (the deploy + diff role ARNs) **and** a **variable**
     `NONPROD_ROLE_ARN` (any non-empty value). The variable is only an on/off
     flag — secrets can't be referenced in a job's `if:`, so the skip-guard tests
     the variable while the secrets supply the ARNs. Leave them unset and the
     nonprod jobs skip cleanly; the prod path is unaffected.

   **Retiring the flag once nonprod is permanent:** the `NONPROD_ROLE_ARN`
   *variable* exists only to skip nonprod before its account is built. Once
   nonprod is a standing CI environment, simplify `cdk.yml` so it always deploys
   like prod: delete `&& vars.NONPROD_ROLE_ARN != ''` from the `deploy-nonprod`
   job's `if:`, and drop the `matrix.env == 'prod' || vars.NONPROD_ROLE_ARN != ''`
   guard from the three nonprod steps in the `diff` job (Configure AWS
   credentials / cdk diff / Publish diff). After that the `NONPROD_ROLE_ARN` and
   `NONPROD_DIFF_ROLE_ARN` **secrets** are still used; only the `NONPROD_ROLE_ARN`
   *variable* becomes redundant and can be deleted.
2. **Environments** (Settings → Environments): create `nonprod` and `prod`; add
   **required reviewers** to `prod` — that approval is the deploy gate (CI uses
   `--require-approval never`, which only disables CDK's own interactive prompt).
3. **Branch protection** on `main`: require a PR review, and under "Require
   status checks to pass" add **`diff-gate`** (the aggregation job; its name
   stays stable even if the diff matrix changes — require this rather than the
   per-env `diff (prod)` / `diff (nonprod)` legs). Deploy only runs on
   `push` to `main` under the `prod`/`nonprod` Environments, and the PR `diff` job
   uses the read-only diff role (it can't deploy), so a PR can't deploy even if it
   rewrites the workflow — the review gate plus the prod Environment's required
   reviewers are what gate an actual merge/deploy. (The workflow already blocks fork
   PRs via the same-repo guard.)

## 9. Verify

```bash
aws ecs describe-services --cluster ruleslawyer-<env> \
  --services ruleslawyer-backend ruleslawyer-frontend \
  --query 'services[].{name:serviceName,running:runningCount,desired:desiredCount,state:deployments[0].rolloutState}'
```

Then smoke-test the endpoints under your domain (all via CloudFront): `/` (the
dashboard landing page), `/api`, `/legacy/admin`, `/legacy/librarian`, `/legacy/playandwin`, and a
convention-scoped SPA path such as `/legacy/admin/org/1/con/1` (should load the admin
SPA, not 503).

## After: day-to-day

- Releases: build → push `:sha` + `:latest` → `update-service --force-new-deployment`
  (the pipelines do this).
- Env var / secret / sizing changes are **infra changes**: edit `config.ts`,
  `cdk deploy`, then redeploy the app.
- The backend is CPU-autoscaled (target-tracking @ 50%, min/max from
  `backend.autoScaling`). To pre-warm for the convention, raise `minCapacity` in
  `config.ts` and `cdk deploy`, then lower it afterward.
