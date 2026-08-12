/**
 * POST /api/provision
 *
 * Mints (or reuses) the tokenized public quote link on a deal and writes it to
 * the deal's `hub_quote_link` property. Intended to be called by a HubSpot
 * workflow when a deal enters the "Quote Sent" stage, so every deal gets a
 * working branded link automatically.
 *
 * Auth: a shared secret in the `X-Provision-Secret` header or `?secret=` query
 * param must match the PROVISION_SECRET environment variable.
 *
 * Deal id is read flexibly from the request so it works with HubSpot's webhook
 * payload shapes (objectId / hs_object_id) as well as an explicit { dealId }.
 *
 * Response: { ok: true, url, created }  — created=false means an existing link
 * was reused (idempotent re-enrollment).
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { provisionDealQuoteLink } from "../lib/hubspot.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

function suppliedSecret(req: Request): string {
  const header = req.get("x-provision-secret") ?? "";
  const query = typeof req.query["secret"] === "string" ? (req.query["secret"] as string) : "";
  return header || query;
}

function extractDealId(req: Request): string {
  const b = (req.body ?? {}) as Record<string, unknown> & { properties?: Record<string, unknown> };
  const candidate =
    b["dealId"] ??
    b["objectId"] ??
    b["hs_object_id"] ??
    b["objectID"] ??
    b.properties?.["hs_object_id"] ??
    req.query["dealId"];
  return candidate != null ? String(candidate) : "";
}

router.post("/provision", async (req: Request, res: Response) => {
  const secret = process.env["PROVISION_SECRET"];
  if (!secret) {
    logger.error("PROVISION_SECRET is not set");
    res.status(503).json({ error: "Provisioning is not configured." });
    return;
  }
  if (suppliedSecret(req) !== secret) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (!process.env["HUBSPOT_PRIVATE_APP_TOKEN"]) {
    logger.error("HUBSPOT_PRIVATE_APP_TOKEN is not set");
    res.status(503).json({ error: "Quote service is not configured." });
    return;
  }

  const dealId = extractDealId(req);
  if (!/^\d+$/.test(dealId)) {
    res.status(400).json({ error: "Missing or invalid dealId." });
    return;
  }

  const force =
    req.query["force"] === "true" ||
    (req.body as { force?: boolean })?.force === true;

  try {
    const result = await provisionDealQuoteLink(dealId, { force });
    logger.info({ dealId, created: result.created }, "Provisioned deal quote link");
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    logger.error({ err, dealId }, "Failed to provision deal quote link");
    res.status(500).json({ error: "Failed to provision link." });
  }
});

export default router;
