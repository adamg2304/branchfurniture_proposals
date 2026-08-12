import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  // Do NOT throw at import time. This module is imported during app startup
  // (app.ts → PgRateLimitStore → @workspace/db); throwing here kills the
  // process before it can answer its /api/healthz probe, which the platform
  // reads as an unhealthy boot and SIGTERMs — a crash loop. Instead, boot
  // healthy and let database-backed features (rate limiting, acceptance
  // idempotency) fail at query time. Log loudly so the misconfig is obvious.
  console.warn(
    "[db] DATABASE_URL is not set — database-backed features are unavailable until it is configured.",
  );
}

export const pool = new Pool(
  connectionString ? { connectionString } : {},
);
export const db = drizzle(pool, { schema });

export * from "./schema";
