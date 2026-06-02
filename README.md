# ruleslawyer-infra

AWS CDK (TypeScript) infrastructure for the Rules Lawyer system. Manages the full AWS footprint across two environments (`nonprod` / `prod`).

## What it provisions

| Stack                  | Resources                                                              |
| ---------------------- | ---------------------------------------------------------------------- |
| `ruleslawyer-{env}-network`| VPC, subnets, security groups, ALB, ACM cert (manual DNS validation), S3 SPA bucket + CloudFront distribution |
| `ruleslawyer-{env}-data`   | RDS Postgres 14, Secrets Manager secret references                     |
| `ruleslawyer-{env}-services`| ECR repos x2, ECS cluster, 2 Fargate services (backend, frontend), GitHub OIDC deploy role |

CloudFront is the public front door: the legacy SPAs, each served entirely under
`/legacy/<app>/` (with the convention in the path as
`/legacy/<app>/org/{id}/con/{id}`), are served from S3; `/api*` and everything
else — including the apex `/`, served
by the **ruleslawyer-frontend dashboard** — forward to the ALB. The three SPAs are
built to static bundles and synced to the S3 bucket, not run as services. A single
bundle per app serves every convention — see
[Multiple conventions](#multiple-conventions).

## Requirements

- Node.js 22+ (CI runs Node 22; the AWS SDK drops Node 20 support in early 2027)
- AWS CLI **v2** (`aws`) — used for credentials and the `aws ecs` / `aws sts`
  commands. Verify with `aws --version` (must report `aws-cli/2.x`). On Arch:
  `sudo pacman -S aws-cli-v2`. The older `aws-cli` (v1) package **conflicts** with
  v2 and lacks commands like `aws configure sso`, so if you already have it,
  replace it: `sudo pacman -R aws-cli && sudo pacman -S aws-cli-v2`. Configure a
  profile for the target account before deploying (see
  [DEPLOYMENT.md](DEPLOYMENT.md) step 2).
- AWS CDK v2 — already pinned as a devDependency, so after `npm install` you can
  run the CLI with **`npx cdk`** (no global install needed). If you'd rather type
  `cdk` directly, install it globally with `npm install -g aws-cdk`; match the
  version in `package.json` to avoid drift with `aws-cdk-lib`.

  > Every `cdk …` command in this README (and in [DEPLOYMENT.md](DEPLOYMENT.md))
  > assumes one of the above. With `npx`, prefix each
  > command — e.g. `npx cdk deploy …`. A bare `cdk: command not found` means the
  > CLI isn't on your PATH; use `npx cdk` or install globally.
- AWS credentials with permissions to deploy (or assume the appropriate role)
- CDK bootstrapped in each account:
  ```bash
  npx cdk bootstrap aws://<nonprod-account-id>/us-east-1  # nonprod sub-account
  npx cdk bootstrap aws://<prod-account-id>/us-east-1     # prod sub-account
  ```

## Setup

```bash
npm install
npm run build
```

## Usage

First time deploying an environment? Follow [DEPLOYMENT.md](DEPLOYMENT.md) for the
full from-scratch walkthrough. The commands below are the day-to-day reference for
an environment that's already up.

Pass `env` as CDK context to target an environment:

```bash
# Diff against nonprod
npx cdk diff --context env=nonprod

# Deploy all stacks to prod
npx cdk deploy --all --context env=prod

# Deploy only the services stack to nonprod
npx cdk deploy ruleslawyer-nonprod-services --context env=nonprod
```

## DNS and prod data protection

Both environments are fully CDK-managed, each in its own AWS sub-account. The
platform now runs entirely on this stack.

Because `ruleslawyer.com` DNS lives off AWS (Squarespace), this stack manages **no
Route53 records**: `library.ruleslawyer.com` is a CNAME at Squarespace pointing at the
ALB's DNS name (a CfnOutput of the network stack), and the ACM cert is validated
by a CNAME there once (then auto-renews). The prod RDS keeps
`deletionProtection: true` / `removalPolicy: RETAIN` to guard against accidental
destruction.

## Secrets (both environments)

**Secrets convention:** a `secrets.*` ARN in `config.ts` means "import an existing
secret"; omitting it means "CDK creates a placeholder secret to populate after
first deploy." Both env blocks set no ARNs, so the first `cdk deploy` creates
(example shown for nonprod; prod is identical with `prod` in the names):

| Secret | Created as | Populate after deploy |
| ------ | ---------- | --------------------- |
| `ruleslawyer-nonprod-db-credentials` | `POSTGRES_USER` + generated `POSTGRES_PASSWORD`, empty `POSTGRES_HOST`/`DATABASE_URL` | Set `POSTGRES_HOST` and `DATABASE_URL` to point at the new RDS endpoint |
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
npx cdk deploy --all --context env=nonprod
# then populate the two secrets above and redeploy the apps
```

## Deployment model (CDK owns the task definitions)

This stack is the **single source of truth** for every ECS task definition —
environment variables, secrets, CPU/memory, and the container image repo. The
app repos do **not** carry `.aws/taskdefinition-*.json` files anymore.

A release in an app repo is just:

1. `docker build` and push the image to ECR under **two** tags: the commit SHA
   (immutable record) and `latest` (what the task definition references).
2. `aws ecs update-service --cluster ruleslawyer-<env> --service <name> --force-new-deployment`,
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

The services stack provisions a **separate least-privilege deploy role per app repo** (`ruleslawyer-{env}-github-deploy-backend`, `-frontend`, `-frontends`), each trusted by GitHub Actions via OIDC. Each app workflow assumes its own role, selecting the ARN per environment from the `PROD_ROLE_ARN` / `NONPROD_ROLE_ARN` secrets (the secret *names* are shared by convention; each repo's value is its own role). See `DEPLOYMENT.md` for the full role/output table.

```yaml
permissions:
  id-token: write   # mint the OIDC token
  contents: read

# ...
- name: Configure AWS credentials
  uses: aws-actions/configure-aws-credentials@v4
  with:
    role-to-assume: ${{ inputs.environment == 'prod' && secrets.PROD_ROLE_ARN || secrets.NONPROD_ROLE_ARN }}
    aws-region: ${{ secrets.AWS_REGION }}
```

No static keys — there are no `ACCESS_KEY_ID` / `SECRET_ACCESS_KEY` secrets.

## Notes

- **Routing (CloudFront):** `/legacy/admin`, `/legacy/librarian`, `/legacy/playandwin` (each as the bare prefix and `/*` sub-paths, covering assets and the convention path `/legacy/<app>/org/*/con/*`) → S3 (static SPA bundles); `/api*` → backend (8080) via the ALB; the default behavior (apex `/` and everything else, e.g. `/_next/*`) → the ALB, where the dashboard's `/*` rule serves the **ruleslawyer-frontend** (3000). The dashboard is the catch-all, so the `/legacy/<app>` prefixes are explicitly carved out to S3. A `ruleslawyer-{env}-spa-fallback` CloudFront Function rewrites any extensionless navigation under `/legacy/<app>/` to that app's `/legacy/<app>/index.html`; requests carrying a file extension pass through to the real S3 object.
- **Dashboard → legacy SPA links:** The Next.js dashboard isn't a full replacement yet, so it links out to the legacy SPAs for the gaps. Those targets are set on its ECS task as `LEGACY_ADMIN_URL` / `LEGACY_LIBRARIAN_URL` / `LEGACY_PLAY_PRIZE_ENTRY_URL` from `config.ts` (`ruleslawyerFrontend.legacy*Url`), pointing at the CloudFront `/legacy/admin`, `/legacy/librarian`, `/legacy/playandwin` paths.
- **Frontend SPA env vars at runtime vs build time:** The webpack SPAs bake the API **origin** (`API_HOST`) and auth config at build time. The convention-specific `org/{id}/con/{id}` path is **not** baked — it's read from the page URL at runtime, so one build serves every convention (no per-convention rebuild). Changing the origin or auth config still means a rebuild + re-sync to S3.

## Multiple conventions

A single deployment of each SPA serves every convention. Each legacy app lives entirely under `/legacy/<app>/`, and the convention is carried in the path as `/legacy/<app>/org/{orgId}/con/{conId}`. The bundle derives both its backend base (`<API_HOST>/api/legacy/org/{orgId}/con/{conId}`) and its router `basename` from the path at runtime. CloudFront supports this with:

- **Behaviors** for `/legacy/<app>` and `/legacy/<app>/*` (two patterns per app — the bare prefix, where a trailing `/*` won't match, plus its sub-paths), pointing at the S3 origin.
- The **`spa-fallback` Function**, which rewrites any extensionless navigation under `/legacy/<app>/` (bare, convention-scoped, or a deep link) to the one `/legacy/<app>/index.html`. Static assets are referenced from the absolute `/legacy/<app>/` publicPath, so they arrive as `/legacy/<app>/...` and are **not** duplicated per convention in S3. (Because org/con is now just part of the path under the prefix, the fallback needs no special convention parsing.)

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
