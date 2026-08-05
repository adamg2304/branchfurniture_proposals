# Threat Model

## Project Overview

A Node.js/Express API server (Express 5, TypeScript, PostgreSQL + Drizzle ORM) that powers a B2B quote-delivery and acceptance portal for Branch Furniture. A sales rep creates a quote in HubSpot; the server fetches deal → quote → line items and serves an interactive HTML page to the customer. The customer can review, optionally adjust quantities, and digitally accept the quote. Acceptance writes an audit note to HubSpot and fires a Zapier webhook.

Deployed publicly on Replit Autoscale (`https://cloud-quote-link.replit.app`).

## Assets

- **HubSpot CRM data** — deal records, contact PII (name, email, company, job title, city, state), quote financials (totals, line items, pricing), and rep identity. Compromise allows disclosure of business-sensitive pricing and customer PII.
- **HUBSPOT_PRIVATE_APP_TOKEN** — server-side secret that authorizes all HubSpot API operations. Exposure would allow an attacker to read/write any HubSpot object.
- **Quote link tokens (`quote_link_token`)** — unguessable tokens embedded in quote URLs and in `window.QUOTE.meta.token` in served HTML pages. These tokens gate both quote viewing and acceptance.
- **Acceptance audit trail** — HubSpot notes recording signer name, IP, user-agent, timestamp, total, and line items. Used as legal evidence of contract acceptance.
- **ZAPIER_WEBHOOK_URL** — downstream automation trigger; a replay could cause duplicate order creation.

## Trust Boundaries

- **Browser → API** — all quote-page renders and acceptance submissions cross this boundary. The `quote_link_token` is the sole credential; it is embedded in served HTML and extractable by any script running in the browser.
- **API → HubSpot CRM** — server calls HubSpot with a private app token. The server must never expose this token to clients or logs.
- **API → Zapier** — one-way webhook; the server pushes event data. Zapier has no shared secret to verify the caller.
- **Public (unauthenticated) / Token-gated** — all routes are public; the only access barrier is the quote_link_token embedded in the URL slug.

## Scan Anchors

- **Production entry points:** `artifacts/api-server/src/routes/` — `quote.ts` (GET /api/q/:slug), `accept.ts` (POST /api/q/:quoteId/accept), `health.ts` (GET /api/healthz)
- **Highest-risk code areas:** `artifacts/api-server/src/lib/hubspot.ts` (HubSpot API client, token validation, write-back), `artifacts/api-server/src/routes/accept.ts` (acceptance handler, audit trail construction)
- **Public surface:** all three routes are unauthenticated at the HTTP layer; token validation is the only control
- **Dev-only:** `artifacts/mockup-sandbox/` (Canvas/design tool, served at `/__mockup`), `artifacts/quote-viewer/public/quote-sample.js` (dev fixture)
- **No user authentication, no sessions, no admin panel**

## Threat Categories

### Spoofing

The only authentication mechanism is the `quote_link_token` stored in HubSpot and embedded in the URL slug. The server validates it server-side against the stored value before serving quote data or recording acceptance. The token comparison is string equality (not constant-time), which is a theoretical timing-attack concern over the internet but generally impractical. There is no replay protection: a token remains valid after acceptance, allowing the acceptance endpoint to be called repeatedly.

**Required guarantee:** The acceptance endpoint MUST check the current `hs_status` of the quote before writing and reject already-accepted quotes.

### Tampering

The acceptance note is constructed from client-supplied values (`total`, `lineItems`, `signedAt`, `availabilityCheck`). Only the `token` is validated server-side. A signer with a valid token can craft an acceptance POST with fabricated financial figures and a forged timestamp. The server records whatever the client sends.

**Required guarantee:** Server MUST re-fetch authoritative quote data from HubSpot after token validation and use server-computed values in the audit note. `signedAt` MUST be set server-side.

### Information Disclosure

HubSpot error response bodies (which may include deal IDs, object properties, or API error details) are logged with `logger.warn`. Logging is server-side only and not exposed to clients. The quote payload (`window.QUOTE`) is embedded inline in served HTML and includes customer PII (name, email, company, job title), deal ID, and quote financials — intentional by design, scoped to token-holders only.

The sample fixture `artifacts/quote-viewer/public/quote-sample.js` contains what appear to be real-person identifiers (name, email, phone), deployed as a public static asset in the dev viewer. Its production reachability depends on whether the quote-viewer frontend is deployed; if so, this PII is world-readable.

### Denial of Service

No rate limiting exists on any endpoint. The `GET /api/q/:slug` endpoint triggers multiple sequential and parallel HubSpot API calls (5–6 round trips). An unauthenticated attacker can abuse this to exhaust HubSpot API rate limits or inflate HubSpot API usage costs by flooding the endpoint with valid or invalid slugs. The `POST /api/q/:quoteId/accept` endpoint similarly has no throttle.

**Required guarantee:** Per-IP and per-`quoteId` rate limiting MUST be applied to both endpoints.

### Elevation of Privilege

The client-supplied `dealId` in the accept body is intentionally ignored for writes; the server derives `dealId` from HubSpot's deal associations. This is a correct design that prevents confused-deputy attacks. No privilege escalation vector was identified in write paths.

CORS is configured as `app.use(cors())` with no options, which defaults to `Access-Control-Allow-Origin: *` on all routes including the mutation endpoint. This removes the browser's same-origin restriction and allows cross-origin sites to call the accept endpoint with a known token.
