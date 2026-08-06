import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Atomic claim table for quote acceptance.
 *
 * A row is inserted (with quote_id as primary key) before any HubSpot writes
 * or Zapier webhooks are triggered. The unique constraint on quote_id ensures
 * only one concurrent request can "win" the claim. completed_at is set after
 * all side effects succeed; a null completed_at with an old claimed_at means
 * the previous attempt failed — the row is deleted so the signer may retry.
 */
export const quoteAcceptancesTable = pgTable("quote_acceptances", {
  quoteId: text("quote_id").primaryKey(),
  claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  signerName: text("signer_name").notNull(),
  ip: text("ip").notNull(),
});

export type QuoteAcceptance = typeof quoteAcceptancesTable.$inferSelect;
export type InsertQuoteAcceptance = typeof quoteAcceptancesTable.$inferInsert;
