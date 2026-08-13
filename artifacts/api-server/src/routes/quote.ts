/**
 * GET  /api/q/:slug          — serve the quote page (HTML)
 *   slug format: {dealId}-{token}
 *   dealId is a numeric HubSpot deal ID; token is everything after the first hyphen.
 *
 * The quote is rendered directly from the DEAL and its line items (no native
 * HubSpot Quote object). The token is validated against the value embedded in
 * the deal's own `hub_quote_link`.
 *
 * The handler:
 *   1. Parses dealId + token from the slug
 *   2. Fetches the deal + line items from HubSpot and validates the token
 *   3. Builds window.QUOTE (same shape as quote-sample.js)
 *   4. Injects it inline into the HTML template (replaces the <script src="quote-sample.js"> line)
 *   5. Serves the resulting HTML — the browser never calls HubSpot
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { fetchDealQuote, TokenMismatchError, type QuotePayload } from "../lib/hubspot.js";
import { logger } from "../lib/logger.js";
import { db, quoteAcceptancesTable } from "@workspace/db";

/**
 * If a quote was accepted via the portal but a line item has been modified in
 * HubSpot since (edited/added), flip it out of the accepted state and flag it
 * so the client shows a re-accept prompt. Best-effort — never blocks rendering.
 */
async function applyReacceptCheck(dealId: string, payload: QuotePayload): Promise<void> {
  try {
    if (!payload.meta.itemsUpdated) return;
    const rows = await db
      .select()
      .from(quoteAcceptancesTable)
      .where(eq(quoteAcceptancesTable.quoteId, dealId))
      .limit(1);
    const completedAt = rows[0]?.completedAt;
    if (!completedAt) return;
    const changed = new Date(payload.meta.itemsUpdated).getTime() > new Date(completedAt).getTime();
    if (changed) {
      payload.accepted = false;
      payload.changedSinceAcceptance = true;
    } else {
      payload.accepted = true;
    }
  } catch (err) {
    logger.warn({ err, dealId }, "Re-accept check skipped (DB unavailable)");
  }
}

/**
 * Serialize a value to JSON that is safe to embed inside an HTML <script> block.
 *
 * JSON.stringify alone is NOT sufficient: a string value containing </script>
 * will close the script tag and allow injected HTML/JS.  We escape the five
 * characters that are meaningful inside script context:
 *   <   → \u003c
 *   >   → \u003e
 *   &   → \u0026
 *   U+2028 (line separator)   → \u2028
 *   U+2029 (paragraph sep)    → \u2029
 *
 * These are all valid JSON escape sequences — parsers accept them fine.
 */
function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value, null, 2)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

const router: IRouter = Router();

// Template is copied to dist/templates/ by the build script.
// At runtime __dirname points to the dist/ directory.
const TEMPLATE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "templates",
  "quote-template.html",
);

/** Replace the dev-only <script src="quote-sample.js"> with the real payload. */
function injectQuote(html: string, payload: QuotePayload): string {
  const script = `<script>window.QUOTE = ${safeJsonForScript(payload)};</script>`;
  // Replace the injection-point line (handles any whitespace around it)
  const replaced = html.replace(
    /[ \t]*<script\s+src=["']quote-sample\.js["']\s*><\/script>/,
    script,
  );
  if (replaced === html) {
    // Fallback: the injection marker comment block + script tag
    logger.warn("quote-sample.js script tag not found in template; injecting before </head>");
    return html.replace("</head>", script + "\n</head>");
  }
  return replaced;
}

router.get("/q/:slug", async (req: Request, res: Response) => {
  // Normalize: Express params can technically be string | string[]; always use first value.
  const rawSlug = req.params["slug"];
  const slug: string = Array.isArray(rawSlug) ? (rawSlug[0] ?? "") : (rawSlug ?? "");

  // slug = "{dealId}-{token}"  — dealId is always numeric, so split on first hyphen
  const dashIdx = slug.indexOf("-");
  if (dashIdx < 1) {
    res.status(400).send("Invalid quote link.");
    return;
  }
  const dealId: string = slug.slice(0, dashIdx);
  const urlToken: string = slug.slice(dashIdx + 1);

  if (!dealId || !urlToken) {
    res.status(400).send("Invalid quote link.");
    return;
  }

  // Reject if HubSpot is not configured rather than silently returning garbage
  if (!process.env["HUBSPOT_PRIVATE_APP_TOKEN"]) {
    logger.error("HUBSPOT_PRIVATE_APP_TOKEN is not set");
    res.status(503).send("Quote service is not configured. Please contact your Branch rep.");
    return;
  }

  try {
    const [template, payload] = await Promise.all([
      readFile(TEMPLATE_PATH, "utf-8"),
      fetchDealQuote(dealId, urlToken),
    ]);

    await applyReacceptCheck(dealId, payload);
    const html = injectQuote(template, payload);

    res
      .status(200)
      .setHeader("Content-Type", "text/html; charset=utf-8")
      // No caching — quote data must always be fresh
      .setHeader("Cache-Control", "no-store")
      .send(html);
  } catch (err) {
    if (err instanceof TokenMismatchError) {
      logger.warn({ dealId }, "Token mismatch for quote");
      res.status(403).send("This quote link is invalid or has expired. Please contact your Branch rep.");
      return;
    }

    const hsErr = err as { status?: number };
    if (hsErr.status === 404) {
      logger.warn({ dealId }, "Deal not found in HubSpot");
      res.status(404).send("Quote not found. Please contact your Branch rep.");
      return;
    }

    logger.error({ err, dealId }, "Error fetching quote");
    res.status(500).send("Something went wrong loading your quote. Please try again or contact your Branch rep.");
  }
});

export default router;
