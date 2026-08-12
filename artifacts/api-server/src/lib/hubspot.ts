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
}

interface DealProperties {
  hubspot_owner_id?: string | null;
  dealname?: string | null;
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
    acceptUrl: string;
  };
  rates: {
    wgAmount: number;
    wgRate: number;
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
    return { total, lineItems: [] };
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

  return { total, lineItems };
}

/**
 * Fetch the most recent quote for a deal and return the full render payload.
 *
 * Picks the quote with the highest numeric ID (most recently created).
 * No token validation — intended for internal/rep use via /api/d/:dealId.
 */
export async function fetchQuotePayloadForDeal(dealId: string): Promise<QuotePayload> {
  // Get all quotes associated with this deal
  const assocResult = await hs<{ results: Array<{ id: string; type: string }> }>(
    `/crm/v3/objects/deals/${dealId}/associations/quotes`,
  );

  const quoteIds = assocResult.results.map((r) => r.id);
  if (quoteIds.length === 0) {
    throw Object.assign(new Error("NO_QUOTES"), { message: "NO_QUOTES" });
  }

  // Pick the quote with the highest numeric ID (most recently created)
  const quoteId = quoteIds
    .map((id) => ({ id, n: parseInt(id, 10) }))
    .sort((a, b) => b.n - a.n)[0]!.id;

  // Reuse the core fetch, but skip token validation by passing a sentinel
  // that we'll match against — we patch fetchQuotePayload to accept null token
  return fetchQuotePayloadInternal(quoteId, dealId, null);
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

  const liProps = ["name", "quantity", "price", "amount", "hs_sku", "description", "hs_url", "hs_images", "hub_image", "hs_total_discount"];

  const [lineItemsBatch, deal] = await Promise.all([
    lineItemIds.length > 0
      ? hs<HsBatchResult<LineItemProperties>>(`/crm/v3/objects/line_items/batch/read`, {
          method: "POST",
          body: JSON.stringify({ inputs: lineItemIds.map((id) => ({ id })), properties: liProps }),
        })
      : Promise.resolve({ results: [] as HsObject<LineItemProperties>[] }),
    hs<HsObject<DealProperties>>(
      `/crm/v3/objects/deals/${dealId}?properties=hubspot_owner_id,dealname`,
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
      acceptUrl: `/api/q/${quoteId}/accept`,
    },
    rates: { wgAmount: round2(wgAmount), wgRate: round6(wgRate), discount: round2(discount), taxAmount: round2(taxAmount), taxRate: round6(taxRate), taxLabel },
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
