# Branch Quote Service — Project State

_Last updated: 2026-08-12_

A dynamic, web-hosted quote proposal for Branch Furniture (B2B office furniture).
It replaces static PDF quotes: it renders a **live** quote from HubSpot at a
tokenized public link, lets the client adjust quantities with live totals, and
captures a **clickwrap e-signature** that writes acceptance back to HubSpot.

- **Repo:** `adamg2304/branchfurniture_proposals` (branch: `main`)
- **HubSpot portal:** `5361087`
- **Runs on:** Replit (pilot). GitHub is the source of truth.

---

## 1. Architecture

The repo is a **pnpm monorepo** (rebuilt by the Replit agent from an earlier
flat prototype). The pieces that matter:

```
artifacts/
  api-server/          Express + TypeScript. THE production service.
    src/
      routes/          quote.ts (render), accept.ts (e-sign), deal.ts, health.ts
      lib/hubspot.ts   ALL HubSpot reads/writes + buildQuotePayload()
      lib/pgRateLimitStore.ts, logger.ts
      templates/quote-template.html   ← CANONICAL quote page (edit this)
  quote-viewer/        Vite app used ONLY as the design preview
    index.html         ← generated copy of the template (do not hand-edit)
    public/quote-sample.js   dev-only window.QUOTE sample data
    public/logos/*     client logos
    public/floorplan-sample.svg   placeholder floorplan for the preview
lib/db/                Drizzle ORM + Postgres (rate limits, acceptance idempotency)
lib/api-spec, api-zod, api-client-react   OpenAPI + generated clients
```

### Single source of truth for the quote page
There is **one** quote page: `artifacts/api-server/src/templates/quote-template.html`.
A `sync-template` script (`quote-viewer` `predev`/`prebuild`) copies it to
`artifacts/quote-viewer/index.html` so the preview always matches production.
**Only ever edit the api-server template**; the viewer copy is generated.

### How a quote renders
- **Production:** `GET /api/q/:slug` (api-server) fetches the deal's live quote +
  line items from HubSpot, builds a `window.QUOTE` object (`buildQuotePayload`
  in `lib/hubspot.ts`), injects it inline into the template, and serves the HTML.
  The browser never calls HubSpot directly.
- **Preview:** the Vite `quote-viewer` serves the same template but loads
  `quote-sample.js` for `window.QUOTE`, so it renders standalone with instant
  refresh (this is what we iterate design against).

### Acceptance flow
Client types name + checks terms + timestamp → clickwrap POST to
`/api/q/:slug/accept` → advances the deal stage and records the audit trail.

---

## 2. Design system

From Branch's brand direction (forest green + vivid blue accent; structural
serif + clean sans):

- **Green:** `--green:#2e4438`, `--green-deep:#1f3128`
- **Accent (interactive):** brand **blue** `--blue/--accent:#3b6ea5` (NOT gold)
- **Grounds:** `--cream:#f5f2ec`, `--paper:#fbfaf7`
- **Caution only:** amber (availability-check banner)
- **Discount highlight:** tan-gold `#c8a86a` (deliberate exception)
- **Type:** **Playfair Display** (headings, weight ~400, Didone editorial serif),
  **Inter** (body). Loaded via Google Fonts.

Structure of the page: branded hero (logo + status chip + info band) → line-item
table → sticky green **"Your investment"** summary rail (the signature element,
Total is the anchor) → **Floorplan** (conditional) → **White Glove** breakdown
(conditional) → collapsible terms → footer + sticky accept bar → brand story,
social-proof/logos, "A better way" comparison, and Branch Remote tiles.

---

## 3. What's built

- **Palette + type**: brand blue accent, Playfair Display + Inter, tuned type
  scale, Total as the signature number.
- **Copy**: em dashes removed from all client-facing copy.
- **Icons**: emoji replaced with consistent inline SVG line icons (comparison
  + Branch Remote tiles).
- **Branch Remote CTA**: "Try Branch Remote Today" → `mailto:hello@branchfurniture.com`
  (subject "Sign me up for Branch Remote").
- **Client logos** ("Trusted by"): Tonal, Casper, SquareFoot, Banza — uniform
  white on the green bar (`brightness(0) invert(1)`), served from
  `quote-viewer/public/logos`. (Tumblr removed — low-res asset.)
