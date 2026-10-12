/**
 * Worker bindings — self-contained types (no @cloudflare/workers-types dep).
 * Apps with extra bindings extend this interface; the package's helpers
 * only ever need these two.
 */
export interface ApiEnv {
  /** Neon Postgres connection string (wrangler secret / .dev.vars). */
  DATABASE_URL: string;
  /** Static assets binding (Workers Static Assets) for SPA fallback. */
  ASSETS: {
    fetch(input: Request | string, init?: RequestInit): Promise<Response>;
  };
}
