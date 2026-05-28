# Greenfield migration runbook

Stand up a fresh, fully CDK-managed environment in a **new AWS sub-account** and
cut prod over to it. The existing hand-built prod keeps serving traffic until the
final DNS switch, so there's no downtime until the cutover window itself.

This replaces any "adopt existing via `cdk import`" approach — prod is now a
greenfield **create**, not an import.

> Standing up a brand-new environment with nothing to migrate from? Use
> [DEPLOYMENT.md](DEPLOYMENT.md) — this runbook is that bring-up plus the DB
> migration, DNS cutover, and decommission of the live environment.

## Key facts that shape this plan

- **New sub-account.** Building in a fresh account avoids name collisions with the
  existing prod account (cluster `geekway-prod`, ECR repos, ALB `prod-alb`, SGs,
  secrets, IAM roles all already exist there).
- **DNS is external (Squarespace).** `geekway.com` is not in Route53, so CDK
  manages no DNS. The cutover is a CNAME change you make at Squarespace, and the
  ACM cert is validated by adding a CNAME there once (it then auto-renews).
- **`library.geekway.com` is a subdomain**, so a plain CNAME → the ALB DNS name
  works (no ALIAS/ANAME needed).
- **The DB is the hard part**, not the DNS — avoiding split-brain writes during
  the switch is what forces a short maintenance window.

---

## Phase 0 — Account + config

1. Create the new sub-account under the org; note its account ID.
2. Bootstrap CDK in it (with the new account's credentials):
   `cdk bootstrap aws://<new-account-id>/us-east-1`.
3. In `config.ts`, set the prod `account` to the new ID (replace the
   `TODO_PROD_ACCOUNT_ID` placeholder). `secrets: {}` and
   `githubOidcProviderExists: false` are already set for greenfield; confirm
   `githubRepos` is still correct.
4. Repoint the GitHub Actions deploy credentials to the new account — see
   "Deployment pipelines" below.

## Phase 1 — Deploy network + data

```bash
cdk deploy geekway-prod-network geekway-prod-data --context env=prod
```

- **The ACM cert blocks the deploy until you validate it.** Get the validation
  CNAME from the ACM console (or `aws acm describe-certificate`) and add it at
  Squarespace; once ACM sees it the deploy continues. Leave that CNAME in place
  permanently — it's what ACM re-checks on auto-renewal.
- This creates the VPC, ALB, cert, the RDS (which generates its own master
  credentials), and the placeholder secrets `geekway-prod-db-credentials` and
  `auth0-client-id`. No services yet, so nothing waits on container images.

## Phase 2 — Deploy services + seed images

The services reference the `:latest` image, which doesn't exist yet — and a
Fargate service can't reach steady state without an image, so you **must** get an
image into ECR during this step or the deploy will hang and roll back.

```bash
cdk deploy geekway-prod-services --context env=prod
```

This creates the ECR repos and the services. **While the deploy is still waiting
for the services to stabilize, push `:latest` to each repo** — run the app
pipelines against the new account (or build/push manually). Once the images are
present the tasks start, the services stabilize, and the deploy completes.

> Deterministic alternative: temporarily set the services' `desiredCount` to 0 for
> this first deploy so it completes immediately, push images, then restore to 1 and
> redeploy. The ECR repos use `removalPolicy: RETAIN`, so a failed/rolled-back
> deploy orphans them — delete or import them before retrying.

Then populate the created secrets (empty/placeholder until you fill them):

- `auth0-client-id` — the SPA Auth0 client ID.
- `ruleslawyer-frontend-prod-secrets` — `AUTH_SECRET` was generated; set
  `AUTH0_CLIENT_SECRET` from the Auth0 dashboard.
- `geekway-prod-db-credentials` — filled in Phase 3 (needs the RDS endpoint).
- Re-add a BoardGameGeek secret/ARN if the backend needs BGG.

Auth0 app config needs no change — the public hostname stays `library.geekway.com`.

## Phase 3 — Database

1. The new RDS generates its own master credentials (a separate RDS-managed
   secret). Read them and compose the app `DATABASE_URL`.
2. Restore a backup into the new RDS to validate connectivity and run the app
   end-to-end (use a recent dump for a dry run — **not** the final data yet).
3. Smoke-test the new stack via the **ALB DNS name** directly (or a temporary
   `new.library.geekway.com` CNAME) so you exercise it before touching prod DNS.

## Phase 4 — Cutover (the maintenance window)

Avoiding split-brain writes is the whole point of this sequence:

1. **Ahead of time:** lower the TTL on the `library.geekway.com` record at
   Squarespace (e.g. to 60s) so the switch propagates fast.
2. Put the **old** prod into maintenance / read-only to stop writes.
3. Take a **fresh final dump** of the old DB (the May backups are stale).
4. Restore that dump into the new RDS; update `DATABASE_URL` if needed and
   `--force-new-deployment` the services so they pick it up.
5. **Flip DNS:** point `library.geekway.com` CNAME at the new ALB DNS name.
6. Verify end-to-end on the live hostname once propagated. Watch logs/errors.

## Phase 5 — After

- Decommission the old environment once the new one is confirmed stable (old ALB +
  NAT keep billing until torn down). Keep the old DB snapshot for a while as a
  safety net.
- Day-to-day releases now: build → push `:sha` + `:latest` → `aws ecs
  update-service --force-new-deployment` (the pipelines already do this).
- Env/secret/sizing changes are infra changes: edit `config.ts`, `cdk deploy`,
  redeploy the app.

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

## Rollback

Until you decommission the old environment, rollback is just flipping the
`library.geekway.com` CNAME back to the old ALB (and pointing the app at the old
DB if you'd already cut writes over). Keep the TTL low until you're confident.
