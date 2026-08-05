# Branch Quote Service (MVP)

A standalone service that renders a live Branch quote from HubSpot at a tokenized
public URL, with clickwrap e-signature. Built to run on Replit for the pilot;
structured so the eventual move to the Hub is a redeploy, not a rewrite.

## How it works

- **Link is created once** when a deal enters the **Quote Ready** stage (`1523817`).
  A HubSpot workflow calls `POST /generate-link`; the service mints an unguessable
  token, stores token↔dealId, and writes the finished link to the deal's
  `hub_quote_link` property. Re-triggering returns the same link (idempotent).
- **The link renders live.** Every time the client opens it, the service fetches
  the deal's *current* quote + line items from HubSpot and renders them. There is
  no cached copy — rep edits to line items show up automatically on next open.
- **Stage gates visibility.** The quote renders only while the deal is in one of
  the six render stages: `1523817`, `presentationscheduled`, `decisionmakerboughtin`,
  `1492995`, `1492996`, `1492994`. Outside them, the link shows a neutral
  "no longer active" page.
- **Acceptance** (name typed + terms checkbox + timestamp) fires a webhook to
  Zapier, which advances the deal to **Quote Accepted** (`1492994`) and writes the
  audit note. In any accepted-or-later stage (`1492994`, `1492995`, `1492996`) the
  page still renders but shows an "Accepted" confirmation instead of a live button,
  and re-acceptance is blocked. The button is live only in the three pre-acceptance
  stages: `1523817`, `presentationscheduled`, `decisionmakerboughtin`.

White Glove is a real HubSpot line item (`hs_sku` = "White Glove Delivery"). The
server pulls it out of the line-item list and shows it as its own summary row
(matching the template's layout) instead of rendering it alongside the furniture.

## Files

```
src/config.js    env + stage IDs (the only place config lives)
src/tokens.js    mint / resolve / store tokens (file-backed; swap for Airtable later)
src/hubspot.js   all HubSpot reads/writes (isolated for portability)
src/render.js    builds window.QUOTE from live data, injects into the template
src/accept.js    clickwrap validation + Zapier webhook (audit trail)
src/server.js    the 3 routes
public/quote-template.html   David's template, wired to window.QUOTE
public/quote-sample.js       dev-only sample payload (real Chai Travel numbers)
```

## Routes

| Method | Path | Who calls it | Does |
|---|---|---|---|
| POST | `/generate-link` | HubSpot "Quote Ready" workflow | mint token, write `hub_quote_link` |
| GET  | `/q/:token` | the client | render live quote (or inactive page) |
| POST | `/q/:token/accept` | the page | validate + fire accept webhook |
| GET  | `/healthz` | uptime | ok |

## Setup

### 1. Secrets (Replit → Tools → Secrets)
See `.env.example`. You need:
- `HUBSPOT_TOKEN` — Private App token (scopes below)
- `PUBLIC_BASE_URL` — your Repl's URL (or `https://quotes.branchfurniture.com` once DNS is set)
- `ACCEPT_WEBHOOK_URL` — Zapier catch hook that advances the deal stage
- `GENERATE_WEBHOOK_SECRET` — a long random string; the workflow must send the same value

### 2. HubSpot Private App scopes
`crm.objects.deals` read+write, `crm.objects.quotes` read, `crm.objects.line_items` read,
`crm.objects.contacts` read, `crm.objects.companies` read, `crm.objects.owners` read.

### 3. Custom deal property
Create on the **deal** object:
- Internal name: `hub_quote_link`
- Field type: single-line text / URL
- (It does not exist in the portal yet — the code writes to it once created.)

### 4. Workflow A — create the link (HubSpot)
Trigger: deal enters stage `1523817` (Quote Ready).
Action: **Send webhook** → `POST {PUBLIC_BASE_URL}/generate-link`
Body: `{ "dealId": "{{ deal.hs_object_id }}", "secret": "<GENERATE_WEBHOOK_SECRET>" }`
Result: `hub_quote_link` is populated on the deal; the rep copies it and sends it.

### 5. Workflow B — apply acceptance (Zapier)
The service POSTs to `ACCEPT_WEBHOOK_URL` on acceptance with:
`{ dealId, acceptedStage: "1492994", total, lineItems, signature: { name, agreed, signedAt, ip, userAgent } }`
Zapier steps: catch hook → update HubSpot deal stage to `1492994` → create a note on the
deal with the signature/audit trail.

## Run locally / on Replit
```
npm install
npm start        # listens on $PORT (Replit sets this) or 3000
```

## How pricing is derived from HubSpot (read before touching render.js)

The template's summary sidebar needs four numbers beyond the raw line items:
White Glove amount, discount, tax, and the two fallback rates used when a
client edits quantities. Verified against real quotes on portal `5361087`
(the Chai Travel quote, `20260714-122516563`):

- **Products subtotal** — sum of `price × quantity` across all non-White-Glove
  line items. Matches the quote's real pre-discount subtotal to the penny.
- **White Glove amount** — the `amount` on the single line item whose
  `hs_sku` is `"White Glove Delivery"`. Zero if the deal has no White Glove
  line (e.g. a "NoWG" deal).
- **Discount** — summed from each line item's `hs_total_discount`. There is
  **no reliable quote-level discount rollup property** on this portal —
  confirmed by checking real quote objects.
- **Tax** — HubSpot does **not** populate `hs_tax_total` (quote-level) or
  `hs_tax_amount` (line-item level) on this portal's quotes, even on
  finalized ones. Instead of leaving tax at zero, `render.js` backs it out
  as `hs_quote_amount − (products + WG − discount)`, so the page's total
  always ties exactly to HubSpot's authoritative quote total. If Branch
  turns on HubSpot's automated tax feature in the future and `hs_tax_total`
  starts getting populated, switch `buildRates()` in `src/render.js` to read
  it directly instead of deriving it.

If a real quote ever fails to balance (total doesn't match products + WG −
discount + tax), that means `hs_quote_amount`/`hs_tcv` is missing on the
quote — check that property before assuming the render logic is wrong.

## Deliberately deferred (V2)
Tiers, synced comments, signature-grade signing (DocuSign/PandaDoc), payment automation.
Confirm the clickwrap acceptance language with whoever owns contracts before treating it
as binding.

## Note on the token store
`.token-store.json` is fine for the pilot but is local to the Repl. When this graduates,
reimplement `load()`/`save()` in `src/tokens.js` against Airtable or the Hub DB — no route
code changes.
