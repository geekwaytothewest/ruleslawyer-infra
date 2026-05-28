export type EnvName = 'nonprod' | 'prod';

export interface EnvConfig {
  account: string;
  region: string;
  clusterName: string;
  /** Primary domain for this environment (e.g. library.geekway.com), pointed at the ALB via external DNS */
  domainName: string;
  /**
   * Secrets Manager references. Convention: an ARN means "import this existing
   * secret" (prod, adopt-existing); omitting it means "CDK creates a placeholder
   * secret to populate after first deploy" (greenfield nonprod).
   */
  secrets: {
    /** DB credentials secret (POSTGRES_HOST/USER/PASSWORD/DATABASE_URL). Omit → created. */
    dbCredentials?: string;
    /** Auth0 SPA client ID secret. Omit → created. */
    auth0ClientId?: string;
    /** ruleslawyer-frontend Auth0 secrets (AUTH_SECRET/AUTH0_CLIENT_SECRET). Omit → created. */
    frontendSecrets?: string;
    /** BoardGameGeek API token. Omit → backend runs without BGG features. */
    boardgamegeek?: string;
  };
  /**
   * Public IP/CIDR allowlist for direct Postgres (5432) access from outside the
   * VPC (e.g. admin machines running psql/migrations). When non-empty, the RDS is
   * made publicly accessible (public subnets + public endpoint) and the DB
   * security group opens 5432 to each CIDR. Empty/omitted → the DB stays in
   * isolated private subnets, reachable only from the ECS tasks.
   * SECURITY: a non-empty list exposes the DB endpoint to the internet, gated
   * only by these SG rules + credentials. Prefer a bastion/VPN long-term.
   */
  dbAllowedCidrs?: string[];
  backend: {
    cpu: number;
    memoryMiB: number;
    /**
     * Application Auto Scaling for the backend ECS service. Omit → no autoscaling
     * (service stays at a fixed single task). When set, CDK registers a scalable
     * target (min/max tasks) plus a CPU target-tracking policy, and stops pinning a
     * fixed desiredCount so a `cdk deploy` doesn't reset the autoscaler's count.
     */
    autoScaling?: {
      minCapacity: number;
      maxCapacity: number;
      /** Target ECSServiceAverageCPUUtilization (%) for the target-tracking policy */
      cpuTargetPercent: number;
    };
    /** CORS allowed origins for each frontend */
    origins: {
      admin: string;
      librarian: string;
      playAndWin: string;
      rulelawyerFrontend: string;
    };
  };
  frontendSpa: {
    cpu: number;
    memoryMiB: number;
  };
  rulelawyerFrontend: {
    cpu: number;
    memoryMiB: number;
    /** Auth0 SPA client ID (public, baked into the Next.js runtime env) */
    auth0ClientId: string;
    appBaseUrl: string;
    apiUrl: string;
  };
  /**
   * Whether the GitHub Actions OIDC provider already exists in this account.
   * true → import it; false → CDK creates it. AWS allows only one provider per
   * account for a given URL, so creating a second one fails with EntityAlreadyExists.
   */
  githubOidcProviderExists: boolean;
  /** GitHub org/repo slugs allowed to assume the app deploy role via OIDC */
  githubRepos: string[];
  /** GitHub org/repo slug allowed to assume the infra (`cdk deploy`) role via OIDC */
  githubInfraRepo: string;
}

export const envConfig: Record<EnvName, EnvConfig> = {
  nonprod: {
    // Greenfield: new sub-account to be created; set its 12-digit ID here.
    account: 'TODO_NONPROD_ACCOUNT_ID',
    region: 'us-east-1',
    clusterName: 'geekway-nonprod',
    domainName: 'nonprod.library.geekway.com',
    // No ARNs: CDK creates these secrets (db credentials, auth0 client id,
    // frontend secrets) for you to populate after the first deploy.
    secrets: {},
    // Direct Postgres access from outside the VPC. Empty → DB stays private.
    dbAllowedCidrs: [],
    backend: {
      cpu: 256,
      memoryMiB: 512,
      // Smaller range for nonprod; tune as needed.
      autoScaling: { minCapacity: 1, maxCapacity: 2, cpuTargetPercent: 50 },
      origins: {
        admin: 'https://nonprod.library.geekway.com/admin',
        librarian: 'https://nonprod.library.geekway.com/librarian',
        playAndWin: 'https://nonprod.library.geekway.com/playandwin',
        rulelawyerFrontend: 'https://nonprod.library.geekway.com/ruleslawyer',
      },
    },
    frontendSpa: { cpu: 256, memoryMiB: 512 },
    rulelawyerFrontend: {
      cpu: 256,
      memoryMiB: 1024,
      auth0ClientId: 'E6PJhdNknPqcVouOfHZ2F2JzTm7LU4z5',
      appBaseUrl: 'https://nonprod.library.geekway.com/ruleslawyer',
      apiUrl: 'https://nonprod.library.geekway.com/api',
    },
    // Fresh account — let CDK create the GitHub OIDC provider.
    githubOidcProviderExists: false,
    githubRepos: [
      'geekwaytothewest/ruleslawyer-backend',
      'geekwaytothewest/frontends',
      'geekwaytothewest/ruleslawyer-frontend',
    ],
    githubInfraRepo: 'geekwaytothewest/ruleslawyer-infra',
  },

  prod: {
    // Greenfield: new sub-account to be created (replaces the old hand-built
    // prod account 328430331417, which is retired post-cutover). Set its ID here.
    account: 'TODO_PROD_ACCOUNT_ID',
    region: 'us-east-1',
    clusterName: 'geekway-prod',
    domainName: 'library.geekway.com',
    // No ARNs: CDK creates these secrets fresh in the new account, to be
    // populated after the first deploy (see CUTOVER.md). Re-add a boardgamegeek
    // ARN once that secret exists if the backend needs BGG.
    secrets: {},
    // Direct Postgres access from outside the VPC — replicates the existing
    // hand-built prod allowlist. TODO: fill with the CIDRs from the current
    // prod DB security group (empty → DB stays private, no public endpoint).
    dbAllowedCidrs: [],
    backend: {
      cpu: 256,
      memoryMiB: 1024,
      // Mirrors the existing hand-built prod: CPU target-tracking @ 50%, 1–10 tasks.
      autoScaling: { minCapacity: 1, maxCapacity: 10, cpuTargetPercent: 50 },
      origins: {
        admin: 'https://library.geekway.com/admin',
        librarian: 'https://library.geekway.com/librarian',
        playAndWin: 'https://library.geekway.com/playandwin',
        rulelawyerFrontend: 'https://library.geekway.com/ruleslawyer',
      },
    },
    frontendSpa: { cpu: 256, memoryMiB: 512 },
    rulelawyerFrontend: {
      cpu: 256,
      memoryMiB: 1024,
      auth0ClientId: 'vLyWBk9cNfz66zHhDMcpi8BwDdSfycX6',
      appBaseUrl: 'https://library.geekway.com/ruleslawyer',
      apiUrl: 'https://library.geekway.com/api',
    },
    // Set true if the prod account already has a GitHub Actions OIDC provider
    // (check: `aws iam list-open-id-connect-providers`). Importing avoids the
    // "provider already exists" failure; false creates it.
    githubOidcProviderExists: false,
    githubRepos: [
      'geekwaytothewest/ruleslawyer-backend',
      'geekwaytothewest/frontends',
      'geekwaytothewest/ruleslawyer-frontend',
    ],
    githubInfraRepo: 'geekwaytothewest/ruleslawyer-infra',
  },
};
