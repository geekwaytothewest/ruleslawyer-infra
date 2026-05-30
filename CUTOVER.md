# Greenfield migration runbook

Stand up a fresh, fully CDK-managed environment in a **new AWS sub-account** and
cut prod over to it. The existing hand-built prod keeps serving traffic until the
final DNS switch, so there's no downtime until the cutover window itself.

This replaces any "adopt existing via `cdk import`" approach — prod is now a
greenfield **create**, not an import.

> Standing up a brand-new environment with nothing to migrate from? Use
> [DEPLOYMENT.md](DEPLOYMENT.md) — this runbook is that bring-up plus the DB
> migration, DNS cutover, and decommission of the live environment.
v
## Key facts that shape this plan

- **New sub-account.** Building in a fresh account avoids name collisions with the
  existing prod account (cluster `geekway-prod`, ECR repos, ALB `prod-alb`, SGs,
  secrets, IAM roles all already exist there).
- **DNS is external (Squarespace).** `geekway.com` is not in Route53, so CDK
  manages no DNS. The cutover is a CNAME change you make at Squarespace, and the
  ACM cert is validated by adding a CNAME there once (it then auto-renews).
- **`library.geekway.com` is a subdomain**, so a plain CNAME → the CloudFront
  distribution domain works (no ALIAS/ANAME needed). CloudFront is the front
  door; it serves the SPA prefixes from S3 and forwards `/api*` and the apex `/`
  (the dashboard) to the ALB.
- **The DB is the hard part**, not the DNS — avoiding split-brain writes during
  the switch is what forces a short maintenance window.

---

## Phase 0 — Account + config