- **Line-item pricing**: each row shows **unit price**, **net unit price**
  (list struck when discounted), and the prominent **Net Price** (net unit ×
  qty). Summary discount derives from per-line discounts so it scales with
  quantity changes. Ties to the source quote to the penny.
- **Product thumbnails**: server reads each line item's **`hub_image`** (direct
  URL) → thumbnail, falling back to Shopify `hs_images`. Rendered `contain` on a
  white tile.
- **Column alignment**: fixed-width price column so qty steppers line up across
  rows.
- **White Glove — conditional**: WG summary row, section, and link appear **only
  when the deal has a White Glove Delivery line item** (`hasWhiteGlove`).
- **Floorplan — conditional (V0)**: a "Your space, mapped out" section between
  line items and White Glove, shown **only when the deal has a `floorplan`
  file**. Server resolves the file id → URL via the HubSpot Files API.

---

## 4. HubSpot data model used

| Object | Property | Use |
|---|---|---|
| Quote | `hs_quote_amount` / `hs_tcv` | authoritative total |
| Quote | `hs_quote_number`, `hs_expiration_date`, `hs_createdate` | meta |
| Line item | `price`, `quantity` | unit price, qty |
| Line item | `hs_total_discount` | per-line discount → per-unit `disc = /qty` |
| Line item | `hs_sku` | SKU; `"White Glove Delivery"` marks the WG line |
| Line item | `hub_image` | product thumbnail URL (fallback: `hs_images`) |
| Line item | `hs_url` | Shopify product link |
| Deal | `floorplan` | **file id** of the floorplan → resolved via Files API |
| Deal | `dealstage`, `hubspot_owner_id`, `dealname` | gating, rep, name |
| Contact / Company | name, title, email, city/state | "prepared for" + tax label |

Notes on money math (verified against a real quote, total $17,963.62):
- **Products subtotal** = Σ(price × qty) of non-WG lines.
- **White Glove** = the WG line item's `amount`.
- **Discount** = Σ(`hs_total_discount`) — no reliable quote-level rollup exists.
- **Tax** = `hs_quote_amount − (products + WG − discount)` (HubSpot doesn't
  populate `hs_tax_total`/per-line tax on this portal).

---

## 5. Current state

**Working in the preview:** full page renders on-brand; pricing shows
unit/net-unit/Net-Price and ties out; logos render; the Ergonomic Chair
(`hub_image` for SKU `11-01-00-53`) shows a real product image; the floorplan
section shows a labeled placeholder.

**Separate HubSpot developer project:** `branch-integrations` (portal 5361087)
was created with 60 CRM scopes (sensitive scopes dropped to stay compatible with
serverless functions). This is distinct from the quote-service private-app token
(`HUBSPOT_TOKEN`) the api-server uses.

---

## 6. Open items / dependencies

- **Floorplan (live):** the private-app token needs the **`files`** scope for the
  Files API to resolve `floorplan` file id → URL. The floorplan file's access
  must also be public/anyone-with-link so a signed-out client can load it.
- **PDF floorplans:** current render is an `<img>`. If floorplans are PDFs,
  switch to an embedded viewer or a "View floor plan" button.
- **`hub_image` coverage:** only SKU `11-01-00-53` is populated so far. Populate
  the rest (Shopify image URLs) for full coverage.
- **Logos in production:** they live in `quote-viewer/public/logos`; the
  api-server must serve or inline them for live quotes.
- **Coordination:** the Replit agent has also edited these files — keep it idle
  during design work to avoid merge collisions.
- **Not yet verified end-to-end:** production `/api/q/:slug` render against live
  HubSpot, the e-signature acceptance write-back, and the live floorplan.

---

## 7. Working conventions

- Edit only `artifacts/api-server/src/templates/quote-template.html`, then
  regenerate the preview: `pnpm --filter @workspace/quote-viewer run sync-template`
  (also runs automatically on the viewer's dev start).
- Design iteration loop: edit → pull in Replit → refresh the "Branch Quote
  Viewer" webview → react.
- Run/typecheck: `pnpm run typecheck`, `pnpm run build`,
  `pnpm --filter @workspace/api-server run dev` (port 5000).
