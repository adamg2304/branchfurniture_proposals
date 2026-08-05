"use strict";

const crypto = require("crypto");
const express = require("express");
const config = require("./config");
const hubspot = require("./hubspot");
const tokens = require("./tokens");
const render = require("./render");
const { handleAccept } = require("./accept");

const app = express();
app.use(express.json());
app.set("trust proxy", true); // so req.ip reflects the real client behind Replit's proxy

// --- Health check ---
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

function secretsMatch(a, b) {
  const bufA = Buffer.from(String(a || ""));
  const bufB = Buffer.from(String(b || ""));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * 1) CREATE LINK — called by the HubSpot "Quote Ready" workflow webhook when a
 *    deal enters stage 1523817. Mints (or reuses) a token and writes the link
 *    back onto the deal's hub_quote_link property. Idempotent.
 *
 *    Body: { dealId, secret }  (secret must match GENERATE_WEBHOOK_SECRET)
 */
app.post("/generate-link", async (req, res) => {
  try {
    const { dealId, secret } = req.body || {};
    if (!config.generateWebhookSecret || !secretsMatch(secret, config.generateWebhookSecret)) {
      return res.status(401).json({ error: "unauthorized" });
    }
    if (!dealId) return res.status(400).json({ error: "dealId required" });

    const token = tokens.getOrCreateTokenForDeal(dealId);
    const link = tokens.buildLink(token);
    await hubspot.writeQuoteLink(dealId, link);

    return res.json({ ok: true, link });
  } catch (err) {
    console.error("[/generate-link]", err.message);
    return res.status(500).json({ error: "internal_error" });
  }
});

/**
 * 2) RENDER QUOTE — the public tokenized link the client opens.
 *    Renders LIVE from HubSpot every load. Gated on the deal being in one of the
 *    six render stages; otherwise shows the inactive page. If the deal is in the
 *    accepted stage (1492994), renders in accepted (post-signature) state.
 */
app.get("/q/:token", async (req, res) => {
  try {
    const dealId = tokens.resolveToken(req.params.token);
    if (!dealId) return res.status(404).send(render.renderInactivePage());

    const deal = await hubspot.getDeal(dealId);
    const stage = deal?.properties?.dealstage;

    if (!config.renderStages.includes(stage)) {
      return res.status(200).send(render.renderInactivePage());
    }

    const quote = await hubspot.getQuoteForDeal(dealId);
    if (!quote) return res.status(200).send(render.renderInactivePage());

    const [lineItems, contact, company] = await Promise.all([
      hubspot.getLineItemsForQuote(quote.id),
      hubspot.getPrimaryContactForDeal(dealId),
      hubspot.getPrimaryCompanyForDeal(dealId),
    ]);
    const owner = await hubspot.getOwner(deal.properties.hubspot_owner_id);

    const payload = render.buildQuotePayload({
      deal,
      quote,
      lineItems,
      contact,
      company,
      owner,
      token: req.params.token,
      accepted: config.acceptedStates.includes(stage),
    });

    res.set("Cache-Control", "no-store"); // always live
    return res.status(200).send(render.renderQuotePage(payload));
  } catch (err) {
    console.error("[/q/:token]", err.message);
    return res.status(500).send(render.renderInactivePage());
  }
});

/**
 * 3) ACCEPT — clickwrap submission from the page. Validates the deal is still in
 *    a render stage (can't accept an inactive quote), records the audit trail,
 *    and fires the Zapier webhook that advances the deal to 1492994.
 */
app.post("/q/:token/accept", async (req, res) => {
  try {
    const dealId = tokens.resolveToken(req.params.token);
    if (!dealId) return res.status(404).json({ error: "unknown_link" });

    const deal = await hubspot.getDeal(dealId);
    const stage = deal?.properties?.dealstage;
    if (!config.renderStages.includes(stage)) {
      return res.status(409).json({ error: "quote_not_active" });
    }
    if (config.acceptedStates.includes(stage)) {
      return res.status(409).json({ error: "already_accepted" });
    }

    await handleAccept({
      dealId,
      body: req.body,
      ip: req.ip,
      userAgent: req.get("user-agent") || "",
    });

    return res.json({ ok: true });
  } catch (err) {
    const code = err.statusCode || 500;
    console.error("[/q/:token/accept]", err.message);
    return res.status(code).json({ error: code === 400 ? err.message : "internal_error" });
  }
});

app.listen(config.port, () => {
  console.log(`Branch quote service listening on :${config.port}`);
});
