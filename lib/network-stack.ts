import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { EnvConfig, EnvName } from './config';

interface NetworkStackProps extends cdk.StackProps {
  envName: EnvName;
  config: EnvConfig;
}

export class NetworkStack extends cdk.Stack {
  readonly vpc: ec2.Vpc;
  readonly albSg: ec2.SecurityGroup;
  readonly ecsSg: ec2.SecurityGroup;
  readonly dbSg: ec2.SecurityGroup;
  readonly alb: elbv2.ApplicationLoadBalancer;
  readonly httpsListener: elbv2.ApplicationListener;
  /** Bucket holding the static SPA bundles (admin/ librarian/ playandwin/ prefixes) */
  readonly spaBucket: s3.Bucket;
  /** CloudFront distribution — the public front door (SPAs from S3, /api & /ruleslawyer from the ALB) */
  readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);

    const { envName, config } = props;

    // ── VPC ──────────────────────────────────────────────────────────────
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: `geekway-${envName}`,
      maxAzs: 2,
      // No NAT gateway (~$33/mo each): ECS tasks run in public subnets with a
      // public IP for egress (ECR / Secrets Manager / CloudWatch / Auth0).
      // Inbound is still gated to the ALB by the ECS security group, so tasks
      // are not reachable from the internet. The DB stays in isolated subnets
      // (no egress at all). Dropping NAT means we no longer need a
      // PRIVATE_WITH_EGRESS tier, so it's removed here.
      natGateways: 0,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 28 },
      ],
    });

    // ── Security Groups ───────────────────────────────────────────────────
    this.albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc: this.vpc,
      securityGroupName: `geekway-${envName}-alb`,
      description: 'ALB: allow inbound HTTP/HTTPS from internet',
    });
    this.albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80));
    this.albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443));

    this.ecsSg = new ec2.SecurityGroup(this, 'EcsSg', {
      vpc: this.vpc,
      securityGroupName: `geekway-${envName}-ecs`,
      description: 'ECS tasks: allow inbound from ALB only',
    });
    this.ecsSg.addIngressRule(this.albSg, ec2.Port.allTcp());

    this.dbSg = new ec2.SecurityGroup(this, 'DbSg', {
      vpc: this.vpc,
      securityGroupName: `geekway-${envName}-db`,
      description: 'RDS: allow Postgres from ECS tasks only',
    });
    this.dbSg.addIngressRule(this.ecsSg, ec2.Port.tcp(5432));
    // Direct Postgres access from specific external IPs (requires the RDS to be
    // publicly accessible — see data-stack). Empty list → no public ingress.
    for (const cidr of config.dbAllowedCidrs ?? []) {
      this.dbSg.addIngressRule(
        ec2.Peer.ipv4(cidr), ec2.Port.tcp(5432), `Direct Postgres access: ${cidr}`,
      );
    }

    // ── ACM Certificate ───────────────────────────────────────────────────
    // geekway.com DNS is hosted off AWS (Squarespace), so the cert is validated
    // by adding the CNAME ACM provides at the external DNS host. The first deploy
    // blocks until that record is in place; ACM auto-renews afterward as long as
    // the validation CNAME stays put.
    const cert = new acm.Certificate(this, 'Cert', {
      domainName: config.domainName,
      validation: acm.CertificateValidation.fromDns(),
    });

    // ── ALB ───────────────────────────────────────────────────────────────
    this.alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      loadBalancerName: `${envName}-alb`,
      vpc: this.vpc,
      internetFacing: true,
      securityGroup: this.albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    // HTTP → HTTPS redirect
    this.alb.addListener('HttpListener', {
      port: 80,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: 'HTTPS',
        port: '443',
        permanent: true,
      }),
    });

    this.httpsListener = this.alb.addListener('HttpsListener', {
      port: 443,
      certificates: [cert],
      // 503 for any unmatched path — each service adds its own rules
      defaultAction: elbv2.ListenerAction.fixedResponse(503, {
        messageBody: 'No route matched',
      }),
    });

    new cdk.CfnOutput(this, 'AlbDns', { value: this.alb.loadBalancerDnsName });

    // ── Static SPA bucket ─────────────────────────────────────────────────
    // The three static SPAs (admin / librarian / play-and-win) are served from
    // S3 instead of always-on Fargate tasks. One private bucket, three prefixes
    // matching each app's webpack publicPath (admin/, librarian/, playandwin/).
    // CloudFront reads it via Origin Access Control; the bucket itself stays
    // fully private. The frontends CI syncs each app's dist/ into its prefix.
    this.spaBucket = new s3.Bucket(this, 'SpaBucket', {
      bucketName: `geekway-${envName}-spa`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // Prod: keep the bucket on stack removal. Nonprod: disposable.
      removalPolicy:
        envName === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: envName !== 'prod',
    });

    // ── SPA deep-link fallback (CloudFront Function) ──────────────────────
    // Replaces nginx `try_files … /index.html`. For an extensionless request
    // under one of the SPA prefixes (e.g. /admin/some/route), rewrite to that
    // prefix's index.html so the SPA router can handle it. Real asset requests
    // (which carry a file extension) pass through untouched.
    //
    // A single deployment serves every convention: the convention is carried in
    // the URL as /org/{id}/con/{id}/<app>[/...], and the app derives its API base
    // and router basename from it at runtime. Those navigations are rewritten to
    // the one /<app>/index.html. Assets are referenced from the absolute /<app>/
    // publicPath, so they arrive as /<app>/... (handled by the bare-prefix logic),
    // never under the /org/.../con/.../ prefix.
    const spaFallback = new cloudfront.Function(this, 'SpaFallbackFn', {
      functionName: `geekway-${envName}-spa-fallback`,
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  var prefixes = ['/admin', '/librarian', '/playandwin'];

  // Convention-scoped deep link: /org/{id}/con/{id}/<app>[/...] -> /<app>/index.html.
  var parts = uri.split('/');
  if (parts.length >= 6 && parts[1] === 'org' && parts[3] === 'con') {
    var app = '/' + parts[5];
    if (prefixes.indexOf(app) !== -1) {
      request.uri = app + '/index.html';
      return request;
    }
  }

  // Bare prefix deep link (e.g. /admin/some/route); defaults to org 1 / con 1.
  for (var i = 0; i < prefixes.length; i++) {
    var p = prefixes[i];
    if (uri === p || uri === p + '/') {
      request.uri = p + '/index.html';
      return request;
    }
    if (uri.startsWith(p + '/') && !uri.split('/').pop().includes('.')) {
      request.uri = p + '/index.html';
      return request;
    }
  }
  return request;
}
`),
    });

    // ── CloudFront distribution (the public front door) ───────────────────
    // Reuses the ACM cert above (us-east-1, valid for CloudFront). SPA prefixes
    // are served from S3; /api and /ruleslawyer (and anything else) forward to
    // the ALB with caching disabled and all viewer headers/cookies passed so
    // auth and the API behave exactly as before.
    const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(this.spaBucket);
    const albOrigin = new origins.LoadBalancerV2Origin(this.alb, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
    });

    const albBehavior: cloudfront.BehaviorOptions = {
      origin: albOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
    };

    const spaBehavior = (): cloudfront.BehaviorOptions => ({
      origin: s3Origin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
      cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      functionAssociations: [{
        function: spaFallback,
        eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
      }],
    });

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `geekway-${envName} front door`,
      certificate: cert,
      domainNames: [config.domainName],
      // Default → ALB, preserving the listener's "no route" 503 for unknown paths.
      defaultBehavior: albBehavior,
      additionalBehaviors: {
        // Convention-scoped SPA paths (/org/{id}/con/{id}/<app>[/...]). Two
        // patterns per app: the bare prefix and its sub-paths (a trailing `/*`
        // does not match the slash-less bare form). The fallback function above
        // rewrites all of these to the single /<app>/index.html.
        '/org/*/con/*/admin': spaBehavior(),
        '/org/*/con/*/admin/*': spaBehavior(),
        '/org/*/con/*/librarian': spaBehavior(),
        '/org/*/con/*/librarian/*': spaBehavior(),
        '/org/*/con/*/playandwin': spaBehavior(),
        '/org/*/con/*/playandwin/*': spaBehavior(),
        // Bare prefixes: static assets (absolute /<app>/ publicPath) and
        // convention-less access (defaults to org 1 / con 1).
        '/admin/*': spaBehavior(),
        '/librarian/*': spaBehavior(),
        '/playandwin/*': spaBehavior(),
        '/api/*': albBehavior,
        '/ruleslawyer/*': albBehavior,
      },
    });

    // ── Outputs ───────────────────────────────────────────────────────────
    // Point the external DNS CNAME (config.domainName) at the CloudFront domain
    // below — NOT the ALB — once the distribution is serving correctly. The ALB
    // stays internet-facing as CloudFront's origin for /api and /ruleslawyer.
    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: this.distribution.distributionDomainName,
      description: 'CNAME target for config.domainName (set at the external DNS host)',
    });
    new cdk.CfnOutput(this, 'DistributionId', { value: this.distribution.distributionId });
    new cdk.CfnOutput(this, 'SpaBucketName', { value: this.spaBucket.bucketName });
  }
}
