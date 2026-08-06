import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";

/**
 * Shared rate-limit counters for all API server instances.
 *
 * Each row represents one (route-prefix + IP) key within an active window.
 * The upsert logic in PgRateLimitStore handles window resets atomically so
 * stale rows are reused rather than accumulating.
 */
export const rateLimitsTable = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  hits: integer("hits").notNull().default(1),
  resetTime: timestamp("reset_time", { withTimezone: true }).notNull(),
});

export type RateLimit = typeof rateLimitsTable.$inferSelect;
