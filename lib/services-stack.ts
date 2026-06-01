import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { EnvConfig, EnvName } from './config';

interface ServicesStackProps extends cdk.StackProps {
  envName: EnvName;
  config: EnvConfig;
  vpc: ec2.Vpc;
  ecsSg: ec2.SecurityGroup;
  httpsListener: elbv2.ApplicationListener;
  dbSecret: secretsmanager.ISecret;
  /** Static SPA bucket — the deploy role gets write access so CI can sync bundles */
  spaBucket: s3.IBucket;
  /** CloudFront distribution — the deploy role gets invalidation rights */
  distribution: cloudfront.IDistribution;
}

export class ServicesStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ServicesStackProps) {
    super(scope, id, props);

    const { envName, config, vpc, ecsSg, httpsListener, dbSecret, spaBucket, distribution } = props;

    // ── ECS Task Execution Role (create) ──────────────────────────────────
    // The well-known `ecsTaskExecutionRole` is only auto-created by the ECS
    // console wizard, so a greenfield IaC account has none — create it here.
    // The AWS-managed policy covers ECR pull + CloudWatch Logs; CDK adds the
    // dbSecret read grant on top when the container references it via `secrets`.
    const executionRole = new iam.Role(this, 'ExecutionRole', {
      roleName: 'ecsTaskExecutionRole',
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AmazonECSTaskExecutionRolePolicy',
        ),
      ],
    });

    // ── ECS Cluster ───────────────────────────────────────────────────────
    const cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: config.clusterName,
      vpc,
      // Container Insights bills per metric across every service — keep it on
      // for prod observability, off in nonprod where it isn't worth the cost.
      containerInsightsV2:
        envName === 'prod'
          ? ecs.ContainerInsights.ENABLED
          : ecs.ContainerInsights.DISABLED,
      // Enable the FARGATE / FARGATE_SPOT capacity providers so services can
      // opt into Spot (see makeService — nonprod runs on Spot).
      enableFargateCapacityProviders: true,
    });

    // ── ECR Repositories ──────────────────────────────────────────────────
    const makeEcr = (name: string) =>
      new ecr.Repository(this, `Ecr-${name}`, {
        repositoryName: name,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        lifecycleRules: [{ maxImageCount: 10 }],
      });

    // Only the two container workloads keep ECR repos. The three static SPAs
    // (admin / librarian / play-and-win) are now served from S3 + CloudFront,
    // so they no longer build or push images.
    const ecrBackend = makeEcr('ruleslawyer-backend');
    const ecrFrontend = makeEcr('ruleslawyer-frontend');

    // ── GitHub OIDC deploy role (replaces static ACCESS_KEY_ID) ──────────
    const oidcProvider: iam.IOpenIdConnectProvider = config.githubOidcProviderExists
      ? iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
          this,
          'GithubOidc',
          `arn:aws:iam::${config.account}:oidc-provider/token.actions.githubusercontent.com`,
        )
      : new iam.OpenIdConnectProvider(this, 'GithubOidc', {
          url: 'https://token.actions.githubusercontent.com',
          clientIds: ['sts.amazonaws.com'],
        });

    // One deploy role per repo, each trusting only that repo's `sub` and
    // carrying only the permissions that repo's pipeline needs. Previously a
    // single role trusted all three repos and held the union of their
    // permissions, so a leaked OIDC token from any one repo could deploy the
    // others. Each ARN is published as an output; wire it into that repo's own
    // PROD_ROLE_ARN / NONPROD_ROLE_ARN *repo* secret (a repo secret overrides
    // an org secret of the same name, so the workflows need no edits).
    //
    // Trust is pinned to the GitHub Environment context, not a wildcard: each
    // repo's deploy job runs under `environment: <env>` (a real GitHub
    // Environment with required reviewers), which makes the OIDC `sub` claim
    // `repo:<repo>:environment:<env>`. So the role can ONLY be assumed from an
    // approved deployment to this env — not from a PR, nor a workflow_dispatch
    // run from an arbitrary branch (those carry a `…:pull_request` / `…:ref:…`
    // sub). The matching `environment:` key must exist on the deploy job in each
    // repo's workflow, or the deploy can't assume the role.
    const makeDeployRole = (id: string, nameSuffix: string, repoSlug: string) =>
      new iam.Role(this, id, {
        roleName: `geekway-${envName}-github-deploy-${nameSuffix}`,
        assumedBy: new iam.WebIdentityPrincipal(oidcProvider.openIdConnectProviderArn, {
          StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
            'token.actions.githubusercontent.com:sub': `repo:${repoSlug}:environment:${envName}`,
          },
        }),
      });

    // GetAuthorizationToken can't be resource-scoped (it mints a registry-wide
    // token), so it's a shared statement granted to the two container roles.
    const ecrAuthStatement = () => new iam.PolicyStatement({
      actions: ['ecr:GetAuthorizationToken'],
      resources: ['*'],
    });
    const ecrPushActions = [
      'ecr:BatchCheckLayerAvailability',
      'ecr:GetDownloadUrlForLayer',
      'ecr:BatchGetImage',
      'ecr:InitiateLayerUpload',
      'ecr:UploadLayerPart',
      'ecr:CompleteLayerUpload',
      'ecr:PutImage',
    ];
    // CDK owns the task definitions; a pipeline only ships a new image and forces
    // a redeploy, so it needs UpdateService (now scoped to its own service ARN)
    // but not RegisterTaskDefinition — and therefore no iam:PassRole.
    const ecsServiceArn = (service: string) =>
      `arn:aws:ecs:${this.region}:${this.account}:service/${config.clusterName}/${service}`;

    // ── ruleslawyer-backend: backend ECR + backend ECS service ────────────
    const backendDeployRole = makeDeployRole(
      'GithubDeployRoleBackend', 'backend', config.githubRepos.backend);
    backendDeployRole.addToPolicy(ecrAuthStatement());
    backendDeployRole.addToPolicy(new iam.PolicyStatement({
      actions: ecrPushActions,
      resources: [ecrBackend.repositoryArn],
    }));
    backendDeployRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ecs:UpdateService', 'ecs:DescribeServices'],
      resources: [ecsServiceArn('ruleslawyer-backend')],
    }));
    new cdk.CfnOutput(this, 'GithubDeployRoleBackendArn', { value: backendDeployRole.roleArn });

    // ── ruleslawyer-frontend: frontend ECR + frontend ECS service ─────────
    const frontendDeployRole = makeDeployRole(
      'GithubDeployRoleFrontend', 'frontend', config.githubRepos.frontend);
    frontendDeployRole.addToPolicy(ecrAuthStatement());
    frontendDeployRole.addToPolicy(new iam.PolicyStatement({
      actions: ecrPushActions,
      resources: [ecrFrontend.repositoryArn],
    }));
    frontendDeployRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ecs:UpdateService', 'ecs:DescribeServices'],
      resources: [ecsServiceArn('ruleslawyer-frontend')],
    }));
    new cdk.CfnOutput(this, 'GithubDeployRoleFrontendArn', { value: frontendDeployRole.roleArn });

    // ── frontends: static SPA deploys (S3 + CloudFront), no ECR/ECS ───────
    // Syncs each app's dist/ into the SPA bucket and invalidates CloudFront.
    // Writes scoped to the three SPA prefixes; ListBucket is needed for
    // `aws s3 sync --delete`; DescribeStacks reads the SpaBucketName output.
    const frontendsDeployRole = makeDeployRole(
      'GithubDeployRoleFrontends', 'frontends', config.githubRepos.frontends);
    frontendsDeployRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:PutObject', 's3:DeleteObject'],
      resources: [
        `${spaBucket.bucketArn}/legacy/admin/*`,
        `${spaBucket.bucketArn}/legacy/librarian/*`,
        `${spaBucket.bucketArn}/legacy/playandwin/*`,
      ],
    }));
    frontendsDeployRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucket'],
      resources: [spaBucket.bucketArn],
    }));
    frontendsDeployRole.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudfront:CreateInvalidation'],
      resources: [
        `arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`,
      ],
    }));
    frontendsDeployRole.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudformation:DescribeStacks'],
      resources: [
        `arn:aws:cloudformation:${this.region}:${this.account}:stack/geekway-${envName}-network/*`,
      ],
    }));
    new cdk.CfnOutput(this, 'GithubDeployRoleFrontendsArn', { value: frontendsDeployRole.roleArn });

    // ── GitHub OIDC infra-deploy role (runs `cdk deploy` from CI) ─────────
    // Separate from the app-deploy role above. Rather than broad resource
    // permissions, it may only assume the CDK bootstrap roles; CloudFormation
    // applies the actual changes via the bootstrap cfn-exec role, so the
    // privileged permissions stay inside CFN, not on this GitHub-assumable role.
    // Assumes the default bootstrap qualifier (hnb659fds) — adjust the resource
    // wildcard if you bootstrapped with `--qualifier`.
    //
    // Trust is pinned to the deploy context only: the CI deploy jobs run inside a
    // GitHub Environment named after `envName` (prod/nonprod), which makes the
    // OIDC `sub` claim `repo:<repo>:environment:<envName>` — NOT a branch ref. So
    // a pull_request-triggered run (sub `…:pull_request`) cannot assume this role
    // even if a PR rewrites the workflow; PRs use the read-only diff role below.
    const infraDeployRole = new iam.Role(this, 'GithubInfraDeployRole', {
      roleName: `geekway-${envName}-github-infra-deploy`,
      assumedBy: new iam.WebIdentityPrincipal(oidcProvider.openIdConnectProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub': `repo:${config.githubInfraRepo}:environment:${envName}`,
        },
      }),
    });
    infraDeployRole.addToPolicy(new iam.PolicyStatement({
      actions: ['sts:AssumeRole'],
      resources: [`arn:aws:iam::${this.account}:role/cdk-hnb659fds-*`],
    }));

    new cdk.CfnOutput(this, 'GithubInfraDeployRoleArn', { value: infraDeployRole.roleArn });

    // ── GitHub OIDC infra-diff role (runs `cdk diff` on PRs, read-only) ───
    // Assumed only by the PR `diff` job (sub `repo:<repo>:pull_request`). It does
    // NOT get `sts:AssumeRole` on any CDK bootstrap role, so it cannot reach the
    // deploy/cfn-exec roles — the privilege boundary that the old shared role
    // lacked. It holds just the read-only CloudFormation perms `cdk diff` needs to
    // fetch the deployed template, plus read of the bootstrap version SSM param.
    // CI must run `cdk diff --no-change-set`: the default changeset-based diff
    // would require write (CreateChangeSet + PassRole), which this role can't do.
    // CDK will warn that it can't assume the deploy role and fall back to these
    // current credentials — expected, and proof the role is least-privilege.
    const infraDiffRole = new iam.Role(this, 'GithubInfraDiffRole', {
      roleName: `geekway-${envName}-github-infra-diff`,
      assumedBy: new iam.WebIdentityPrincipal(oidcProvider.openIdConnectProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub': `repo:${config.githubInfraRepo}:pull_request`,
        },
      }),
    });
    infraDiffRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ReadDeployedTemplatesForDiff',
      actions: ['cloudformation:DescribeStacks', 'cloudformation:GetTemplate'],
      resources: [`arn:aws:cloudformation:${this.region}:${this.account}:stack/geekway-${envName}-*/*`],
    }));
    infraDiffRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ReadBootstrapVersion',
      actions: ['ssm:GetParameter', 'ssm:GetParameters'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/cdk-bootstrap/hnb659fds/version`],
    }));

    new cdk.CfnOutput(this, 'GithubInfraDiffRoleArn', { value: infraDiffRole.roleArn });

    // ── Helper: build a Fargate service + ALB target group ────────────────
    const makeService = (opts: {
      id: string;
      serviceName: string;
      ecrRepo: ecr.Repository;
      containerPort: number;
      cpu: number;
      memoryMiB: number;
      environment: Record<string, string>;
      secrets: Record<string, ecs.Secret>;
      logGroup: string;
      healthCheckPath: string;
      pathPatterns: string[];
      priority: number;
      autoScaling?: { minCapacity: number; maxCapacity: number; cpuTargetPercent: number };
    }) => {
      const taskDef = new ecs.FargateTaskDefinition(this, `${opts.id}TaskDef`, {
        family: opts.serviceName,
        cpu: opts.cpu,
        memoryLimitMiB: opts.memoryMiB,
        executionRole,
        runtimePlatform: {
          cpuArchitecture: ecs.CpuArchitecture.X86_64,
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        },
      });

      taskDef.addContainer(`${opts.id}Container`, {
        containerName: opts.serviceName,
        image: ecs.ContainerImage.fromEcrRepository(opts.ecrRepo, 'latest'),
        portMappings: [{ containerPort: opts.containerPort }],
        environment: opts.environment,
        secrets: opts.secrets,
        logging: ecs.LogDrivers.awsLogs({
          logGroup: new logs.LogGroup(this, `${opts.id}LogGroup`, {
            logGroupName: opts.logGroup,
            retention: logs.RetentionDays.ONE_MONTH,
            removalPolicy: cdk.RemovalPolicy.RETAIN,
          }),
          streamPrefix: 'ecs',
        }),
      });

      const service = new ecs.FargateService(this, `${opts.id}Service`, {
        serviceName: opts.serviceName,
        cluster,
        taskDefinition: taskDef,
        // When autoscaling is configured, omit desiredCount so Application Auto
        // Scaling owns the running count and a `cdk deploy` doesn't reset it.
        desiredCount: opts.autoScaling ? undefined : 1,
        // Public subnet + public IP so tasks reach ECR / Secrets / CloudWatch /
        // Auth0 without a NAT gateway. Inbound is still restricted to the ALB by
        // ecsSg, so the public IP is used for egress only.
        vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
        assignPublicIp: true,
        securityGroups: [ecsSg],
        enableExecuteCommand: true,
        // nonprod runs entirely on Fargate Spot (~70% cheaper); prod stays on
        // on-demand Fargate for stability during the convention.
        capacityProviderStrategies:
          envName === 'nonprod'
            ? [{ capacityProvider: 'FARGATE_SPOT', weight: 1 }]
            : undefined,
        // Fail (and roll back) a deploy fast when tasks can't start instead of
        // letting ECS retry for ~3 hours — e.g. a missing/broken image in ECR.
        circuitBreaker: { enable: true, rollback: true },
        // prod keeps 100% of tasks up during a deploy (new task starts before the
        // old stops); nonprod allows 0% so a single-task service can deploy in
        // place without paying for an extra task.
        minHealthyPercent: envName === 'prod' ? 100 : 0,
      });

      if (opts.autoScaling) {
        const scaling = service.autoScaleTaskCount({
          minCapacity: opts.autoScaling.minCapacity,
          maxCapacity: opts.autoScaling.maxCapacity,
        });
        scaling.scaleOnCpuUtilization(`${opts.id}CpuScaling`, {
          targetUtilizationPercent: opts.autoScaling.cpuTargetPercent,
        });
      }

      const targetGroup = new elbv2.ApplicationTargetGroup(this, `${opts.id}Tg`, {
        vpc,
        port: opts.containerPort,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targets: [service],
        healthCheck: {
          path: opts.healthCheckPath,
          healthyHttpCodes: '200-404',
          interval: cdk.Duration.seconds(30),
        },
      });

      // Create the rule in THIS (services) stack rather than via
      // httpsListener.addAction(), which would scope it to the network stack and
      // make that stack reference these target groups — a services<->network cycle.
      new elbv2.ApplicationListenerRule(this, `${opts.id}Rule`, {
        listener: httpsListener,
        priority: opts.priority,
        conditions: [elbv2.ListenerCondition.pathPatterns(opts.pathPatterns)],
        action: elbv2.ListenerAction.forward([targetGroup]),
      });

      return service;
    };

    // ── ruleslawyer-backend ───────────────────────────────────────────────
    const backendSecrets: Record<string, ecs.Secret> = {
      POSTGRES_HOST: ecs.Secret.fromSecretsManager(dbSecret, 'POSTGRES_HOST'),
      POSTGRES_USER: ecs.Secret.fromSecretsManager(dbSecret, 'POSTGRES_USER'),
      POSTGRES_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret, 'POSTGRES_PASSWORD'),
      DATABASE_URL: ecs.Secret.fromSecretsManager(dbSecret, 'DATABASE_URL'),
    };

// ── BoardGameGeek API token ───────────────────────────────────────────
// CDK owns this secret. Created with a placeholder API_TOKEN; set the real
// value in Secrets Manager after the first deploy. generateSecretString only
// runs at creation, so redeploys won't overwrite it.
const bggSecret = new secretsmanager.Secret(this, 'BggSecret', {
  secretName: `ruleslawyer-bgg-${envName}-secret`,
  description: 'BoardGameGeek API token -- set API_TOKEN post-deploy',
  generateSecretString: {
    secretStringTemplate: JSON.stringify({}),
    generateStringKey: 'API_TOKEN',
    excludePunctuation: true,
  },
});

backendSecrets['BOARDGAMEGEEK_API_TOKEN'] =
  ecs.Secret.fromSecretsManager(bggSecret, 'API_TOKEN');

    makeService({
      id: 'Backend',
      serviceName: 'ruleslawyer-backend',
      ecrRepo: ecrBackend,
      containerPort: 8080,
      cpu: config.backend.cpu,
      memoryMiB: config.backend.memoryMiB,
      autoScaling: config.backend.autoScaling,
      environment: {
        FASTIFY_PORT: '8080',
        AUTH0_AUDIENCE: 'https://api.ruleslawyer.geekway.com',
        AUTH0_ISSUER_URL: 'https://geekway.auth0.com/',
        ADMIN_CLIENT_ORIGIN: config.backend.origins.admin,
        LIBRARIAN_CLIENT_ORIGIN: config.backend.origins.librarian,
        PLAY_AND_WIN_CLIENT_ORIGIN: config.backend.origins.playAndWin,
        RULESLAWYER_FRONTEND_ORIGIN: config.backend.origins.ruleslawyerFrontend,
      },
      secrets: backendSecrets,
      logGroup: '/ecs/ruleslawyer-backend',
      // GET /api has no handler (the root controller only defines /api/status),
      // so probing /api returned 404. Point at the real status route, which
      // returns 200 once the Nest app is up.
      healthCheckPath: '/api/status',
      pathPatterns: ['/api', '/api/*'],
      priority: 100,
    });

    // ── Static SPAs (admin / librarian / play-and-win) ────────────────────
    // These three apps are now served from S3 + CloudFront (see network-stack:
    // SpaBucket + Distribution), not Fargate. Their build-time config
    // (AUTH_CLIENT_ID, AUTH_CALLBACK, etc.) is supplied by the frontends CI at
    // `npm run build:prod` time and synced to the SPA bucket — nothing to run
    // here.

    // ── ruleslawyer-frontend (Next.js dashboard) ──────────────────────────
    const frontendEnv = config.ruleslawyerFrontend;
    const frontendSecretEnv: Record<string, ecs.Secret> = {};

    // Prod: import the existing secret by ARN. Greenfield: create it with a
    // generated AUTH_SECRET (session key) and an empty AUTH0_CLIENT_SECRET to
    // fill from the Auth0 dashboard after the first deploy.
    const feSec = config.secrets.frontendSecrets
      ? secretsmanager.Secret.fromSecretCompleteArn(
          this, 'FrontendSecrets', config.secrets.frontendSecrets,
        )
      : new secretsmanager.Secret(this, 'FrontendSecrets', {
          secretName: `ruleslawyer-frontend-${envName}-secrets`,
          description: 'Next.js frontend Auth0 secrets -- set AUTH0_CLIENT_SECRET post-deploy',
          generateSecretString: {
            secretStringTemplate: JSON.stringify({ AUTH0_CLIENT_SECRET: '' }),
            generateStringKey: 'AUTH_SECRET',
            excludePunctuation: true,
          },
        });
    frontendSecretEnv['AUTH0_SECRET'] = ecs.Secret.fromSecretsManager(feSec, 'AUTH_SECRET');
    frontendSecretEnv['AUTH0_CLIENT_SECRET'] =
      ecs.Secret.fromSecretsManager(feSec, 'AUTH0_CLIENT_SECRET');

    makeService({
      id: 'RuleslawyerFrontend',
      serviceName: 'ruleslawyer-frontend',
      ecrRepo: ecrFrontend,
      containerPort: 3000,
      cpu: frontendEnv.cpu,
      memoryMiB: frontendEnv.memoryMiB,
      autoScaling: frontendEnv.autoScaling,
      environment: {
        NODE_ENV: 'production',
        PORT: '3000',
        AUTH0_DOMAIN: 'geekway.auth0.com',
        AUTH0_CLIENT_ID: frontendEnv.auth0ClientId,
        AUTH0_AUDIENCE: 'https://api.ruleslawyer.geekway.com',
        APP_BASE_URL: frontendEnv.appBaseUrl,
        API_URL: frontendEnv.apiUrl,
        NEXT_PUBLIC_API_URL: frontendEnv.apiUrl,
        // Outbound links to the legacy SPA frontends (served from S3 + CloudFront)
        // for the capabilities the dashboard doesn't cover yet.
        LEGACY_ADMIN_URL: frontendEnv.legacyAdminUrl,
        LEGACY_LIBRARIAN_URL: frontendEnv.legacyLibrarianUrl,
        LEGACY_PLAY_PRIZE_ENTRY_URL: frontendEnv.legacyPlayPrizeEntryUrl,
      },
      secrets: frontendSecretEnv,
      logGroup: '/ecs/ruleslawyer-frontend',
      // The dashboard is the apex app: its public landing page ('/') returns 200
      // without auth, so it doubles as the health check.
      healthCheckPath: '/',
      // Catch-all — the dashboard serves everything not claimed by a
      // higher-precedence rule. Backend '/api*' is priority 100 (lower number =
      // evaluated first), so the API still wins; the static SPAs are served by
      // CloudFront from S3 and never reach the ALB. This stays the highest number
      // (lowest precedence) so any future, more specific route can slot in front.
      pathPatterns: ['/*'],
      priority: 500,
    });
  }
}
