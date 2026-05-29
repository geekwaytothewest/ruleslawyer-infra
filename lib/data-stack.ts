import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { EnvConfig, EnvName } from './config';

interface DataStackProps extends cdk.StackProps {
  envName: EnvName;
  config: EnvConfig;
  vpc: ec2.Vpc;
  dbSg: ec2.SecurityGroup;
}

export class DataStack extends cdk.Stack {
  /** The Secrets Manager secret holding DB credentials — passed to services that need it */
  readonly dbSecret: secretsmanager.ISecret;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    const { envName, config, vpc, dbSg } = props;

    // ── DB credentials secret ─────────────────────────────────────────────
    // Prod: import the existing secret by ARN.
    // Greenfield: create a placeholder with the key shape the backend needs
    // (Prisma reads DATABASE_URL). POSTGRES_PASSWORD is generated; POSTGRES_HOST
    // and DATABASE_URL must be filled in after the RDS endpoint exists.
    if (config.secrets.dbCredentials) {
      this.dbSecret = secretsmanager.Secret.fromSecretCompleteArn(
        this, 'DbCredentials', config.secrets.dbCredentials,
      );
    } else {
      this.dbSecret = new secretsmanager.Secret(this, 'DbCredentials', {
        secretName: `geekway-${envName}-db-credentials`,
        description: 'Backend DB connection — populate POSTGRES_HOST/DATABASE_URL post-deploy',
        generateSecretString: {
          secretStringTemplate: JSON.stringify({ POSTGRES_USER: 'geekway', POSTGRES_HOST: '', DATABASE_URL: '' }),
          generateStringKey: 'POSTGRES_PASSWORD',
          excludePunctuation: true,
        },
      });
    }

    // ── RDS Postgres ──────────────────────────────────────────────────────
    // Postgres 14.x to match the Docker Compose dev setup.
    // Instance class: t3.micro for nonprod, t3.small for prod.
    // Adjust storage and instance class to match your existing RDS instance.
    const instanceType =
      envName === 'prod'
        ? ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL)
        : ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO);

    // Network posture is an explicit, create-time decision (see config). The DB
    // allowlist (config.dbAllowedCidrs) only drives SG rules in the network stack,
    // so editing it never changes the subnet group / forces an RDS replacement.
    const dbPubliclyAccessible = config.dbPubliclyAccessible;

    const db = new rds.DatabaseInstance(this, 'Postgres', {
      instanceIdentifier: `geekway-${envName}`,
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_14,
      }),
      instanceType,
      // The dataset is tiny (~25MB backup), so provision the RDS minimum (20 GiB)
      // rather than the CDK default of 100 GiB — storage is billed on the
      // provisioned size, not usage. gp3 over the default gp2: cheaper per GB and
      // decouples IOPS from size. NOTE: this only applies cleanly to a fresh
      // instance — RDS does not allow *shrinking* allocated storage on a live DB.
      allocatedStorage: 20,
      storageType: rds.StorageType.GP3,
      vpc,
      vpcSubnets: {
        subnetType: dbPubliclyAccessible
          ? ec2.SubnetType.PUBLIC
          : ec2.SubnetType.PRIVATE_ISOLATED,
      },
      publiclyAccessible: dbPubliclyAccessible,
      securityGroups: [dbSg],
      // Prod: the instance's master credentials live in the imported secret.
      // Greenfield: let RDS generate and manage its own master credentials
      // (the app-facing dbSecret placeholder is populated to point at it).
      credentials: config.secrets.dbCredentials
        ? rds.Credentials.fromSecret(this.dbSecret)
        : rds.Credentials.fromGeneratedSecret('geekway'),
      databaseName: 'geekway',
      // Single-AZ in both envs to halve the RDS instance + storage cost. The
      // automated backups (7-day prod / 1-day nonprod) cover recovery; we accept
      // a few minutes of restore-style downtime on an instance failure as a
      // deliberate cost trade for a non-critical app. Flip to true if uptime
      // SLAs ever demand synchronous standby.
      multiAz: false,
      storageEncrypted: true,
      deletionProtection: envName === 'prod',
      backupRetention: envName === 'prod' ? cdk.Duration.days(7) : cdk.Duration.days(1),
      // Prevent accidental replacement — keep a snapshot on removal
      removalPolicy:
        envName === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.SNAPSHOT,
    });

    new cdk.CfnOutput(this, 'DbEndpoint', { value: db.instanceEndpoint.hostname });
  }
}
