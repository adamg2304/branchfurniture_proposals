import { Router } from "express";
import { config } from "../config.js";
import { verifyHubSpotSignatureV3 } from "../webhooks/verifySignature.js";
import { handleQuoteAcceptedEvent } from "../webhooks/quoteAcceptedHandler.js";
import type { HubSpotWebhookEvent } from "../types.js";

export const webhooksRouter = Router();

// Mounted with express.raw() so req.body is the untouched Buffer needed for
// signature verification — see src/server.ts.
webhooksRouter.post("/hubspot/quotes", async (req, res) => {
  const rawBody = (req.body as Buffer).toString("utf8");

  const isValid = verifyHubSpotSignatureV3({
    method: req.method,
    requestUrl: config.hubspot.webhookTargetUrl,
    rawBody,
    signatureHeader: req.header("X-HubSpot-Signature-v3"),
    timestampHeader: req.header("X-HubSpot-Request-Timestamp"),
    clientSecret: config.hubspot.webhookClientSecret,
  });

  if (!isValid) {
    res.status(401).json({ error: "invalid signature" });
    return;
  }

  // Ack immediately — HubSpot retries on non-2xx/timeout, and we don't want
  // a slow downstream call (Slack, HubSpot writes) to trigger duplicate
  // deliveries for the same event.
  res.status(200).end();

  let events: HubSpotWebhookEvent[];
  try {
    events = JSON.parse(rawBody);
  } catch {
    console.error("Failed to parse HubSpot webhook payload as JSON");
    return;
  }

  for (const event of events) {
    try {
      await handleQuoteAcceptedEvent(event);
    } catch (error) {
      console.error(`Failed to process webhook event ${event.eventId}:`, error);
    }
  }
});
