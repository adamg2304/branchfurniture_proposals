/**
 * HubSpot API client for the quote service.
 *
 * Fetches deal → quote → line items + contact / company / owner via the
 * CRM v3/v4 APIs. All calls use the private-app token from the
 * HUBSPOT_PRIVATE_APP_TOKEN environment variable.
 *
 * Token validation:  The quote object must have a custom property
 * `quote_link_token` whose value matches the token extracted from the URL.
 * Quotes without that property are always rejected (403).
 */

import { randomBytes } from "node:crypto";
import { logger } from "./logger.js";

const BASE = "https://api.hubapi.com";

function token(): string {
  const t = process.env["HUBSPOT_PRIVATE_APP_TOKEN"];
  if (!t) throw new Error("HUBSPOT_PRIVATE_APP_TOKEN is not set");
  return t;
}

async function hs<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token()}`,
      "Content-Type": "application/json",
      ...(opts.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    logger.warn({ status: res.status, url, body }, "HubSpot API error");
    throw Object.assign(new Error(`HubSpot ${res.status}: ${url}`), {
      status: res.status,
    });
  }
  return res.json() as Promise<T>;
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface HsObject<P> {
  id: string;
  properties: P;
}

interface HsAssociationsResult {
  results: Array<{ toObjectId: number; associationTypes: unknown[] }>;
}

interface HsBatchResult<P> {
  results: Array<HsObject<P>>;
}

interface QuoteProperties {
  hs_quote_number?: string | null;
  hs_createdate?: string | null;
  hs_expiration_date?: string | null;
  hs_status?: string | null;
  hs_title?: string | null;
  hs_tax?: string | null;
  hs_total_discount?: string | null;
  hs_quote_amount?: string | null;
  quote_link_token?: string | null;
}

interface LineItemProperties {
  name?: string | null;
  quantity?: string | null;
  price?: string | null;
  amount?: string | null;
  hs_sku?: string | null;
  description?: string | null;
  hs_url?: string | null;
  hs_images?: string | null;
  hub_image?: string | null;
  hs_total_discount?: string | null;
  hs_line_item_currency_code?: string | null;
  recurringbillingfrequency?: string | null;
  hs_lastmodifieddate?: string | null;
}

interface DealProperties {
  hubspot_owner_id?: string | null;
  dealname?: string | null;
  floorplan?: string | null;
  hub_quote_link?: string | null;
  dealstage?: string | null;
  createdate?: string | null;
  closedate?: string | null;
}

interface ContactProperties {
  firstname?: string | null;
  lastname?: string | null;
  email?: string | null;
  jobtitle?: string | null;
  city?: string | null;
  state?: string | null;
}

interface CompanyProperties {
  name?: string | null;
  city?: string | null;
  state?: string | null;
}

interface OwnerRecord {
  id: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  userId?: number;
  userIdIncludingInactive?: number;
  teams?: unknown[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toDateString(isoOrDate: string | null | undefined): string {
  if (!isoOrDate) return "";
  // HubSpot dates can be ISO timestamps or YYYY-MM-DD strings
  const d = new Date(isoOrDate);
  if (isNaN(d.getTime())) return isoOrDate;
  return d.toISOString().split("T")[0]!;
}

function parseNum(v: string | null | undefined): number {
  if (!v) return 0;
  return parseFloat(v) || 0;
}

/**
 * Parse the hs_images field from a HubSpot line item.
 *
 * HubSpot stores hs_images as a JSON-encoded array of image objects:
 *   [{"url":"https://...","type":"IMAGE","width":200,"height":200}, ...]
 * It may also arrive as a plain URL string (older records).
 * Returns the first image URL, or "" if none can be extracted.
 */
function parseHsImages(raw: string | null | undefined): string {
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const first = parsed.find((item) => item?.url);
      return first?.url ?? "";
    }
    // Parsed to something other than an array (unexpected) — ignore
    return "";
  } catch {
    // Not JSON — treat as a plain URL if it looks like one
    return raw.startsWith("http") ? raw : "";
  }
}

interface ProductImageProperties {
  hs_sku?: string | null;
  hub_image?: string | null;
  hs_images?: string | null;
}

/**
 * Resolve product images by SKU from the HubSpot Product library.
 *
 * `hub_image` (the curated proposal image) is typically maintained on the
 * Product, not copied onto every line item. Line items on a deal often have no
 * `hs_product_id`, so we match on `hs_sku`. Returns a map SKU → { hubImage,
 * hsImages }. Never throws — image resolution must never break rendering.
 */
async function fetchProductImagesBySku(
  skus: Array<string | null | undefined>,
): Promise<Map<string, { hubImage: string; hsImages: string }>> {
  const map = new Map<string, { hubImage: string; hsImages: string }>();
  const unique = [...new Set(skus.map((s) => (s ?? "").trim()).filter(Boolean))];
  if (unique.length === 0) return map;
  try {
    const res = await hs<HsBatchResult<ProductImageProperties>>(
      `/crm/v3/objects/products/search`,
      {
        method: "POST",
        body: JSON.stringify({
          filterGroups: [{ filters: [{ propertyName: "hs_sku", operator: "IN", values: unique }] }],
          properties: ["hs_sku", "hub_image", "hs_images"],
          limit: 100,
        }),
      },
    );
    for (const p of res.results) {
      const sku = (p.properties.hs_sku ?? "").trim();
      if (sku && !map.has(sku)) {
        map.set(sku, {
          hubImage: (p.properties.hub_image ?? "").trim(),
          hsImages: p.properties.hs_images ?? "",
        });
      }
    }
  } catch (err) {
    logger.warn({ status: (err as { status?: number }).status }, "Could not resolve product images by SKU");
  }
  return map;
}

function isWhiteGlove(name: string | null | undefined): boolean {
  if (!name) return false;
  const n = name.toLowerCase();
  return (
    n.includes("white glove") ||
    n.includes("whiteglove") ||
    n.includes("white-glove") ||
    n.includes("delivery & install") ||
    n.includes("delivery and install") ||
    (n.includes("delivery") && n.includes("install"))
  );
}

// Shipping & Delivery line items are pulled out of the product rows/subtotal
// and rolled into a single "Shipping & Delivery" summary line. Matched by SKU
// or name (case-insensitive).
const SHIPPING_SKUS = new Set([
  "white glove delivery",
  "free shipping",
  "expedited shipping",
  "stair carry surcharge",
  "after hours surcharge",
  "freight shipping",
  "union labor surcharge",
]);
function isShippingItem(
  name: string | null | undefined,
  sku: string | null | undefined,
): boolean {
  const n = (name ?? "").trim().toLowerCase();
  const s = (sku ?? "").trim().toLowerCase();
  return SHIPPING_SKUS.has(s) || SHIPPING_SKUS.has(n) || isWhiteGlove(name);
}

/** Amount of a shipping/delivery line item: prefer `amount`, else price×qty. */
function shippingLineAmount(li: HsObject<LineItemProperties>): number {
  const amt = parseNum(li.properties.amount);
  if (amt) return amt;
  return parseNum(li.properties.price) * (Math.round(parseNum(li.properties.quantity)) || 1);
}

/**
 * Resolve a HubSpot Files API file id to a public URL. Requires the private
 * app to have the `files` scope. Returns "" if the id is empty or unresolvable,
 * so a missing or inaccessible file never breaks quote rendering.
 */
async function resolveFileUrl(fileId: string): Promise<string> {
  const id = (fileId ?? "").trim();
  if (!id) return "";
  try {
    const file = await hs<{ url?: string | null }>(`/files/v3/files/${id}`);
    return file.url ?? "";
  } catch (err) {
    logger.warn({ fileId: id, status: (err as { status?: number }).status }, "Could not resolve floorplan file URL");
    return "";
  }
}

/**
 * Extract the token from a deal's stored `hub_quote_link`.
 *
 * The link is the canonical public URL we write onto the deal, of the form
 * `https://host/api/q/{dealId}-{token}`. The token is the segment after the
 * first hyphen of the final path component. dealId is numeric and the token is
 * hex, so splitting on the first hyphen is unambiguous. Returns "" when the
 * link is empty or malformed — callers treat that as "no valid token", so a
 * deal that was never provisioned can never be opened with a guessed token.
 */
