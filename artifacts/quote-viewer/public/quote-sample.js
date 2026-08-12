/* =====================================================================
   window.QUOTE — the single payload the Cloud Run service injects.
   This file is DEV ONLY (renders the template standalone in a browser).
   In production the server builds this same object from the HubSpot
   deal → quote → line items + contact/company/owner, and injects it
   inline before the render script runs.

   Populated below with the real Chai Travel numbers so the template
   renders true-to-life without a live HubSpot call.

   FIELD SOURCES (HubSpot):
   - customer.*        contact + company associated to the deal
   - rep.*             deal owner (HubSpot owner record)
   - meta.ref/created/expires   quote object properties
   - meta.dealId/quoteId        used for write-back on accept
   - meta.token                 unguessable token for the tokenized link
   - items[].price/qty          line item unit price + quantity
   - items[].orig               quoted qty (baseline for availability check)
   - items[].sku                line item SKU
   - items[].imageUrl           SKU image library URL (from hs_images work)
   - items[].productUrl         Shopify product from the line item hs_url field
   - rates.wgAmount             White Glove line amount as quoted (absolute $)
   - rates.wgRate               WG ÷ product subtotal — used ONLY to recompute
                                WG if the client changes quantities
   - rates.discount             quote discount amount (absolute $)
   - rates.taxAmount            tax amount as quoted (absolute $)
   - rates.taxRate              tax ÷ pre-tax subtotal — used ONLY on qty change

   IMPORTANT: for an unmodified quote the page shows the quoted absolute
   values verbatim (matches the PDF to the penny). The *Rate fields are a
   fallback used only when the client edits quantities, so the live-updating
   experience still works without pretending to be an exact re-quote.
   ===================================================================== */
window.QUOTE = {
  customer: {
    company: "Chai Travel",
    location: "Brooklyn, NY",
    contactName: "Daniella Pally",
    contactTitle: "Chief Brand Officer",
    contactEmail: "daniella@chaitravel.com"
  },
  rep: {
    name: "Bailey Shorr",
    title: "Account Executive",
    email: "bailey@branchfurniture.com",
    phone: "+1 (781) 654-1967"
  },
  meta: {
    ref: "20260714-202928212",
    quoteId: "REPLACE_WITH_HS_QUOTE_ID",
    dealId: "REPLACE_WITH_HS_DEAL_ID",
    token: "REPLACE_WITH_UNGUESSABLE_TOKEN",
    created: "2026-07-14",
    expires: "2026-08-13",
    acceptUrl: "/api/q/41421676299/accept"  // Chai Travel dev quote — proxied to api-server in dev
  },
  // Values pulled from the HubSpot quote so the page mirrors the PDF exactly.
  // Chai Travel: products 15,233.00 · WG 2,484.95 · discount 1,218.64 · tax 1,464.31 · total 17,963.62
  rates: {
    wgAmount:  2484.95,           // quoted WG line — shown verbatim unless qty changes
    wgRate:    0.163127,          // 2484.95 / 15233.00 — fallback for qty changes
    discount:  1218.64,           // quoted discount
    taxAmount: 1464.31,           // quoted tax — shown verbatim unless qty changes
    taxRate:   0.086401,          // 1464.31 / (15233.00 + 2484.95 − 1218.64) — fallback
    taxLabel:  "Tax (Brooklyn, NY)"
  },
  // disc = per-unit discount ($). net unit = price - disc; net line = net unit x qty.
  items: [
    { name: "Conference Table for 10-12", spec: 'Walnut Top / Charcoal Leg · 142" × 48"', sku: "12-01-15-32", price: 2249.00, disc: 179.92, qty: 1,  orig: 1,  imageUrl: "", productUrl: "" },
    { name: "Meeting Table",               spec: "Walnut / Charcoal",                      sku: "12-02-48-02", price: 1149.00, disc: 91.92,  qty: 1,  orig: 1,  imageUrl: "", productUrl: "" },
    { name: "Office Desk",                  spec: 'Walnut Top / Charcoal Leg · 48" × 24"',  sku: "10-00-53-32", price: 499.00,  disc: 39.92,  qty: 4,  orig: 4,  imageUrl: "", productUrl: "" },
    { name: "Office Desk",                  spec: 'Walnut Top / Charcoal Leg · 60" × 30"',  sku: "10-00-67-32", price: 679.00,  disc: 54.32,  qty: 1,  orig: 1,  imageUrl: "", productUrl: "" },
    { name: "Ergonomic Chair",             spec: "Pebble / White / Standard",              sku: "11-01-00-53", price: 389.00,  disc: 31.12,  qty: 9,  orig: 9,  imageUrl: "https://cdn.shopify.com/s/files/1/0124/5662/4187/files/pebble-front-hi_97a0b88c-db5e-4703-9dde-8c6632124ff3.jpg", productUrl: "" },
    { name: "Daily Chair",                  spec: "Black / Black / Standard",               sku: "11-03-00-50", price: 259.00,  disc: 20.72,  qty: 16, orig: 16, imageUrl: "", productUrl: "" },
    { name: "Small Filing Cabinet",        spec: "Charcoal / Standard",                    sku: "14-06-00-69", price: 239.00,  disc: 19.12,  qty: 5,  orig: 5,  imageUrl: "", productUrl: "" },
    { name: "In-Desk Power",                spec: "Standard",                               sku: "13-11-00-00", price: 160.00,  disc: 12.80,  qty: 2,  orig: 2,  imageUrl: "", productUrl: "" }
  ]
};
