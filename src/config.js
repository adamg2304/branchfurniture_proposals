"use strict";

/**
 * All configuration comes from environment variables (Replit Secrets).
 * Nothing secret or host-specific is hardcoded — this is what keeps the
 * eventual move off Replit an afternoon instead of a rewrite.
 *
 * Required secrets (set these in Replit → Tools → Secrets):
 *   HUBSPOT_TOKEN         Private App token, scopes: crm.objects.deals read/write,
 *                         crm.objects.quotes read, crm.objects.line_items read,
 *                         crm.objects.contacts read, crm.objects.companies read,
 *                         crm.objects.owners read
 *   HUBSPOT_PORTAL_ID     5361087
 *   PUBLIC_BASE_URL       e.g. https://quotes.branchfurniture.com (or the Replit URL)
 *   ACCEPT_WEBHOOK_URL    Zapier catch hook that advances the deal to the accepted stage
 *   GENERATE_WEBHOOK_SECRET  shared secret HubSpot's "Quote Ready" workflow sends,
 *                            so /generate-link can't be called by strangers
 */

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.warn(`[config] WARNING: env var ${name} is not set`);
  }
  return v || "";
}

module.exports = {
  port: process.env.PORT || 3000,

  hubspot: {
    token: required("HUBSPOT_TOKEN"),
    portalId: process.env.HUBSPOT_PORTAL_ID || "5361087",
    baseUrl: "https://api.hubapi.com",
    // The custom deal property that holds the finished tokenized link.
    quoteLinkProperty: process.env.HUBSPOT_QUOTE_LINK_PROPERTY || "hub_quote_link",
  },

  publicBaseUrl: (required("PUBLIC_BASE_URL") || "").replace(/\/$/, ""),

  // Fired FROM this service TO Zapier when a client accepts. Zapier advances
  // the deal stage in HubSpot and writes the audit note.
  acceptWebhookUrl: required("ACCEPT_WEBHOOK_URL"),

  // Shared secret the HubSpot "Quote Ready" workflow includes when it calls
  // /generate-link, so the endpoint isn't openly callable.
  generateWebhookSecret: required("GENERATE_WEBHOOK_SECRET"),

  // ---- Deal-stage gating (from the pipeline config) ----
  // The quote renders live ONLY while the deal is in one of these stages.
  // Outside them, the link shows a neutral "no longer active" state.
  renderStages: [
    "1523817",              // Quote Ready (link is created here)
    "presentationscheduled",
    "decisionmakerboughtin",
    "1492995",
    "1492996",
    "1492994",              // Quote Accepted (still renders, shows accepted state)
  ],

  // The stage a deal is IN when a quote is first ready — the create-link trigger.
  quoteReadyStage: "1523817",

  // The stage the deal moves to on acceptance. The service sends this to Zapier;
  // Zapier performs the actual stage write in HubSpot.
  acceptedStage: "1492994",

  // Stages that represent "already accepted or later". In any of these the page
  // renders the accepted (post-signature) state — quote still shows, but the
  // accept button is replaced with a confirmation and re-acceptance is blocked.
  // 1492994 = Quote Accepted; 1492995 / 1492996 are downstream of acceptance.
  acceptedStates: ["1492994", "1492995", "1492996"],

  // Token settings
  tokenBytes: 24,          // 24 bytes → 32-char base64url, unguessable
};
