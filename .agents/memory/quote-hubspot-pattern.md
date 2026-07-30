---
name: Quote route + HubSpot fetch pattern
description: How the GET /api/q/:slug route works and the HubSpot API call chain it uses.
---

## Rule
Route is `GET /api/q/:slug` where slug = `{quoteId}-{token}`. Split on the **first** hyphen: everything before = numeric HubSpot quoteId, everything after = token.

## HubSpot call chain
1. Fetch quote by ID with `quote_link_token` property → validate token matches URL token (403 if not).
2. In parallel: get line-item associations + deal associations from the quote (v4 assoc API).
3. In parallel: batch-read line items + fetch deal (v3 objects).
4. From deal: in parallel get contact associations + company associations.
5. In parallel: batch-read contact + company + fetch owner by ownerId.

**Why:** Single-fetch v4 associations pattern keeps round-trips minimal; mirrors the "same v4 associations single-fetch used for the QBO estimate flow" in the project README.

## Token validation
Custom HubSpot quote property: `quote_link_token`. Must be set on the quote in HubSpot before a URL is shared. If missing or mismatched → always 403 (never skip validation).

## Secret
`HUBSPOT_PRIVATE_APP_TOKEN` env var (Replit Secret / Secret Manager in Cloud Run). If not set, route returns 503 immediately.

## Template injection
Reads `dist/templates/quote-template.html` at runtime. Replaces `<script src="quote-sample.js"></script>` with inline `<script>window.QUOTE = {...};</script>`. Template copied to dist by build.mjs using `cp()` before esbuild runs.

## How to apply
Any change to the quote HTML template requires rebuilding the api-server (build.mjs copies src/templates → dist/templates). The template is NOT bundled by esbuild; it's a raw file copy.
