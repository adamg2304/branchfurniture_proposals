"use strict";

const fs = require("fs");
const path = require("path");
const config = require("./config");

/**
 * Turns live HubSpot objects into the window.QUOTE payload the template reads,
 * then injects it inline. Rendering happens on EVERY page load, so the quote
 * always reflects the rep's current line items — no cached copy to sync.
 *
 * White Glove is a real line item in HubSpot (hs_sku "White Glove Delivery").
 * The template shows it as its own summary row rather than a product row, so
 * it's pulled out of `items` here rather than rendered as-is like the rest.
 */

const TEMPLATE_PATH = path.join(__dirname, "..", "public", "quote-template.html");
const WHITE_GLOVE_SKU = "White Glove Delivery";

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function fullName(contact) {
  if (!contact) return "";
  const p = contact.properties || {};
  return [p.firstname, p.lastname].filter(Boolean).join(" ");
}

function companyLocation(company) {
  if (!company) return "";
  const p = company.properties || {};
  return [p.city, p.state].filter(Boolean).join(", ");
}

/** Splits the White Glove line (if present) out of the furniture line items. */
function splitLineItems(lineItems) {
  const items = [];
  let wgAmount = 0;

  for (const li of lineItems) {
    const p = li.properties || {};
    if (p.hs_sku === WHITE_GLOVE_SKU) {
      wgAmount += num(p.amount);
      continue;
    }
    const url = p.hs_url && p.hs_url !== "#N/A" ? p.hs_url : "";
    items.push({
      name: p.name || "",
      sku: p.hs_sku || "",
      spec: "",                       // Branch folds spec into the name; keep blank
      price: num(p.price),
      qty: parseInt(p.quantity, 10) || 0,
      orig: parseInt(p.quantity, 10) || 0,
      imageUrl: p.hs_images || "",
      productUrl: url,
    });
  }

  return { items, wgAmount: round2(wgAmount) };
}

/**
 * Builds the `rates` block the template needs to show the summary sidebar
 * (products/WG/discount/tax) and to recompute WG + tax live if the client
 * edits quantities.
 *
 * There's no reliable quote-level "total discount" or "total tax" property on
 * this portal — verified against real quotes: hs_tax_total and per-line
 * hs_tax_amount are unset even on finalized quotes. So:
 *   - discount is summed from each line item's hs_total_discount (reliable).
 *   - tax is backed out as whatever's needed to hit the quote's authoritative
 *     hs_quote_amount/hs_tcv total, so the page always ties to the penny,
 *     rather than trying to source a tax figure that isn't actually there.
 */
function buildRates({ lineItems, wgAmount, productsSubtotal, quoteTotal }) {
  const discount = round2(
    lineItems.reduce((sum, li) => sum + num((li.properties || {}).hs_total_discount), 0),
  );
  const preTax = round2(productsSubtotal + wgAmount - discount);
  const tax = round2(quoteTotal - preTax);

  return {
    wgAmount,
    wgRate: productsSubtotal > 0 ? wgAmount / productsSubtotal : 0,
    discount,
    taxAmount: tax,
    taxRate: preTax > 0 ? tax / preTax : 0,
    taxLabel: "Tax",
  };
}

/**
 * Build the window.QUOTE object.
 * `accepted` flips the page into its post-signature state (deal already in the
 * accepted stage), so a returning client sees a confirmation, not a live button.
 */
function buildQuotePayload({ deal, quote, lineItems, contact, company, owner, token, accepted }) {
  const q = quote?.properties || {};
  const currency =
    lineItems[0]?.properties?.hs_line_item_currency_code || q.hs_currency || "USD";

  const { items, wgAmount } = splitLineItems(lineItems);
  const productsSubtotal = round2(items.reduce((sum, it) => sum + it.price * it.qty, 0));
  const quoteTotal = num(q.hs_quote_amount || q.hs_tcv);

  const rates = buildRates({ lineItems, wgAmount, productsSubtotal, quoteTotal });
  const location = companyLocation(company);
  if (location) rates.taxLabel = `Tax (${location})`;

  return {
    accepted: !!accepted,
    currency,
    customer: {
      company: company?.properties?.name || deal?.properties?.dealname || "",
      location,
      contactName: fullName(contact),
      contactTitle: contact?.properties?.jobtitle || "",
      contactEmail: contact?.properties?.email || "",
    },
    rep: {
      name: [owner?.firstName, owner?.lastName].filter(Boolean).join(" "),
      title: "Branch",
      email: owner?.email || "",
      phone: "",
    },
    meta: {
      ref: q.hs_quote_number || "",
      dealId: String(deal?.id || ""),
      token,
      created: q.hs_createdate || "",
      expires: q.hs_expiration_date || "",
      acceptUrl: `${config.publicBaseUrl}/q/${token}/accept`,
    },
    rates,
    items,
  };
}

/** Inject window.QUOTE inline, replacing the dev <script src="quote-sample.js"> line. */
function renderQuotePage(payload) {
  let html = fs.readFileSync(TEMPLATE_PATH, "utf8");
  const injected = `<script>window.QUOTE = ${JSON.stringify(payload)};</script>`;
  // Replace the dev sample-loader if present, else inject before </head>.
  if (html.includes('<script src="quote-sample.js"></script>')) {
    html = html.replace('<script src="quote-sample.js"></script>', injected);
  } else {
    html = html.replace("</head>", `${injected}\n</head>`);
  }
  return html;
}

/** Neutral page when a link is opened but the deal isn't in a render stage. */
function renderInactivePage() {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Branch — Quote</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#fbfaf7;color:#21241f;
display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{max-width:460px;text-align:center;padding:40px}
h1{font-family:Georgia,serif;color:#2e4438}
a{color:#2e4438}</style></head>
<body><div class="card">
<h1>Branch</h1>
<p>This quote is no longer active. Please contact your Branch representative for an up-to-date quote.</p>
<p><a href="mailto:sales@branchfurniture.com">sales@branchfurniture.com</a></p>
</div></body></html>`;
}

module.exports = { buildQuotePayload, renderQuotePage, renderInactivePage };
