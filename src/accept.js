"use strict";

const config = require("./config");

/**
 * Handles a clickwrap acceptance: name typed + terms checkbox + timestamp,
 * with IP and user-agent captured server-side for the audit trail. Fires the
 * Zapier webhook, which advances the deal to the accepted stage (1492994) and
 * writes the audit note in HubSpot.
 *
 * Isolated so the "what happens on accept" logic can change (or move to a direct
 * HubSpot write) without touching routes.
 */

async function handleAccept({ dealId, body, ip, userAgent }) {
  const name = (body?.signature?.name || "").trim();
  const agreed = !!body?.signature?.agreed;

  if (name.length < 2 || !agreed) {
    const err = new Error("Signature requires a typed name and agreement to terms.");
    err.statusCode = 400;
    throw err;
  }

  const payload = {
    dealId: String(dealId),
    acceptedStage: config.acceptedStage,   // 1492994 — Zapier moves the deal here
    total: body?.total ?? null,
    lineItems: body?.lineItems || [],
    availabilityCheck: !!body?.availabilityCheck,
    signature: {
      name,
      agreed,
      signedAt: body?.signature?.signedAt || new Date().toISOString(),
      ip,
      userAgent,
    },
  };

  if (!config.acceptWebhookUrl) {
    // Don't hard-fail the client if the webhook isn't configured yet in the
    // pilot — record it in logs so acceptance isn't silently lost.
    console.error("[accept] ACCEPT_WEBHOOK_URL not set — acceptance NOT sent to HubSpot:", payload);
    return { forwarded: false };
  }

  const res = await fetch(config.acceptWebhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Accept webhook failed ${res.status}: ${text}`);
  }
  return { forwarded: true };
}

module.exports = { handleAccept };
