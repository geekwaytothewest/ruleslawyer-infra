# ruleslawyer-infra

AWS CDK (TypeScript) infrastructure for the Geekway to the West Rules Lawyer system. Manages the full AWS footprint across two environments (`nonprod` / `prod`).

## What it provisions

| Stack                  | Resources                                                              |
| ---------------------- | ---------------------------------------------------------------------- |
| `geekway-{env}-network`| VPC, subnets, security groups, ALB, ACM cert (manual DNS validation), S3 SPA bucket + CloudFront distribution |
| `geekway-{env}-data`   | RDS Postgres 14, Secrets Manager secret references                     |
| `geekway-{env}-services`| ECR repos x2, ECS cluster, 2 Fargate services (backend, frontend), GitHub OIDC deploy role |

CloudFront is the public front door: SPA prefixes (`/admin`, `/librarian`,
`/playandwin`) and their convention-scoped forms (`/org/{id}/con/{id}/<app>`)
are served from S3; `/api*` and `/ruleslawyer*` (and the default) forward to the
ALB. The three SPAs are built to static bundles and synced to the S3 bucket, not
run as services. A single bundle per app serves every convention — see
[Multiple conventions](#multiple-conventions).

## Requirements

- Node.js 20+
- AWS CDK v2: `npm install -g aws-cdk`
- AWS credentials with permissions to deploy (or assume the appropriate role)
- CDK bootstrapped in each account:
  ```bash
  cdk bootstrap aws://<new-nonprod-account-id>/us-east-1  # nonprod (new sub-account)
  cdk bootstrap aws://<new-prod-account-id>/us-east-1     # prod (new sub-account — see CUTOVER.md)
  ```

## Setup

```bash
npm install
npm run build
```

## Usage

First time deploying an environment? Follow [DEPLOYMENT.md](DEPLOYMENT.md) for the
full from-scratch walkthrough (or [CUTOVER.md](CUTOVER.md) to migrate the existing
hand-built prod). The commands below are the day-to-day reference for an
environment that's already up.

Pass `env` as CDK context to target an environment:

```bash
# Diff against nonprod
cdk diff --context env=nonprod

# Deploy all stacks to prod
cdk deploy --all --context env=prod

# Deploy only the services stack to nonprod
cdk deploy geekway-nonprod-services --context env=nonprod
```

## Migrating prod (greenfield, new account)

prod is being rebuilt as a fresh, fully CDK-managed environment in a **new AWS
sub-account**, then cut over from the existing hand-built infra. It is a
**create**, not a `cdk import`. The full step-by-step — account setup, deploy,
image/secret population, DB cutover, DNS switch, and rollback — is in
[CUTOVER.md](CUTOVER.md).

Because `geekway.com` DNS lives off AWS (Squarespace), this stack manages **no
Route53 records**: the cutover is a CNAME change at Squarespace pointing
`library.geekway.com` at the ALB's DNS name (a CfnOutput of the network stack),
and the ACM cert is validated by adding a CNAME there once (then auto-renews).
The RDS keeps `deletionProtection: true` / `removalPolicy: RETAIN` in prod to
guard against accidental destruction.

## Greenfield secrets (both environments)

Neither environment exists in AWS yet, so both are fresh **creates** — no
`cdk import`.

**Secrets convention:** a `secrets.*` ARN in `config.ts` means "import an existing
secret"; omitting it means "CDK creates a placeholder secret to populate after
first deploy." Both env blocks set no ARNs, so the first `cdk deploy` creates
(example shown for nonprod; prod is identical with `prod` in the names):

| Secret | Created as | Populate after deploy |
| ------ | ---------- | --------------------- |
| `geekway-nonprod-db-credentials` | `POSTGRES_USER` + generated `POSTGRES_PASSWORD`, empty `POSTGRES_HOST`/`DATABASE_URL` | Set `POSTGRES_HOST` and `DATABASE_URL` to point at the new RDS endpoint |
| `ruleslawyer-frontend-nonprod-secrets` | generated `AUTH_SECRET`, empty `AUTH0_CLIENT_SECRET` | Put the nonprod frontend's Auth0 client secret |

(Each SPA's Auth0 client ID is baked in at build time by the frontends CI via the
`AUTH_CLIENT_ID` build arg — there's a distinct ID per SPA, and none of them is
stored as an AWS secret.)

The nonprod RDS generates and manages its **own** master credentials (a separate
RDS-managed secret); the `db-credentials` secret above is the app-facing
connection string the backend reads. After first deploy, point `DATABASE_URL` at
the RDS endpoint using those master credentials.

First-time nonprod deploy:

```bash
cdk deploy --all --context env=nonprod
# then populate the two secrets above and redeploy the apps
```

## Deployment model (CDK owns the task definitions)

This stack is the **single source of truth** for every ECS task definition —
environment variables, secrets, CPU/memory, and the container image repo. The
app repos do **not** carry `.aws/taskdefinition-*.json` files anymore.

A release in an app repo is just:

1. `docker build` and push the image to ECR under **two** tags: the commit SHA
   (immutable record) and `latest` (what the task definition references).
2. `aws ecs update-service --cluster geekway-<env> --service <name> --force-new-deployment`,
   which restarts the tasks so they re-pull `latest` (Fargate always pulls fresh).

Changing an env var, secret, or sizing is an **infra change**: edit `config.ts`,
`cdk deploy` the services stack, then redeploy the app (or it picks it up on the
next release). The pipeline never registers task definitions, so the deploy role
only needs `ecs:UpdateService` / `ecs:DescribeServices` plus ECR push.

> **SPA exception:** the webpack SPAs (`admin`, `librarian`, `play-and-win`) are
> not services — they build to static bundles (baking their config: `API_URL`,
> `AUTH_*`, the per-SPA client ID) and the frontends CI syncs them to the S3
> bucket + invalidates CloudFront. That config lives in the app pipeline, not
> here. Only the backend and the Next.js frontend read runtime env from a task
> definition.

## GitHub OIDC (replacing static AWS keys)

The services stack provisions a `geekway-{env}-github-deploy` IAM role trusted by GitHub Actions via OIDC. After deploying the services stack, update each repo's GitHub Actions workflow to use the OIDC role instead of `ACCESS_KEY_ID` / `SECRET_ACCESS_KEY`:

```yaml
- name: Configure AWS credentials
  uses: aws-actions/configure-aws-credentials@v4
  with:
    role-to-assume: ${{ secrets.DEPLOY_ROLE_ARN }}  # output from this stack
    aws-region: us-east-1
# Requires `permissions: id-token: write` on the job.
```

Then remove the `ACCESS_KEY_ID` and `SECRET_ACCESS_KEY` secrets from GitHub.

## Notes

- **Routing (CloudFront):** `/admin*`, `/librarian*`, `/playandwin*` and their convention-scoped forms `/org/*/con/*/<app>` and `/org/*/con/*/<app>/*` → S3 (static SPA bundles); `/api*` → backend (8080) and `/ruleslawyer*` → dashboard (3000) forward to the ALB, as does the default behavior. A `geekway-{env}-spa-fallback` CloudFront Function rewrites SPA deep links (bare and convention-scoped) to the relevant `/<app>/index.html`; requests carrying a file extension pass through to the real S3 object.
- **Dashboard → legacy SPA links:** The Next.js dashboard isn't a full replacement yet, so it links out to the legacy SPAs for the gaps. Those targets are set on its ECS task as `LEGACY_ADMIN_URL` / `LEGACY_LIBRARIAN_URL` / `LEGACY_PLAY_PRIZE_ENTRY_URL` from `config.ts` (`rulelawyerFrontend.legacy*Url`), pointing at the CloudFront `/admin`, `/librarian`, `/playandwin` paths.
- **Frontend SPA env vars at runtime vs build time:** The webpack SPAs bake the API **origin** (`API_HOST`) and auth config at build time. The convention-specific `org/{id}/con/{id}` path is **not** baked — it's read from the page URL at runtime, so one build serves every convention (no per-convention rebuild). Changing the origin or auth config still means a rebuild + re-sync to S3.

## Multiple conventions

A single deployment of each SPA serves every convention. The convention is carried in the URL as `/org/{orgId}/con/{conId}/<app>`, and the bundle derives both its backend base (`<API_HOST>/api/legacy/org/{orgId}/con/{conId}`) and its router `basename` from the path at runtime. CloudFront supports this with:

- **Behaviors** for `/org/*/con/*/<app>` and `/org/*/con/*/<app>/*` (two patterns per app — a trailing `/*` won't match the slash-less bare form), pointing at the S3 origin.
- The **`spa-fallback` Function**, which rewrites any convention-scoped navigation to the one `/<app>/index.html`. Static assets are referenced from the absolute `/<app>/` publicPath, so they arrive as `/<app>/...` (the bare-prefix behaviors) and are **not** duplicated per convention in S3.

Adding a convention requires no infra change, rebuild, or re-sync — only that the backend has that org/con. Auth0 needs just one callback + logout URL per app (they're convention-independent); the convention is preserved across login via Auth0 `appState`.
- **Secrets (import vs create):** In `config.ts`, a `secrets.*` ARN means "import an existing secret"; omitting it means "CDK creates a placeholder to populate after first deploy." Both environments are greenfield (no ARNs). See "Greenfield secrets (both environments)" above.
- **RDS credentials:** When `secrets.dbCredentials` is set, the instance uses that imported secret; otherwise (greenfield) RDS generates and manages its own master credentials.
- **Sizing:** Instance types and task CPU/memory are defined in `config.ts` and are authoritative (the task definition is owned here, not in the app repos). Adjust there to scale.

## Structure

```
ruleslawyer-infra/
├── bin/
│   └── ruleslawyer-infra.ts   # CDK app entry point
├── lib/
│   ├── config.ts           # Per-environment configuration
│   ├── network-stack.ts    # VPC, ALB, ACM cert, S3 SPA bucket, CloudFront
│   ├── data-stack.ts       # RDS, Secrets Manager
│   └── services-stack.ts  # ECR, ECS, IAM, GitHub OIDC
├── cdk.json
├── package.json
└── tsconfig.json
```
