/**
 * Shape of a Workers Rate Limiting binding. Declared locally rather than
 * relying on the types package so the contract the code depends on is explicit.
 */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export type AttestMode = 'off' | 'optional' | 'required';

/** Bindings declared in wrangler.toml. */
export interface Env {
  DB: D1Database;
  REGISTER_IP_LIMIT: RateLimiter;
  SUBMIT_INSTALLATION_LIMIT: RateLimiter;
  SUBMIT_IP_LIMIT: RateLimiter;
  /** Replies in private conversations, per installation. */
  REPLY_INSTALLATION_LIMIT: RateLimiter;
  /** Vote and follow toggles, per installation. */
  ENGAGE_INSTALLATION_LIMIT: RateLimiter;
  /** App Attest challenge and registration calls, per IP. */
  ATTEST_IP_LIMIT: RateLimiter;
  /** Image uploads, per installation. */
  UPLOAD_INSTALLATION_LIMIT: RateLimiter;
  /** Landing-page contact form, per IP. */
  ENQUIRY_IP_LIMIT: RateLimiter;
  /** Private image attachments. */
  ATTACHMENTS: R2Bucket;
  /** Cloudflare Access team domain, e.g. "myteam.cloudflareaccess.com". */
  ACCESS_TEAM_DOMAIN?: string;
  /** Audience (AUD) tag of the Access application protecting /admin. */
  ACCESS_AUD?: string;
  /** Apple Developer Team ID; App IDs are "<team>.<bundle id>". */
  APPLE_TEAM_ID?: string;
  /** off | optional | required. See wrangler.toml. */
  ATTEST_MODE?: string;
  /** "true" accepts the development / sandbox App Attest environment. */
  ATTEST_ALLOW_DEVELOPMENT?: string;

  // ── Ask (routes/ask.ts). All optional: with no key the routes answer "not set up". ──
  /** Anthropic API key (secret). One key serves every app; spend is capped per app in ask_config. */
  ANTHROPIC_API_KEY?: string;
  /** Overrides https://api.anthropic.com. Used by the local test only. */
  ANTHROPIC_API_BASE?: string;
  /** Secret that authorises publishing knowledge and config from the CLI. Unset: publishing is closed. */
  ASK_PUBLISH_TOKEN?: string;
  /** Secret the test runner sends to skip the limits and logging. Unset: no bypass exists. */
  ASK_EVAL_TOKEN?: string;
  /** Burst limits for Ask, per installation and per IP (web route). Absent in local dev. */
  ASK_INSTALLATION_LIMIT?: RateLimiter;
  ASK_IP_LIMIT?: RateLimiter;
}

export function attestMode(env: Env): AttestMode {
  const value = (env.ATTEST_MODE ?? 'off').trim().toLowerCase();
  return value === 'optional' || value === 'required' ? value : 'off';
}

/** The authenticated caller, resolved from the bearer token by `requireInstallation`. */
export interface Installation {
  id: string;
  appId: string;
  /** True once an App Attest key is bound to this installation. */
  attested: boolean;
}

/** The signed-in developer, resolved from the Access JWT by `requireAdmin`. */
export interface AdminIdentity {
  email: string;
}

/** Hono generic: bindings plus per-request variables. */
export type AppContext = {
  Bindings: Env;
  Variables: {
    installation: Installation;
    /** Set by `optionalInstallation`: the caller if a valid bearer was sent. */
    maybeInstallation: Installation | null;
    admin: AdminIdentity;
  };
};
