/**
 * GET  /api/d/:dealId  — render the most-recent quote for a HubSpot deal.
 *
 * No token required. The deal ID alone is enough — quotes are looked up
 * server-side and the most recently created one is rendered.  This lets reps
 * share a stable deal-level URL instead of hunting for the quote ID + token.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchQuotePayloadForDeal } from "../lib/hubspot.js";
import { logger } from "../lib/logger.js";

function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value, null, 2)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

const router: IRouter = Router();

const TEMPLATE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "templates",
  "quote-template.html",
);

function injectQuote(html: string, payload: object): string {
  const script = `<script>window.QUOTE = ${safeJsonForScript(payload)};</script>`;
  const replaced = html.replace(
    /[ \t]*<script\s+src=["']quote-sample\.js["']\s*><\/script>/,
    script,
  );
  if (replaced === html) {
    return html.replace("</head>", script + "\n</head>");
  }
  return replaced;
}

router.get("/d/:dealId", async (req: Request, res: Response) => {
  const raw = req.params["dealId"];
  const dealId: string = Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");

  if (!dealId || !/^\d+$/.test(dealId)) {
    res.status(400).send("Invalid deal ID.");
    return;
  }

  if (!process.env["HUBSPOT_PRIVATE_APP_TOKEN"]) {
    logger.error("HUBSPOT_PRIVATE_APP_TOKEN is not set");
    res.status(503).send("Quote service is not configured. Please contact your Branch rep.");
    return;
  }

  try {
    const [template, payload] = await Promise.all([
      readFile(TEMPLATE_PATH, "utf-8"),
      fetchQuotePayloadForDeal(dealId),
    ]);

    const html = injectQuote(template, payload);

    res
      .status(200)
      .setHeader("Content-Type", "text/html; charset=utf-8")
      .setHeader("Cache-Control", "no-store")
      .send(html);
  } catch (err) {
    const hsErr = err as { status?: number; message?: string };

    if (hsErr.status === 404) {
      res.status(404).send("Deal not found. Please contact your Branch rep.");
      return;
    }
    if (hsErr.message === "NO_QUOTES") {
      res.status(404).send("No quotes found for this deal. Please contact your Branch rep.");
      return;
    }

    logger.error({ err, dealId }, "Error fetching quote for deal");
    res.status(500).send("Something went wrong loading the quote. Please try again or contact your Branch rep.");
  }
});

export default router;