function extractStoredToken(hubQuoteLink: string | null | undefined): string {
  const link = (hubQuoteLink ?? "").trim();
  if (!link) return "";
  const lastSegment = link.split("/").pop() ?? "";
  const dash = lastSegment.indexOf("-");
  return dash >= 0 ? lastSegment.slice(dash + 1) : "";
}

// ─── Main fetch function ──────────────────────────────────────────────────────

export interface QuotePayload {
  customer: {
    company: string;
    location: string;
    contactName: string;
    contactTitle: string;
    contactEmail: string;
  };
  rep: {
    name: string;
    title: string;
    email: string;
    phone: string;
  };
  meta: {
    ref: string;
    quoteId: string;
    dealId: string;
    token: string;
    created: string;
    expires: string;
    itemsUpdated: string;
    acceptUrl: string;
    floorplanUrl: string;
  };
  accepted: boolean;
  changedSinceAcceptance: boolean;
  hasWhiteGlove: boolean;
  hasShipping: boolean;
  rates: {
    wgAmount: number;
    wgRate: number;
    shippingAmount: number;
    otherShippingAmount: number;
    discount: number;
    taxAmount: number;
    taxRate: number;
    taxLabel: string;
  };
  items: Array<{
    name: string;
    spec: string;
    sku: string;
    price: number;
    disc: number;
    qty: number;
    orig: number;
    imageUrl: string;
    productUrl: string;
  }>;
}

export class TokenMismatchError extends Error {
  constructor() {
    super("Token does not match");
    this.name = "TokenMismatchError";
  }
}

