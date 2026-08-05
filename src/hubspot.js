"use strict";

const config = require("./config");

/**
 * All HubSpot API access lives here. Routes never call HubSpot directly — so
 * moving hosts (or swapping the private-app token for a project app's OAuth
 * later) is a change in ONE file.
 *
 * Uses Node 18+ global fetch. Field names below are verified against the real
 * Branch portal (5361087) line-item / quote / deal shape.
 */

const H = config.hubspot;

async function hsFetch(pathname, options = {}) {
  const res = await fetch(`${H.baseUrl}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${H.token}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HubSpot ${options.method || "GET"} ${pathname} → ${res.status}: ${body}`);
  }
  return res.status === 204 ? null : res.json();
}

/** Read a deal with the properties the page needs (incl. current stage). */
async function getDeal(dealId) {
  const props = [
    "dealname",
    "dealstage",
    "pipeline",
    "hubspot_owner_id",
    H.quoteLinkProperty,
  ].join(",");
  return hsFetch(`/crm/v3/objects/deals/${dealId}?properties=${props}`);
}

/** First quote associated with a deal (Branch attaches one quote per deal). */
async function getQuoteForDeal(dealId) {
  const assoc = await hsFetch(`/crm/v4/objects/deals/${dealId}/associations/quotes?limit=1`);
  const quoteId = assoc?.results?.[0]?.toObjectId;
  if (!quoteId) return null;

  const props = [
    "hs_title",
    "hs_quote_number",
    "hs_status",
    "hs_expiration_date",
    "hs_createdate",
    "hs_quote_amount",
    "hs_tcv",
    "hs_currency",
  ].join(",");
  return hsFetch(`/crm/v3/objects/quotes/${quoteId}?properties=${props}`);
}

/**
 * Line items on a quote. Verified fields incl. hs_images and hs_url (Shopify).
 *
 * hs_total_discount is required so render.js can sum the quote's real total
 * discount — there's no reliable quote-level discount rollup property on this
 * portal, only this per-line one (confirmed against real Chai Travel quote data).
 */
async function getLineItemsForQuote(quoteId) {
  const assoc = await hsFetch(
    `/crm/v4/objects/quotes/${quoteId}/associations/line_items?limit=100`
  );
  const ids = (assoc?.results || []).map((r) => r.toObjectId);
  if (!ids.length) return [];

  const props = [
    "name",
    "hs_sku",
    "quantity",
    "price",
    "amount",
    "hs_line_item_currency_code",
    "hs_images",
    "hs_url",
    "hs_discount_percentage",
    "hs_total_discount",
  ];
  const body = {
    inputs: ids.map((id) => ({ id })),
    properties: props,
  };
  const data = await hsFetch(`/crm/v3/objects/line_items/batch/read`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return data?.results || [];
}

/** Primary contact on a deal. */
async function getPrimaryContactForDeal(dealId) {
  const assoc = await hsFetch(`/crm/v4/objects/deals/${dealId}/associations/contacts?limit=1`);
  const contactId = assoc?.results?.[0]?.toObjectId;
  if (!contactId) return null;
  const props = ["firstname", "lastname", "email", "jobtitle"].join(",");
  return hsFetch(`/crm/v3/objects/contacts/${contactId}?properties=${props}`);
}

/** Primary company on a deal (for location + tax jurisdiction). */
async function getPrimaryCompanyForDeal(dealId) {
  const assoc = await hsFetch(`/crm/v4/objects/deals/${dealId}/associations/companies?limit=1`);
  const companyId = assoc?.results?.[0]?.toObjectId;
  if (!companyId) return null;
  const props = ["name", "city", "state", "address", "zip", "country"].join(",");
  return hsFetch(`/crm/v3/objects/companies/${companyId}?properties=${props}`);
}

/** Deal owner (the Branch rep shown as "Your Branch team"). */
async function getOwner(ownerId) {
  if (!ownerId) return null;
  try {
    return await hsFetch(`/crm/v3/owners/${ownerId}`);
  } catch {
    return null;
  }
}

/** Write the finished tokenized link onto the deal's custom property. */
async function writeQuoteLink(dealId, link) {
  return hsFetch(`/crm/v3/objects/deals/${dealId}`, {
    method: "PATCH",
    body: JSON.stringify({ properties: { [H.quoteLinkProperty]: link } }),
  });
}

module.exports = {
  getDeal,
  getQuoteForDeal,
  getLineItemsForQuote,
  getPrimaryContactForDeal,
  getPrimaryCompanyForDeal,
  getOwner,
  writeQuoteLink,
};