1. Create the new sub-account under the org; note its account ID.
2. **Get admin credentials into the new account.** A freshly created member
   account has no IAM users of its own — you reach it by assuming an admin role in
   it *from* your existing management-account identity. When you created the
   sub-account you named that role (here `RulesLawyersAccessRole`); the console
   sets its trust policy to allow the management account automatically.

   This repo ships a template at [`.aws/config.example`](.aws/config.example).
   Copy it to `.aws/config` (which is gitignored, so your edits stay local) and
   fill in the prod values — account `428265842813`, role `RulesLawyersAccessRole`:
   ```bash
   cp .aws/config.example .aws/config
   ```
   ```ini
   # .aws/config
   [profile geekway-prod]
   role_arn = arn:aws:iam::428265842813:role/RulesLawyersAccessRole
   source_profile = <your-management-account-profile>   # ← fill this in (sub-steps below)
   region = us-east-1
   ```
   `source_profile` must name a profile holding **real credentials for the
   management account** (the account you used to create the sub-account). To set
   that up:

   1. Install the AWS CLI **v2** (`aws --version` must report `aws-cli/2.x`; on
      Arch: `sudo pacman -S aws-cli-v2`). If you have the v1 `aws-cli` package it
      conflicts — replace it: `sudo pacman -R aws-cli && sudo pacman -S aws-cli-v2`.
   2. Create the management-account profile. If you sign into that account with an
      IAM user, make a CLI access key for it (IAM → your user → Security
      credentials → Create access key → CLI; don't use root keys), then:
      ```bash
      aws configure --profile management   # paste the access key + secret, region us-east-1
      ```
      (If instead you use IAM Identity Center / AWS SSO, run `aws configure sso`
      and use the generated profile name in place of `management` — no
      `source_profile` needed.)
   3. Set `source_profile = management` in [`.aws/config`](.aws/config).

   Then tell the AWS CLI/CDK to use this config and confirm you've landed in the
   new account:
   ```bash
   export AWS_CONFIG_FILE="$PWD/.aws/config"   # use the local profile you filled in above
   export AWS_PROFILE=geekway-prod             # every cdk/aws command now targets prod
   aws sts get-caller-identity                 # Account must be 428265842813
   ```
3. Bootstrap CDK in it (using the credentials from step 2):
   `npx cdk bootstrap aws://<new-account-id>/us-east-1`. (Run `npm install` first
   so the pinned CDK CLI is available; `npx cdk` works without a global install —
   see the README's Requirements. The `cdk …` commands in this doc all assume it.)
4. In `config.ts`, set the prod `account` to the new ID (replace the
   `TODO_PROD_ACCOUNT_ID` placeholder). `secrets: {}` and
   `githubOidcProviderExists: false` are already set for greenfield; confirm
   `githubRepos` is still correct. To replicate the existing prod's direct
   Postgres access, set `dbPubliclyAccessible: true` and fill `dbAllowedCidrs`
   with the CIDRs from the old prod DB security group. The posture is
   **create-time** — flipping it later replaces the DB; editing the CIDR list is
   a safe SG-only change.

   Each `dbAllowedCidrs` entry opens port 5432 to one IPv4 range. An entry is
   either a bare CIDR string or `{ cidr, description }` — the description becomes
   the security-group rule's label so you can tell whose IP is whose in the
   console:
   ```ts
   dbAllowedCidrs: [
     '203.0.113.4/32',                                      // no label
     { cidr: '198.51.100.0/24', description: 'office' },    // labeled
   ],
   ```
   A single host still needs the `/32` suffix; IPv6 isn't supported. Pull the
   existing prod allowlist from the old DB's security group:
   ```bash
   # against the OLD prod account's credentials
   aws ec2 describe-security-groups --group-ids <old-db-sg-id> \
     --query 'SecurityGroups[].IpPermissions[?ToPort==`5432`].IpRanges[].CidrIp' \
     --output text
   ```
   Leaving it `[]` for now is fine — it's a safe SG-only edit you can apply before
   the Phase 3 DB cutover (when you first need to reach the DB with `psql`). To add
   your own machine: `curl -s https://checkip.amazonaws.com` then append `/32`.
5. Repoint the GitHub Actions deploy credentials to the new account — see
   "Deployment pipelines" below.

## Phase 1 — Deploy network + data

```bash
npx cdk deploy geekway-prod-network geekway-prod-data --context env=prod
```

- **The ACM cert blocks the deploy until you validate it.** Get the validation
  CNAME from the ACM console (or `aws acm describe-certificate`) and add it at
  Squarespace; once ACM sees it the deploy continues. Leave that CNAME in place
  permanently — it's what ACM re-checks on auto-renewal.
- This creates the VPC, ALB, cert, the S3 SPA bucket + CloudFront distribution,
  the RDS (which generates its own master credentials), and the placeholder
  secret `geekway-prod-db-credentials`. No services yet, so nothing waits on
  container images.

## Phase 2 — Deploy services + seed images

The services reference the `:latest` image, which doesn't exist yet — and a
Fargate service can't reach steady state without an image, so you **must** get an
image into ECR during this step or the deploy will hang and roll back.

```bash
npx cdk deploy geekway-prod-services --context env=prod
```

This creates the ECR repos and the services. **While the deploy is still waiting
for the services to stabilize, push `:latest` to each repo** — run the app
pipelines against the new account (or build/push manually). Once the images are
present the tasks start, the services stabilize, and the deploy completes.

> Deterministic alternative: temporarily set the services' `desiredCount` to 0 for
> this first deploy so it completes immediately, push images, then restore to 1 and
> redeploy. The backend has no `desiredCount` (it's CPU-autoscaled, min capacity 1),
> so for it either push its image first or temporarily set `autoScaling.minCapacity:
> 0`; the frontend uses `desiredCount`. The ECR repos use `removalPolicy:
> RETAIN`, so a failed/rolled-back deploy orphans them — delete or import them
> before retrying.

Then populate the created secrets (empty/placeholder until you fill them):

- `ruleslawyer-frontend-prod-secrets` — `AUTH_SECRET` was generated; set
  `AUTH0_CLIENT_SECRET` from the Auth0 dashboard.
- `geekway-prod-db-credentials` — filled in Phase 3 (needs the RDS endpoint).
- Re-add a BoardGameGeek secret/ARN if the backend needs BGG.

The SPAs' Auth0 client IDs are not secrets — each is baked in at build time by
the frontends CI (`AUTH_CLIENT_ID` build arg).

> **Dashboard at the apex — two ordering requirements.** The `ruleslawyer-frontend`
> dashboard is served at `/` (not `/ruleslawyer`); the ALB routes `/*` to it and its
> public landing page doubles as the `/` health check. For the services deploy to
> stabilize and login to work:
>
> 1. **Build the dashboard image with a root basePath.** `next.config.mjs` defaults
>    `basePath` to `''` when `NEXT_PUBLIC_BASE_PATH` is unset, so a normal build is
>    correct — just don't pass a non-empty `NEXT_PUBLIC_BASE_PATH` build arg. The
>    image must serve at `/`, or the health check (`GET /`) fails and the deploy
>    rolls back.
> 2. **Apply the Auth0 tenant before logging in.** The dashboard's callback/logout
>    moved to `##APP_BASE_URL##/auth/callback` and `##APP_BASE_URL##` (see
>    [`auth0/tenant.yaml`](auth0/tenant.yaml)). Re-apply the Auth0 config (see
>    [`auth0/README.md`](auth0/README.md)) so the new callback is registered, or
>    login fails with a callback-URL mismatch.

The hostname stays `library.geekway.com`; only the dashboard's *path* changed
(apex instead of `/ruleslawyer`), which is why the Auth0 callback/logout URLs above
must be re-applied.

## Phase 3 — Database

1. The new RDS generates its own master credentials (a separate RDS-managed
   secret). Read them and compose the app `DATABASE_URL`.
2. Restore a backup into the new RDS to validate connectivity and run the app
   end-to-end (use a recent dump for a dry run — **not** the final data yet).
3. Smoke-test the new stack via the **CloudFront distribution domain** directly
   (or a temporary `new.library.geekway.com` CNAME) so you exercise it before
   touching prod DNS. Hit `/` (the dashboard landing page), `/api`, the bare SPA
   prefixes `/legacy/admin` `/legacy/librarian` `/legacy/playandwin` (served from
   S3), and a convention-scoped path like `/legacy/admin/org/1/con/1` — confirm the
   dashboard answers at the apex and the SPAs still load (not the dashboard catch-all).

## Phase 4 — Cutover (the maintenance window)

Avoiding split-brain writes is the whole point of this sequence:

1. **Ahead of time:** lower the TTL on the `library.geekway.com` record at
   Squarespace (e.g. to 60s) so the switch propagates fast.
2. Put the **old** prod into maintenance / read-only to stop writes.
3. Take a **fresh final dump** of the old DB (the May backups are stale).
4. Restore that dump into the new RDS; update `DATABASE_URL` if needed and
   `--force-new-deployment` the services so they pick it up.
5. **Flip DNS:** point `library.geekway.com` CNAME at the new CloudFront
   distribution domain.
6. Verify end-to-end on the live hostname once propagated. Watch logs/errors.

## Phase 5 — After

- Decommission the old environment once the new one is confirmed stable (old ALB +
  NAT keep billing until torn down). Keep the old DB snapshot for a while as a
  safety net.
- Day-to-day releases now: backend/frontend build → push `:sha` + `:latest` →
  `aws ecs update-service --force-new-deployment`; the SPAs build → `aws s3 sync`
  to the bucket prefix → `aws cloudfront create-invalidation` (the pipelines
  already do this).
- Env/secret/sizing changes are infra changes: edit `config.ts`, `cdk deploy`,
  redeploy the app.
- The backend is CPU-autoscaled (min/max in `backend.autoScaling`); pre-warm for
  the convention by raising `minCapacity` and `cdk deploy`, then lower it after.

## Deployment pipelines (when to switch)

The new app workflows (build → push `:sha` + `:latest` → `aws ecs update-service
--force-new-deployment`) are written for the CDK-managed env and only work once:

- the services exist (Phase 2), **and**
- the GitHub deploy credentials point at the new account — update the secrets the
  workflows use (`ACCESS_KEY_ID` / `SECRET_ACCESS_KEY` + `PROD_ROLE_ARN`) to the
  new account, or switch to its OIDC role `geekway-prod-github-deploy` and add
  `permissions: id-token: write` to the jobs.

**Until cutover, keep shipping to the live old prod with the current (un-merged)
workflow version.** Don't merge this migration's pipeline changes (or the deleted
`.aws/taskdefinition-*.json` files) until the new env is the deploy target: the
new flow won't deploy real code to the hand-built prod, whose task definitions are
pinned to a specific `:sha` and aren't CDK-managed — a `force-new-deployment`
there just restarts the existing image.

### Infra deploys (`cdk deploy`) via GitHub Actions

The `.github/workflows/cdk.yml` workflow can run prod **infra** deploys against the
**new** account once it's bootstrapped and the services stack has been deployed
once (Phase 2). To enable it, set the repo variable `PROD_DEPLOY_ROLE_ARN` to the
new account's `geekway-prod-github-infra-deploy` role ARN (the
`GithubInfraDeployRoleArn` output), and configure a `prod` GitHub Environment with
required reviewers. Full setup is in [DEPLOYMENT.md](DEPLOYMENT.md) §7.

During the migration you're running `cdk deploy` by hand (Phases 1–2), so there's
no rush to switch infra deploys to CI. The prod job is gated by the Environment
approval, so it never deploys unattended — but only point `PROD_DEPLOY_ROLE_ARN`
at the **new** account, and treat a merge to `main` as a prod infra deploy once the
new env is your real prod.

## Rollback

Until you decommission the old environment, rollback is just flipping the
`library.geekway.com` CNAME back to the old ALB (and pointing the app at the old
DB if you'd already cut writes over). Keep the TTL low until you're confident.