/** Tokenized quote fetch — validates URL token against HubSpot before rendering. */
export async function fetchQuotePayload(
  quoteId: string,
  urlToken: string,
): Promise<QuotePayload> {
  return fetchQuotePayloadInternal(quoteId, null, urlToken);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

// ─── Accept-flow helpers ──────────────────────────────────────────────────────

export interface ValidatedQuote {
  dealId: string;
  /** Current hs_status value from HubSpot (e.g. "CLOSED", "DRAFT", "PENDING_SIGNATURE"). */
  status: string | null;
}

/**
 * Validate the quote token and derive the associated deal ID server-side.
 *
 * Returns the authoritative dealId and the quote's current hs_status so
 * callers can gate on whether the quote has already been accepted.
 *
 * Callers must never rely on a client-supplied dealId for write operations.
 *
 * Throws TokenMismatchError when the token does not match.
 */
export async function validateTokenAndGetDealId(
  quoteId: string,
  urlToken: string,
): Promise<ValidatedQuote> {
  // Fetch token + status + deal associations in parallel
  const [quoteObj, dealAssocs] = await Promise.all([
    hs<HsObject<{ quote_link_token?: string | null; hs_status?: string | null }>>(
      `/crm/v3/objects/quotes/${quoteId}?properties=quote_link_token,hs_status`,
    ),
    hs<HsAssociationsResult>(
      `/crm/v4/objects/quotes/${quoteId}/associations/deals`,
    ),
  ]);

  const stored = quoteObj.properties.quote_link_token;
  if (!stored || stored !== urlToken) {
    throw new TokenMismatchError();
  }

  const dealId = String(dealAssocs.results[0]?.toObjectId ?? "");
  if (!dealId) {
    throw new Error(`No deal associated with quote ${quoteId}`);
  }

  return { dealId, status: quoteObj.properties.hs_status ?? null };
}

/**
 * Create a HubSpot note engagement on a deal, recording the signature audit trail.
 */
export async function createAcceptanceNote(
  dealId: string,
  noteBody: string,
): Promise<void> {
  await hs<unknown>(`/crm/v3/objects/notes`, {
    method: "POST",
    body: JSON.stringify({
      properties: {
        hs_note_body: noteBody,
        hs_timestamp: new Date().toISOString(),
      },
      associations: [
        {
          to: { id: dealId },
          types: [
            {
              associationCategory: "HUBSPOT_DEFINED",
              associationTypeId: 214, // note → deal
            },
          ],
        },
      ],
    }),
  });
}

// ─── Authoritative quote data for acceptance note ─────────────────────────────

export interface AuthoritativeLineItem {
  sku: string;
  name: string;
  qty: number;
  price: number;
}

export interface AuthoritativeQuoteData {
  /** Server-computed total from hs_quote_amount (already includes tax/discount). */
  total: number;
  lineItems: AuthoritativeLineItem[];
  /** Most recent line-item modification time, for detecting post-acceptance edits. */
  contentUpdatedAt: Date | null;
}

/**
 * Fetch the authoritative quote total and line items from HubSpot for use in
 * the acceptance audit note.  Call this AFTER token validation so the token
 * check is the gate; this function does not re-validate the token.
 *
 * Only product line items are returned (white-glove / delivery+install items
 * are filtered out, mirroring the behaviour of fetchQuotePayload).
 */
export async function fetchQuoteDataForAcceptance(
  quoteId: string,
): Promise<AuthoritativeQuoteData> {
  // Fetch the quote amount + line-item associations in parallel
  const [quoteObj, lineItemAssocs] = await Promise.all([
    hs<HsObject<Pick<QuoteProperties, "hs_quote_amount">>>(
      `/crm/v3/objects/quotes/${quoteId}?properties=hs_quote_amount`,
    ),
    hs<HsAssociationsResult>(
      `/crm/v4/objects/quotes/${quoteId}/associations/line_items`,
    ),
  ]);

  const total = parseNum(quoteObj.properties.hs_quote_amount);

  const lineItemIds = lineItemAssocs.results.map((r) => String(r.toObjectId));
  if (lineItemIds.length === 0) {
    return { total, lineItems: [], contentUpdatedAt: null };
  }

  const batch = await hs<HsBatchResult<LineItemProperties>>(
    `/crm/v3/objects/line_items/batch/read`,
    {
      method: "POST",
      body: JSON.stringify({
        inputs: lineItemIds.map((id) => ({ id })),
        properties: ["name", "quantity", "price", "hs_sku"],
      }),
    },
  );

  const lineItems: AuthoritativeLineItem[] = batch.results
    .filter((li) => !isWhiteGlove(li.properties.name))
    .map((li) => ({
      sku: li.properties.hs_sku ?? "",
      name: li.properties.name ?? "",
      qty: Math.round(parseNum(li.properties.quantity)) || 1,
      price: parseNum(li.properties.price),
    }));

  return { total, lineItems, contentUpdatedAt: null };
}

/**
 * Deal-centric render — no native HubSpot Quote object involved.
 *
 * The source of truth is the DEAL and its directly-associated line items.
 * The total is computed from the line items (White Glove split out into its
 * own summary line, mirroring the template). Pass `urlToken = null` for the
 * bare rep route (/api/d/:dealId, no validation); pass a token for the public
 * tokenized link (/api/q/:dealId-:token), which is validated against the token
 * embedded in the deal's own `hub_quote_link`.
 */
export async function fetchDealQuote(
  dealId: string,
  urlToken: string | null,
): Promise<QuotePayload> {
  // 1. Fetch the deal first — we need hub_quote_link to validate the token
  //    before doing any further work, plus owner/name/floorplan/dates.
  //    hs_date_entered_<QuoteSentStage> is when the quote was sent (used as the
  //    quote's "created" date).
  const quoteSentStage = process.env["QUOTE_SENT_STAGE_ID"] || "1523817";
  const enteredSentProp = `hs_date_entered_${quoteSentStage}`;
  const deal = await hs<HsObject<DealProperties & Record<string, string | null | undefined>>>(
    `/crm/v3/objects/deals/${dealId}?properties=hubspot_owner_id,dealname,floorplan,hub_quote_link,dealstage,createdate,closedate,${enteredSentProp}`,
  );

  // Token validation — only for the public tokenized link.
  if (urlToken !== null) {
    const stored = extractStoredToken(deal.properties.hub_quote_link);
    if (!stored || stored !== urlToken) {
      throw new TokenMismatchError();
    }
  }

  // 2. Fan out: the deal's own line items + contact/company associations.
  const [lineItemAssocs, contactAssocs, companyAssocs] = await Promise.all([
    hs<HsAssociationsResult>(`/crm/v4/objects/deals/${dealId}/associations/line_items`),
    hs<HsAssociationsResult>(`/crm/v4/objects/deals/${dealId}/associations/contacts`),
    hs<HsAssociationsResult>(`/crm/v4/objects/deals/${dealId}/associations/companies`),
  ]);

  const lineItemIds = lineItemAssocs.results.map((r) => String(r.toObjectId));
  const contactId = String(contactAssocs.results[0]?.toObjectId ?? "");
  const companyId = String(companyAssocs.results[0]?.toObjectId ?? "");
  const ownerId = deal.properties.hubspot_owner_id ?? "";

  const liProps = ["name", "quantity", "price", "amount", "hs_sku", "description", "hs_url", "hs_images", "hub_image", "hs_total_discount", "hs_lastmodifieddate"];

  const [lineItemsBatch, contactRes, companyRes, ownerRes, floorplanUrl] = await Promise.all([
    lineItemIds.length > 0
      ? hs<HsBatchResult<LineItemProperties>>(`/crm/v3/objects/line_items/batch/read`, {
          method: "POST",
          body: JSON.stringify({ inputs: lineItemIds.map((id) => ({ id })), properties: liProps }),
        })
      : Promise.resolve({ results: [] as HsObject<LineItemProperties>[] }),
    contactId
      ? hs<HsBatchResult<ContactProperties>>(`/crm/v3/objects/contacts/batch/read`, {
          method: "POST",
          body: JSON.stringify({ inputs: [{ id: contactId }], properties: ["firstname","lastname","email","jobtitle","city","state"] }),
        })
      : Promise.resolve({ results: [] as HsObject<ContactProperties>[] }),
    companyId
      ? hs<HsBatchResult<CompanyProperties>>(`/crm/v3/objects/companies/batch/read`, {
          method: "POST",
          body: JSON.stringify({ inputs: [{ id: companyId }], properties: ["name","city","state"] }),
        })
      : Promise.resolve({ results: [] as HsObject<CompanyProperties>[] }),
    ownerId
      ? hs<OwnerRecord>(`/crm/v3/owners/${ownerId}`).catch((err) => {
          logger.warn({ ownerId, status: (err as { status?: number }).status }, "Could not fetch owner");
          return null as OwnerRecord | null;
        })
      : Promise.resolve(null as OwnerRecord | null),
    resolveFileUrl(deal.properties.floorplan ?? ""),
  ]);

  const contact = contactRes.results[0]?.properties ?? {};
  const company = companyRes.results[0]?.properties ?? {};
  const owner = ownerRes;

  const contactName = [contact.firstname, contact.lastname].filter(Boolean).join(" ");
  const companyLocation = [company.city, company.state].filter(Boolean).join(", ");
  const repName = [owner?.firstName, owner?.lastName].filter(Boolean).join(" ");

  const allLineItems = lineItemsBatch.results;
  const shippingLineItems = allLineItems.filter((li) => isShippingItem(li.properties.name, li.properties.hs_sku));
  const productItems = allLineItems.filter((li) => !isShippingItem(li.properties.name, li.properties.hs_sku));
  const wgItem = allLineItems.find((li) => isWhiteGlove(li.properties.name));

  // Resolve hub_image from the Product library (by SKU) for any line item that
  // doesn't carry its own hub_image — the curated proposal image is maintained
  // on the Product, not copied onto each line item.
  const productImages = await fetchProductImagesBySku(productItems.map((li) => li.properties.hs_sku));

  // Shipping & Delivery splits into two parts so the client can scale the
  // White Glove portion with the live order (max($200 + 15% of products,
  // quoted amount)) while other shipping/delivery surcharges stay flat.
  const wgAmount = shippingLineItems
    .filter((li) => isWhiteGlove(li.properties.name))
    .reduce((sum, li) => sum + shippingLineAmount(li), 0);
  const otherShippingAmount = shippingLineItems
    .filter((li) => !isWhiteGlove(li.properties.name))
    .reduce((sum, li) => sum + shippingLineAmount(li), 0);
  const shippingAmount = wgAmount + otherShippingAmount;
  const productSubtotal = productItems.reduce(
    (sum, li) => sum + parseNum(li.properties.price) * parseNum(li.properties.quantity), 0,
  );

  // Discount is the sum of per-line discounts on the product items.
  const discount = productItems.reduce((sum, li) => sum + parseNum(li.properties.hs_total_discount), 0);
  // Tax is calculated at checkout for now (TaxJar integration is Phase 2).
  const taxAmount = 0;
  const preTax = productSubtotal + shippingAmount - discount;
  const shippingRate = productSubtotal > 0 ? shippingAmount / productSubtotal : 0;
  const taxRate = preTax > 0 ? taxAmount / preTax : 0;
  const taxLabel = companyLocation ? `Tax (${companyLocation})` : "Tax";

  const items = productItems.map((li) => {
    const p = li.properties;
    const price = parseNum(p.price);
    const qty = Math.round(parseNum(p.quantity)) || 1;
    const disc = qty > 0 ? Math.round((parseNum(p.hs_total_discount) / qty) * 100) / 100 : 0;
    // Image priority: line-item hub_image → Product hub_image (by SKU) →
    // line-item hs_images → Product hs_images. hub_image always wins over the
    // hs_images fallback so the curated proposal image is used when present.
    const prodImg = productImages.get((p.hs_sku ?? "").trim());
    const hubImage = (p.hub_image ?? "").trim() || (prodImg?.hubImage ?? "");
    const imageUrl = hubImage || parseHsImages(p.hs_images) || parseHsImages(prodImg?.hsImages);
    return { name: p.name ?? "", spec: p.description ?? "", sku: p.hs_sku ?? "", price, disc, qty, orig: qty, imageUrl, productUrl: p.hs_url ?? "" };
  });

  // Quote validity: "created" is when the deal entered Quote Sent (when the
  // quote went out), falling back to the deal's create date; it expires
  // QUOTE_VALIDITY_DAYS (default 30) later. itemsUpdated is the most recent
  // line-item modification time, used to detect edits made after acceptance.
  const validityDays = Number(process.env["QUOTE_VALIDITY_DAYS"]) || 30;
  const dealProps = deal.properties as Record<string, string | null | undefined>;
  const sentRaw = dealProps[enteredSentProp] || deal.properties.createdate || "";
  const createdMs = sentRaw ? new Date(sentRaw).getTime() : Date.now();
  const expiresMs = createdMs + validityDays * 24 * 60 * 60 * 1000;
  const itemsUpdated = allLineItems
    .map((li) => li.properties.hs_lastmodifieddate || "")
    .filter(Boolean)
    .sort()
    .pop() || "";

  return {
    customer: { company: company.name ?? "", location: companyLocation, contactName, contactTitle: contact.jobtitle ?? "", contactEmail: contact.email ?? "" },
    rep: { name: repName, title: "Account Executive", email: owner?.email ?? "", phone: "" },
    meta: {
      ref: deal.properties.dealname ?? dealId,
      quoteId: dealId,
      dealId,
      token: urlToken ?? "",
      created: toDateString(new Date(createdMs).toISOString()),
      expires: toDateString(new Date(expiresMs).toISOString()),
      itemsUpdated,
      acceptUrl: `/api/q/${dealId}/accept`,
      floorplanUrl,
    },
    accepted: deal.properties.dealstage === (process.env["ACCEPTED_DEAL_STAGE_ID"] || "1492994"),
    changedSinceAcceptance: false,
    hasWhiteGlove: Boolean(wgItem),
    hasShipping: shippingLineItems.length > 0,
    rates: { wgAmount: round2(wgAmount), wgRate: round6(shippingRate), shippingAmount: round2(shippingAmount), otherShippingAmount: round2(otherShippingAmount), discount: round2(discount), taxAmount: round2(taxAmount), taxRate: round6(taxRate), taxLabel },
    items,
  };
}

/**
 * Bare deal render for the rep route (/api/d/:dealId) — no token validation.
 * Throws NO_QUOTES when the deal has no line items to render.
 */
export async function fetchQuotePayloadForDeal(dealId: string): Promise<QuotePayload> {
  const payload = await fetchDealQuote(dealId, null);
  if (payload.items.length === 0 && !payload.hasWhiteGlove) {
    throw Object.assign(new Error("NO_QUOTES"), { message: "NO_QUOTES" });
  }
  return payload;
}

/**
 * Core quote payload builder, shared by the tokenized and deal-based routes.
 * Pass `urlToken = null` to skip token validation (deal-based access).
 */
async function fetchQuotePayloadInternal(
  quoteId: string,
  knownDealId: string | null,
  urlToken: string | null,
): Promise<QuotePayload> {
  const quoteProps = [
    "hs_quote_number",
    "hs_createdate",
    "hs_expiration_date",
    "hs_status",
    "hs_title",
    "hs_tax",
    "hs_total_discount",
    "hs_quote_amount",
    "quote_link_token",
  ].join(",");

  const quote = await hs<HsObject<QuoteProperties>>(
    `/crm/v3/objects/quotes/${quoteId}?properties=${quoteProps}`,
  );

  // Token validation — only when a token was supplied (tokenized URL flow)
  if (urlToken !== null) {
    const storedToken = quote.properties.quote_link_token;
    if (!storedToken || storedToken !== urlToken) {
      throw new TokenMismatchError();
    }
  }

  // Fan out: line items + deal association (parallel)
  const [lineItemAssocs, dealAssocsResult] = await Promise.all([
    hs<HsAssociationsResult>(
      `/crm/v4/objects/quotes/${quoteId}/associations/line_items`,
    ),
    knownDealId
      ? Promise.resolve({ results: [{ toObjectId: parseInt(knownDealId, 10), associationTypes: [] }] as HsAssociationsResult["results"] })
      : hs<HsAssociationsResult>(
          `/crm/v4/objects/quotes/${quoteId}/associations/deals`,
        ),
  ]);

  const lineItemIds = lineItemAssocs.results.map((r) => String(r.toObjectId));
  const dealId = knownDealId ?? String(dealAssocsResult.results[0]?.toObjectId ?? "");

  if (!dealId) {
    throw new Error(`No deal associated with quote ${quoteId}`);
  }

  const liProps = ["name", "quantity", "price", "amount", "hs_sku", "description", "hs_url", "hs_images", "hub_image", "hs_total_discount", "hs_lastmodifieddate"];

  const [lineItemsBatch, deal] = await Promise.all([
    lineItemIds.length > 0
      ? hs<HsBatchResult<LineItemProperties>>(`/crm/v3/objects/line_items/batch/read`, {
          method: "POST",
          body: JSON.stringify({ inputs: lineItemIds.map((id) => ({ id })), properties: liProps }),
        })
      : Promise.resolve({ results: [] as HsObject<LineItemProperties>[] }),
    hs<HsObject<DealProperties>>(
      `/crm/v3/objects/deals/${dealId}?properties=hubspot_owner_id,dealname,floorplan`,
    ),
  ]);

  const ownerId = deal.properties.hubspot_owner_id ?? "";

  const [contactAssocs, companyAssocs] = await Promise.all([
    hs<HsAssociationsResult>(`/crm/v4/objects/deals/${dealId}/associations/contacts`),
    hs<HsAssociationsResult>(`/crm/v4/objects/deals/${dealId}/associations/companies`),
  ]);

  const contactId = String(contactAssocs.results[0]?.toObjectId ?? "");
  const companyId = String(companyAssocs.results[0]?.toObjectId ?? "");

  const [contactRes, companyRes, ownerRes] = await Promise.all([
    contactId
      ? hs<HsBatchResult<ContactProperties>>(`/crm/v3/objects/contacts/batch/read`, {
          method: "POST",
          body: JSON.stringify({ inputs: [{ id: contactId }], properties: ["firstname","lastname","email","jobtitle","city","state"] }),
        })
      : Promise.resolve({ results: [] as HsObject<ContactProperties>[] }),
    companyId
      ? hs<HsBatchResult<CompanyProperties>>(`/crm/v3/objects/companies/batch/read`, {
          method: "POST",
          body: JSON.stringify({ inputs: [{ id: companyId }], properties: ["name","city","state"] }),
        })
      : Promise.resolve({ results: [] as HsObject<CompanyProperties>[] }),
    ownerId
      ? hs<OwnerRecord>(`/crm/v3/owners/${ownerId}`).catch((err) => {
          logger.warn({ ownerId, status: (err as { status?: number }).status }, "Could not fetch owner");
          return null as OwnerRecord | null;
        })
      : Promise.resolve(null as OwnerRecord | null),
  ]);

  const contact = contactRes.results[0]?.properties ?? {};
  const company = companyRes.results[0]?.properties ?? {};
  const owner = ownerRes;

  const contactName = [contact.firstname, contact.lastname].filter(Boolean).join(" ");
  const companyLocation = [company.city, company.state].filter(Boolean).join(", ");
  const repName = [owner?.firstName, owner?.lastName].filter(Boolean).join(" ");

  const allLineItems = lineItemsBatch.results;
  const wgItem = allLineItems.find((li) => isWhiteGlove(li.properties.name));
  const productItems = allLineItems.filter((li) => !isWhiteGlove(li.properties.name));

  const wgAmount = parseNum(wgItem?.properties.amount);
  const productSubtotal = productItems.reduce(
    (sum, li) => sum + parseNum(li.properties.price) * parseNum(li.properties.quantity), 0,
  );

  const discount = parseNum(quote.properties.hs_total_discount);
  const taxAmount = parseNum(quote.properties.hs_tax);
  const preTax = productSubtotal + wgAmount - discount;
  const wgRate = productSubtotal > 0 ? wgAmount / productSubtotal : 0;
  const taxRate = preTax > 0 ? taxAmount / preTax : 0;
  const taxLabel = companyLocation ? `Tax (${companyLocation})` : "Tax";

  const items = productItems.map((li) => {
    const p = li.properties;
    const price = parseNum(p.price);
    const qty = Math.round(parseNum(p.quantity)) || 1;
    const disc = qty > 0 ? Math.round((parseNum(p.hs_total_discount) / qty) * 100) / 100 : 0;
    // hub_image (a direct URL on the line item) is the intended proposal image;
    // fall back to the Shopify hs_images array if hub_image isn't set.
    const imageUrl = p.hub_image && p.hub_image.trim() ? p.hub_image.trim() : parseHsImages(p.hs_images);
    return { name: p.name ?? "", spec: p.description ?? "", sku: p.hs_sku ?? "", price, disc, qty, orig: qty, imageUrl, productUrl: p.hs_url ?? "" };
  });

  return {
    customer: { company: company.name ?? "", location: companyLocation, contactName, contactTitle: contact.jobtitle ?? "", contactEmail: contact.email ?? "" },
    rep: { name: repName, title: "Account Executive", email: owner?.email ?? "", phone: "" },
    meta: {
      ref: quote.properties.hs_quote_number ?? quoteId,
      quoteId,
      dealId,
      token: urlToken ?? "",
      created: toDateString(quote.properties.hs_createdate),
      expires: toDateString(quote.properties.hs_expiration_date),
      itemsUpdated: "",
      acceptUrl: `/api/q/${quoteId}/accept`,
      floorplanUrl: await resolveFileUrl(deal.properties.floorplan ?? ""),
    },
    accepted: false,
    changedSinceAcceptance: false,
    hasWhiteGlove: Boolean(wgItem),
    hasShipping: Boolean(wgItem),
    rates: { wgAmount: round2(wgAmount), wgRate: round6(wgRate), shippingAmount: round2(wgAmount), otherShippingAmount: 0, discount: round2(discount), taxAmount: round2(taxAmount), taxRate: round6(taxRate), taxLabel },
    items,
  };
}

/**
 * Update the HubSpot quote's hs_status to CLOSED (accepted).
 */
export async function updateQuoteStatusAccepted(quoteId: string): Promise<void> {
  await hs<unknown>(`/crm/v3/objects/quotes/${quoteId}`, {
    method: "PATCH",
    body: JSON.stringify({
      properties: {
        hs_status: "CLOSED",
      },
    }),
  });
}

// ─── Deal-based acceptance (deal-centric flow) ────────────────────────────────

export interface ValidatedDeal {
  dealId: string;
  /** true when the deal already sits in the configured accepted stage. */
  alreadyAccepted: boolean;
}

/**
 * Validate a deal-based quote token and report whether the deal is already in
 * the accepted stage.
 *
 * The token is checked against the value embedded in the deal's own
 * `hub_quote_link`, so a signer can only act on a deal that was actually
 * provisioned with the matching link. Throws TokenMismatchError otherwise.
 */
export async function validateDealTokenAndStatus(
  dealId: string,
  urlToken: string,
): Promise<ValidatedDeal> {
  const deal = await hs<HsObject<Pick<DealProperties, "hub_quote_link" | "dealstage">>>(
    `/crm/v3/objects/deals/${dealId}?properties=hub_quote_link,dealstage`,
  );

  const stored = extractStoredToken(deal.properties.hub_quote_link);
  if (!stored || stored !== urlToken) {
    throw new TokenMismatchError();
  }

  const acceptedStage = process.env["ACCEPTED_DEAL_STAGE_ID"];
  const alreadyAccepted = acceptedStage
    ? deal.properties.dealstage === acceptedStage
    : false;

  return { dealId, alreadyAccepted };
}

/**
 * Fetch authoritative acceptance data (total + product line items) straight
 * from the deal's own line items. The total is computed from the line items
 * (products + White Glove, less per-line discounts); there is no native quote
 * amount to read.
 */
export async function fetchDealDataForAcceptance(
  dealId: string,
): Promise<AuthoritativeQuoteData> {
  const assoc = await hs<HsAssociationsResult>(
    `/crm/v4/objects/deals/${dealId}/associations/line_items`,
  );
  const ids = assoc.results.map((r) => String(r.toObjectId));
  if (ids.length === 0) {
    return { total: 0, lineItems: [], contentUpdatedAt: null };
  }

  const batch = await hs<HsBatchResult<LineItemProperties>>(
    `/crm/v3/objects/line_items/batch/read`,
    {
      method: "POST",
      body: JSON.stringify({
        inputs: ids.map((id) => ({ id })),
        properties: ["name", "quantity", "price", "hs_sku", "amount", "hs_total_discount", "hs_lastmodifieddate"],
      }),
    },
  );

  const all = batch.results;
  const products = all.filter((li) => !isShippingItem(li.properties.name, li.properties.hs_sku));
  const shipping = all.filter((li) => isShippingItem(li.properties.name, li.properties.hs_sku));

  const productSubtotal = products.reduce(
    (sum, li) => sum + parseNum(li.properties.price) * parseNum(li.properties.quantity), 0,
  );
  const shippingAmount = shipping.reduce((sum, li) => sum + shippingLineAmount(li), 0);
  const discount = products.reduce((sum, li) => sum + parseNum(li.properties.hs_total_discount), 0);
  const total = round2(productSubtotal + shippingAmount - discount);

  const lineItems: AuthoritativeLineItem[] = products.map((li) => ({
    sku: li.properties.hs_sku ?? "",
    name: li.properties.name ?? "",
    qty: Math.round(parseNum(li.properties.quantity)) || 1,
    price: parseNum(li.properties.price),
  }));

  const latest = all
    .map((li) => li.properties.hs_lastmodifieddate || "")
    .filter(Boolean)
    .sort()
    .pop();
  const contentUpdatedAt = latest ? new Date(latest) : null;

  return { total, lineItems, contentUpdatedAt };
}

/**
 * Provision (or reuse) the tokenized public quote link on a deal.
 *
 * Generates an unguessable token, writes `hub_quote_link =
 * {PUBLIC_BASE_URL}/api/q/{dealId}-{token}` onto the deal, and returns it.
 * Idempotent: if the deal already has a link on the CURRENT base pointing at
 * its own tokenized route it is kept (so re-enrolling a deal in the workflow
 * does not rotate a link that may already be shared) — pass `force` to
 * regenerate. If a link exists on a DIFFERENT base (e.g. a deal provisioned on
 * the old Replit URL), the same token is preserved and only the base is
 * swapped, so migrating domains does not invalidate the token.
 *
 * This is what the "deal entered Quote Sent" HubSpot workflow calls.
 */
export async function provisionDealQuoteLink(
  dealId: string,
  opts: { force?: boolean } = {},
): Promise<{ url: string; created: boolean }> {
  const base = (process.env["PUBLIC_BASE_URL"] || "https://quotes.branchfurniture.com").replace(/\/$/, "");

  const deal = await hs<HsObject<Pick<DealProperties, "hub_quote_link">>>(
    `/crm/v3/objects/deals/${dealId}?properties=hub_quote_link`,
  );
  const existingLink = (deal.properties.hub_quote_link ?? "").trim();
  const existingToken = extractStoredToken(existingLink);
  const expectedPrefix = `${base}/api/q/${dealId}-`;

  // Reuse an already-provisioned link that is already on the current base.
  if (!opts.force && existingToken && existingLink.startsWith(expectedPrefix)) {
    return { url: existingLink, created: false };
  }

  // Preserve the existing token when only the base is changing (domain
  // migration); otherwise mint a fresh one.
  const tok = (!opts.force && existingToken) ? existingToken : randomBytes(20).toString("hex");
  const url = `${base}/api/q/${dealId}-${tok}`;
  await hs<unknown>(`/crm/v3/objects/deals/${dealId}`, {
    method: "PATCH",
    body: JSON.stringify({ properties: { hub_quote_link: url } }),
  });
  return { url, created: true };
}

/**
 * Sweep every deal currently in the Quote Sent stage and provision a tokenized
 * link on any that don't already have one. Idempotent (provisionDealQuoteLink
 * skips deals that already carry their own tokenized link), so this is safe to
 * run on a schedule. This is the reliable, HubSpot-app-free way to keep links
 * populated: point a cron / Replit Scheduled Deployment at POST /api/provision/sweep.
 */
export async function sweepQuoteSentDeals(): Promise<{
  scanned: number;
  provisioned: number;
  truncated: boolean;
  deals: Array<{ dealId: string; url: string; created: boolean }>;
}> {
  const stage = process.env["QUOTE_SENT_STAGE_ID"] || "1523817";
  const LIMIT = 100;
  const search = await hs<{ total?: number; results: Array<{ id: string }> }>(
    `/crm/v3/objects/deals/search`,
    {
      method: "POST",
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: "dealstage", operator: "EQ", value: stage }] }],
        properties: ["dealstage"],
        limit: LIMIT,
      }),
    },
  );

  const results = search.results ?? [];
  const truncated = (search.total ?? results.length) > LIMIT;
  if (truncated) {
    logger.warn({ total: search.total }, "Quote Sent sweep hit the 100-deal page limit; some deals not swept this run");
  }

  const deals: Array<{ dealId: string; url: string; created: boolean }> = [];
  let provisioned = 0;
  for (const d of results) {
    try {
      const r = await provisionDealQuoteLink(d.id);
      if (r.created) provisioned++;
      deals.push({ dealId: d.id, url: r.url, created: r.created });
    } catch (err) {
      logger.error({ err, dealId: d.id }, "Sweep failed to provision deal");
    }
  }
  return { scanned: results.length, provisioned, truncated, deals };
}

/**
 * Advance the deal to the accepted stage, if one is configured via the
 * ACCEPTED_DEAL_STAGE_ID environment variable. When unset, acceptance still
 * records the audit note but the stage is left unchanged (logged loudly so the
 * misconfiguration is obvious). This is how acceptance "pings back" to Branch.
 */
export async function advanceDealStageAccepted(dealId: string): Promise<void> {
  const stageId = process.env["ACCEPTED_DEAL_STAGE_ID"];
  if (!stageId) {
    logger.warn(
      { dealId },
      "ACCEPTED_DEAL_STAGE_ID is not set — acceptance recorded but deal stage not advanced",
    );
    return;
  }
  await hs<unknown>(`/crm/v3/objects/deals/${dealId}`, {
    method: "PATCH",
    body: JSON.stringify({ properties: { dealstage: stageId } }),
  });
}
