export type EnvName = 'nonprod' | 'prod';

/**
 * An entry in `dbAllowedCidrs`: either a bare IPv4 CIDR string, or an object
 * pairing the CIDR with a human label used as the security-group rule description.
 */
export type DbCidrAllow = string | { cidr: string; description?: string };

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
    /** ruleslawyer-frontend Auth0 secrets (AUTH_SECRET/AUTH0_CLIENT_SECRET). Omit → created. */
    frontendSecrets?: string;
    /** BoardGameGeek API token. Omit → backend runs without BGG features. */
    boardgamegeek?: string;
  };
  /**
   * Network posture of the RDS instance. true → public subnets + public endpoint;
   * false → isolated private subnets, reachable only from the ECS tasks.
   * This is a CREATE-TIME decision: flipping it on a live DB changes the subnet
   * group, which forces an RDS *replacement* (a new empty instance). Set it once
   * per env and treat changing it as a deliberate, planned migration. Routine
   * allowlist edits (`dbAllowedCidrs`) do NOT touch this, so they never replace.
   * SECURITY: true exposes the DB endpoint to the internet, gated only by the
   * `dbAllowedCidrs` SG rules + credentials. Prefer a bastion/VPN long-term.
   */
  dbPubliclyAccessible: boolean;
  /**
   * Public IP/CIDR allowlist for direct Postgres (5432) access from outside the
   * VPC (e.g. admin machines running psql/migrations). Drives ONLY the DB security
   * group ingress rules — adding/removing/emptying it is a safe in-place change
   * (no RDS replacement). Has effect only when `dbPubliclyAccessible` is true;
   * with a private DB these external IPs have no route in regardless.
   *
   * Each entry is either a bare IPv4 CIDR string, or `{ cidr, description }` to
   * attach a human label that shows up as the security-group rule description
   * (so you can tell which IP is whose in the console). Examples:
   *   '203.0.113.4/32'
   *   { cidr: '198.51.100.0/24', description: 'office' }
   */
  dbAllowedCidrs?: DbCidrAllow[];
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
    /**
     * CORS allowed origins for each frontend. These are matched by the backend
     * (`cors` pkg) with exact string equality against the browser's `Origin`
     * header, which is scheme + host (+ port) ONLY — never a path. So each value
     * must be a bare origin (no `/admin`, `/ruleslawyer`, etc.). In deployed envs
     * all four collapse to the single env host; they differ only in local dev,
     * where each frontend runs on its own port.
     */
    origins: {
      admin: string;
      librarian: string;
      playAndWin: string;
      ruleslawyerFrontend: string;
    };
  };
  ruleslawyerFrontend: {
    cpu: number;
    memoryMiB: number;
    /** Auth0 SPA client ID (public, baked into the Next.js runtime env) */
    auth0ClientId: string;
    appBaseUrl: string;
    apiUrl: string;
    /**
     * Outbound links from the dashboard to the legacy SPA frontends served from
     * S3 + CloudFront (`/admin`, `/librarian`, `/playandwin`). The dashboard is
     * not yet a full replacement, so it links users back to these for the
     * capabilities it lacks. Map to the LEGACY_* env vars the Next.js app reads.
     */
    legacyAdminUrl: string;
    legacyLibrarianUrl: string;
    legacyPlayPrizeEntryUrl: string;
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
    // DB stays private (isolated subnets) — no external Postgres access.
    dbPubliclyAccessible: false,
    dbAllowedCidrs: [],
    backend: {
      cpu: 256,
      memoryMiB: 512,
      // Smaller range for nonprod; tune as needed.
      autoScaling: { minCapacity: 1, maxCapacity: 2, cpuTargetPercent: 50 },
      origins: {
        admin: 'https://nonprod.library.geekway.com',
        librarian: 'https://nonprod.library.geekway.com',
        playAndWin: 'https://nonprod.library.geekway.com',
        ruleslawyerFrontend: 'https://nonprod.library.geekway.com',
      },
    },
    ruleslawyerFrontend: {
      cpu: 256,
      memoryMiB: 1024,
      auth0ClientId: 'E6PJhdNknPqcVouOfHZ2F2JzTm7LU4z5',
      appBaseUrl: 'https://nonprod.library.geekway.com',
      apiUrl: 'https://nonprod.library.geekway.com/api',
      legacyAdminUrl: 'https://nonprod.library.geekway.com/legacy/admin',
      legacyLibrarianUrl: 'https://nonprod.library.geekway.com/legacy/librarian',
      legacyPlayPrizeEntryUrl: 'https://nonprod.library.geekway.com/legacy/playandwin',
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
    // Greenfield: new sub-account (replaces the old hand-built prod account
    // 328430331417, which is retired post-cutover).
    account: '428265842813',
    region: 'us-east-1',
    clusterName: 'geekway-prod',
    domainName: 'library.geekway.com',
    // No ARNs: CDK creates these secrets fresh in the new account, to be
    // populated after the first deploy (see CUTOVER.md). Re-add a boardgamegeek
    // ARN once that secret exists if the backend needs BGG.
    secrets: {},
    // Public DB endpoint, replicating the existing hand-built prod's direct
    // Postgres access. Posture is fixed here — flipping it later replaces the
    // DB; the allowlist below is the routine, replacement-free knob.
    dbPubliclyAccessible: true,
    dbAllowedCidrs: [
      { cidr: '150.195.142.146/32', description: 'Jeff' },
      { cidr: '67.186.112.175/32', description: 'Mattie Duplex' },
      { cidr: '24.52.164.175/32', description: 'Weef House' }
    ],
    backend: {
      cpu: 256,
      memoryMiB: 1024,
      // Mirrors the existing hand-built prod: CPU target-tracking @ 50%, 1–10 tasks.
      autoScaling: { minCapacity: 1, maxCapacity: 10, cpuTargetPercent: 50 },
      origins: {
        admin: 'https://library.geekway.com',
        librarian: 'https://library.geekway.com',
        playAndWin: 'https://library.geekway.com',
        ruleslawyerFrontend: 'https://library.geekway.com',
      },
    },
    ruleslawyerFrontend: {
      cpu: 256,
      memoryMiB: 1024,
      auth0ClientId: 'vLyWBk9cNfz66zHhDMcpi8BwDdSfycX6',
      appBaseUrl: 'https://library.geekway.com',
      apiUrl: 'https://library.geekway.com/api',
      legacyAdminUrl: 'https://library.geekway.com/legacy/admin',
      legacyLibrarianUrl: 'https://library.geekway.com/legacy/librarian',
      legacyPlayPrizeEntryUrl: 'https://library.geekway.com/legacy/playandwin',
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
