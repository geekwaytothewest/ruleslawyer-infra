import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
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
  auth0ClientIdSecret: secretsmanager.ISecret;
}

export class ServicesStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ServicesStackProps) {
    super(scope, id, props);

    const { envName, config, vpc, ecsSg, httpsListener, dbSecret, auth0ClientIdSecret } = props;

    // ── ECS Task Execution Role (import existing) ─────────────────────────
    const executionRole = iam.Role.fromRoleName(
      this, 'ExecutionRole', 'ecsTaskExecutionRole',
    );

    // ── ECS Cluster ───────────────────────────────────────────────────────
    const cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: config.clusterName,
      vpc,
      containerInsights: true,
    });

    // ── ECR Repositories ──────────────────────────────────────────────────
    const makeEcr = (name: string) =>
      new ecr.Repository(this, `Ecr-${name}`, {
        repositoryName: name,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        lifecycleRules: [{ maxImageCount: 10 }],
      });

    const ecrBackend = makeEcr('ruleslawyer-backend');
    const ecrAdmin = makeEcr('frontends-admin');
    const ecrLibrarian = makeEcr('frontends-librarian');
    const ecrPlayAndWin = makeEcr('frontends-play-and-win');
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

    const repoConditions = config.githubRepos.map(
      (repo) => `repo:${repo}:*`,
    );

    const deployRole = new iam.Role(this, 'GithubDeployRole', {
      roleName: `geekway-${envName}-github-deploy`,
      assumedBy: new iam.WebIdentityPrincipal(oidcProvider.openIdConnectProviderArn, {
        StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
        StringLike: { 'token.actions.githubusercontent.com:sub': repoConditions },
      }),
    });

    // ECR push + ECS deploy permissions
    deployRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'ecr:GetAuthorizationToken',
        'ecr:BatchCheckLayerAvailability',
        'ecr:GetDownloadUrlForLayer',
        'ecr:BatchGetImage',
        'ecr:InitiateLayerUpload',
        'ecr:UploadLayerPart',
        'ecr:CompleteLayerUpload',
        'ecr:PutImage',
      ],
      resources: [
        ecrBackend.repositoryArn,
        ecrAdmin.repositoryArn,
        ecrLibrarian.repositoryArn,
        ecrPlayAndWin.repositoryArn,
        ecrFrontend.repositoryArn,
      ],
    }));
    deployRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ecr:GetAuthorizationToken'],
      resources: ['*'],
    }));
    // CDK owns the task definitions; the pipeline only ships a new image and
    // forces a redeploy, so it needs UpdateService but not RegisterTaskDefinition
    // (and therefore no iam:PassRole on the execution role).
    deployRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'ecs:UpdateService',
        'ecs:DescribeServices',
      ],
      resources: ['*'],
    }));

    new cdk.CfnOutput(this, 'GithubDeployRoleArn', { value: deployRole.roleArn });

    // ── GitHub OIDC infra-deploy role (runs `cdk deploy` from CI) ─────────
    // Separate from the app-deploy role above. Rather than broad resource
    // permissions, it may only assume the CDK bootstrap roles; CloudFormation
    // applies the actual changes via the bootstrap cfn-exec role, so the
    // privileged permissions stay inside CFN, not on this GitHub-assumable role.
    // Assumes the default bootstrap qualifier (hnb659fds) — adjust the resource
    // wildcard if you bootstrapped with `--qualifier`.
    const infraDeployRole = new iam.Role(this, 'GithubInfraDeployRole', {
      roleName: `geekway-${envName}-github-infra-deploy`,
      assumedBy: new iam.WebIdentityPrincipal(oidcProvider.openIdConnectProviderArn, {
        StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
        StringLike: { 'token.actions.githubusercontent.com:sub': `repo:${config.githubInfraRepo}:*` },
      }),
    });
    infraDeployRole.addToPolicy(new iam.PolicyStatement({
      actions: ['sts:AssumeRole'],
      resources: [`arn:aws:iam::${this.account}:role/cdk-hnb659fds-*`],
    }));

    new cdk.CfnOutput(this, 'GithubInfraDeployRoleArn', { value: infraDeployRole.roleArn });

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
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: [ecsSg],
        enableExecuteCommand: true,
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

    if (config.secrets.boardgamegeek) {
      const bggSecret = secretsmanager.Secret.fromSecretCompleteArn(
        this, 'BggSecret', config.secrets.boardgamegeek,
      );
      backendSecrets['BOARDGAMEGEEK_API_TOKEN'] =
        ecs.Secret.fromSecretsManager(bggSecret, 'API_TOKEN');
    }

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
        RULESLAWYER_FRONTEND_ORIGIN: config.backend.origins.rulelawyerFrontend,
      },
      secrets: backendSecrets,
      logGroup: '/ecs/ruleslawyer-backend',
      healthCheckPath: '/api',
      pathPatterns: ['/api', '/api/*'],
      priority: 100,
    });

    // ── frontends-admin ───────────────────────────────────────────────────
    const spaSecrets = {
      AUTH_CLIENT_ID: ecs.Secret.fromSecretsManager(auth0ClientIdSecret, 'auth0-client-id'),
    };

    const spaEnv = (authCallback: string, logoutReturnUrl: string) => ({
      AUTH_DOMAIN: 'geekway.auth0.com',
      API_IDENTIFIER: 'https://api.ruleslawyer.geekway.com',
      WEBPACK_MODE: 'production',
      AUTH_CALLBACK: authCallback,
      LOGOUT_RETURN_URL: logoutReturnUrl,
    });

    makeService({
      id: 'Admin',
      serviceName: 'frontends-admin',
      ecrRepo: ecrAdmin,
      containerPort: 80,
      cpu: config.frontendSpa.cpu,
      memoryMiB: config.frontendSpa.memoryMiB,
      environment: spaEnv(
        `https://${config.domainName}/admin/callback`,
        `https://${config.domainName}/admin`,
      ),
      secrets: spaSecrets,
      logGroup: '/ecs/frontends-admin',
      healthCheckPath: '/admin',
      pathPatterns: ['/admin', '/admin/*'],
      priority: 200,
    });

    // ── frontends-librarian ───────────────────────────────────────────────
    makeService({
      id: 'Librarian',
      serviceName: 'frontends-librarian',
      ecrRepo: ecrLibrarian,
      containerPort: 80,
      cpu: config.frontendSpa.cpu,
      memoryMiB: config.frontendSpa.memoryMiB,
      environment: spaEnv(
        `https://${config.domainName}/librarian/callback`,
        `https://${config.domainName}/librarian`,
      ),
      secrets: spaSecrets,
      logGroup: '/ecs/frontends-librarian',
      healthCheckPath: '/librarian',
      pathPatterns: ['/librarian', '/librarian/*'],
      priority: 300,
    });

    // ── frontends-play-and-win ────────────────────────────────────────────
    makeService({
      id: 'PlayAndWin',
      serviceName: 'frontends-play-and-win',
      ecrRepo: ecrPlayAndWin,
      containerPort: 80,
      cpu: config.frontendSpa.cpu,
      memoryMiB: config.frontendSpa.memoryMiB,
      environment: {
        AUTH_DOMAIN: 'geekway.auth0.com',
        API_IDENTIFIER: 'https://api.ruleslawyer.geekway.com',
        WEBPACK_MODE: 'production',
        AUTH_CALLBACK: `https://${config.domainName}/playandwin/callback`,
        // play-prize-entry has no LOGOUT_RETURN_URL
      },
      secrets: spaSecrets,
      logGroup: '/ecs/frontends-play-and-win',
      healthCheckPath: '/playandwin',
      pathPatterns: ['/playandwin', '/playandwin/*'],
      priority: 400,
    });

    // ── ruleslawyer-frontend (Next.js dashboard) ──────────────────────────
    const frontendEnv = config.rulelawyerFrontend;
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
          description: 'Next.js frontend Auth0 secrets — set AUTH0_CLIENT_SECRET post-deploy',
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
      id: 'RulelawyerFrontend',
      serviceName: 'ruleslawyer-frontend',
      ecrRepo: ecrFrontend,
      containerPort: 3000,
      cpu: frontendEnv.cpu,
      memoryMiB: frontendEnv.memoryMiB,
      environment: {
        NODE_ENV: 'production',
        PORT: '3000',
        AUTH0_DOMAIN: 'geekway.auth0.com',
        AUTH0_CLIENT_ID: frontendEnv.auth0ClientId,
        AUTH0_AUDIENCE: 'https://api.ruleslawyer.geekway.com',
        APP_BASE_URL: frontendEnv.appBaseUrl,
        API_URL: frontendEnv.apiUrl,
        NEXT_PUBLIC_API_URL: frontendEnv.apiUrl,
      },
      secrets: frontendSecretEnv,
      logGroup: '/ecs/ruleslawyer-frontend',
      healthCheckPath: '/ruleslawyer',
      pathPatterns: ['/ruleslawyer', '/ruleslawyer/*'],
      priority: 500,
    });
  }
}
