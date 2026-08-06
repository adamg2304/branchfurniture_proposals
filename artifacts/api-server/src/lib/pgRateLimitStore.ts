/**
 * PostgreSQL-backed store for express-rate-limit.
 *
 * Uses the shared database pool so rate-limit counters are consistent across
 * all autoscaled API server instances. Each (route-prefix + IP) pair maps to
 * one row keyed by `key`. The upsert handles window resets atomically: when a
 * stored window has expired the row is reset to 1 hit rather than incremented.
 *
 * The store implements the express-rate-limit v7 Store interface.
 */

import type { Store, ClientRateLimitInfo } from "express-rate-limit";
import { pool } from "@workspace/db";

export class PgRateLimitStore implements Store {
  private readonly windowMs: number;
  private readonly prefix: string;

  /**
   * @param windowMs  Rate-limit window in milliseconds.
   * @param prefix    Route identifier prepended to every key so that
   *                  distinct limiters (fetch vs. accept) do not share counters.
   */
  constructor(windowMs: number, prefix: string) {
    this.windowMs = windowMs;
    this.prefix = prefix;
  }

  private prefixedKey(key: string): string {
    return `${this.prefix}:${key}`;
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const pKey = this.prefixedKey(key);
    const windowMs = this.windowMs;
    const result = await pool.query<{ hits: number; reset_time: Date }>(
      `INSERT INTO rate_limits (key, hits, reset_time)
       VALUES ($1, 1, NOW() + ($2 || ' milliseconds')::interval)
       ON CONFLICT (key) DO UPDATE
         SET
           hits       = CASE
                          WHEN rate_limits.reset_time < NOW() THEN 1
                          ELSE rate_limits.hits + 1
                        END,
           reset_time = CASE
                          WHEN rate_limits.reset_time < NOW()
                          THEN NOW() + ($2 || ' milliseconds')::interval
                          ELSE rate_limits.reset_time
                        END
       RETURNING hits, reset_time`,
      [pKey, windowMs],
    );
    const row = result.rows[0]!;
    return { totalHits: row.hits, resetTime: row.reset_time };
  }

  async decrement(key: string): Promise<void> {
    await pool.query(
      `UPDATE rate_limits SET hits = GREATEST(hits - 1, 0) WHERE key = $1`,
      [this.prefixedKey(key)],
    );
  }

  async resetKey(key: string): Promise<void> {
    await pool.query(`DELETE FROM rate_limits WHERE key = $1`, [this.prefixedKey(key)]);
  }
}
