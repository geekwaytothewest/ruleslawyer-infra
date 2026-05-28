import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
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

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);

    const { envName, config } = props;

    // ── VPC ──────────────────────────────────────────────────────────────
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: `geekway-${envName}`,
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
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

    // ── Outputs ───────────────────────────────────────────────────────────
    // Point an external DNS CNAME (config.domainName -> this value) at the ALB
    // to send traffic here. No Route53 record is managed by this stack.
    new cdk.CfnOutput(this, 'AlbDns', { value: this.alb.loadBalancerDnsName });
  }
}
