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

export async function fetchQuotePayload(
  quoteId: string,
  urlToken: string,
): Promise<QuotePayload> {
  // ── 1. Fetch the quote object ──────────────────────────────────────────────
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

  // ── 2. Token validation ────────────────────────────────────────────────────
  const storedToken = quote.properties.quote_link_token;
  if (!storedToken || storedToken !== urlToken) {
    throw new TokenMismatchError();
  }

  // ── 3. Fan out: line items + deals associations (parallel) ─────────────────
  const [lineItemAssocs, dealAssocs] = await Promise.all([
    hs<HsAssociationsResult>(
      `/crm/v4/objects/quotes/${quoteId}/associations/line_items`,
    ),
    hs<HsAssociationsResult>(
      `/crm/v4/objects/quotes/${quoteId}/associations/deals`,
    ),
  ]);

  const lineItemIds = lineItemAssocs.results.map((r) => String(r.toObjectId));
  const dealId = String(dealAssocs.results[0]?.toObjectId ?? "");

  if (!dealId) {
    throw new Error(`No deal associated with quote ${quoteId}`);
  }

  // ── 4. Fan out: line item details + deal details (parallel) ───────────────
  const liProps = [
    "name",
    "quantity",
    "price",
    "amount",
    "hs_sku",
    "description",
    "hs_url",
    "hs_images",
  ];

  const [lineItemsBatch, deal] = await Promise.all([
    lineItemIds.length > 0
      ? hs<HsBatchResult<LineItemProperties>>(
          `/crm/v3/objects/line_items/batch/read`,
          {
            method: "POST",
            body: JSON.stringify({
              inputs: lineItemIds.map((id) => ({ id })),
              properties: liProps,
            }),
          },
        )
      : Promise.resolve({ results: [] as HsObject<LineItemProperties>[] }),
    hs<HsObject<DealProperties>>(
      `/crm/v3/objects/deals/${dealId}?properties=hubspot_owner_id,dealname`,
    ),
  ]);

  const ownerId = deal.properties.hubspot_owner_id ?? "";

  // ── 5. Fan out: contact + company + owner (parallel) ──────────────────────
  const [contactAssocs, companyAssocs] = await Promise.all([
    hs<HsAssociationsResult>(
      `/crm/v4/objects/deals/${dealId}/associations/contacts`,
    ),
    hs<HsAssociationsResult>(
      `/crm/v4/objects/deals/${dealId}/associations/companies`,
    ),
  ]);

  const contactId = String(contactAssocs.results[0]?.toObjectId ?? "");
  const companyId = String(companyAssocs.results[0]?.toObjectId ?? "");

  const [contactRes, companyRes, ownerRes] = await Promise.all([
    contactId
      ? hs<HsBatchResult<ContactProperties>>(
          `/crm/v3/objects/contacts/batch/read`,
          {
            method: "POST",
            body: JSON.stringify({
              inputs: [{ id: contactId }],
              properties: [
                "firstname",
                "lastname",
                "email",
                "jobtitle",
                "city",
                "state",
              ],
            }),
          },
        )
      : Promise.resolve({ results: [] as HsObject<ContactProperties>[] }),
    companyId
      ? hs<HsBatchResult<CompanyProperties>>(
          `/crm/v3/objects/companies/batch/read`,
          {
            method: "POST",
            body: JSON.stringify({
              inputs: [{ id: companyId }],
              properties: ["name", "city", "state"],
            }),
          },
        )
      : Promise.resolve({ results: [] as HsObject<CompanyProperties>[] }),
    ownerId
      ? hs<OwnerRecord>(`/crm/v3/owners/${ownerId}`).catch((err) => {
          // crm.objects.owners.read scope may not be granted — degrade gracefully
          logger.warn(
            { ownerId, status: (err as { status?: number }).status },
            "Could not fetch owner — missing scope or owner not found; rep info will be empty. Add crm.objects.owners.read scope to the private app to enable.",
          );
          return null as OwnerRecord | null;
        })
      : Promise.resolve(null as OwnerRecord | null),
  ]);

  // ── 6. Build the window.QUOTE payload ─────────────────────────────────────
  const contact = contactRes.results[0]?.properties ?? {};
  const company = companyRes.results[0]?.properties ?? {};
  const owner = ownerRes;

  const contactName = [contact.firstname, contact.lastname]
    .filter(Boolean)
    .join(" ");
  const companyLocation = [company.city, company.state]
    .filter(Boolean)
    .join(", ");
  const repName = [owner?.firstName, owner?.lastName]
    .filter(Boolean)
    .join(" ");

  // Separate WG line from product line items
  const allLineItems = lineItemsBatch.results;
  const wgItem = allLineItems.find((li) => isWhiteGlove(li.properties.name));
  const productItems = allLineItems.filter(
    (li) => !isWhiteGlove(li.properties.name),
  );

  const wgAmount = parseNum(wgItem?.properties.amount);
  const productSubtotal = productItems.reduce(
    (sum, li) =>
      sum + parseNum(li.properties.price) * parseNum(li.properties.quantity),
    0,
  );

  const discount = parseNum(quote.properties.hs_total_discount);
  const taxAmount = parseNum(quote.properties.hs_tax);

  const preTax = productSubtotal + wgAmount - discount;
  const wgRate = productSubtotal > 0 ? wgAmount / productSubtotal : 0;
  const taxRate = preTax > 0 ? taxAmount / preTax : 0;

  const taxLabel =
    companyLocation ? `Tax (${companyLocation})` : "Tax";

  const items = productItems.map((li) => {
    const p = li.properties;
    const price = parseNum(p.price);
    const qty = Math.round(parseNum(p.quantity)) || 1;
    return {
      name: p.name ?? "",
      spec: p.description ?? "",
      sku: p.hs_sku ?? "",
      price,
      qty,
      orig: qty,
      imageUrl: p.hs_images ?? "",
      productUrl: p.hs_url ?? "",
    };
  });

  return {
    customer: {
      company: company.name ?? "",
      location: companyLocation,
      contactName,
      contactTitle: contact.jobtitle ?? "",
      contactEmail: contact.email ?? "",
    },
    rep: {
      name: repName,
      title: "Account Executive",
      email: owner?.email ?? "",
      phone: "",
    },
    meta: {
      ref: quote.properties.hs_quote_number ?? quoteId,
      quoteId,
      dealId,
      token: urlToken,
      created: toDateString(quote.properties.hs_createdate),
      expires: toDateString(quote.properties.hs_expiration_date),
      acceptUrl: `/api/q/${quoteId}/accept`,
    },
    rates: {
      wgAmount: round2(wgAmount),
      wgRate: round6(wgRate),
      discount: round2(discount),
      taxAmount: round2(taxAmount),
      taxRate: round6(taxRate),
      taxLabel,
    },
    items,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

// ─── Accept-flow helpers ──────────────────────────────────────────────────────

/**
 * Validate the quote token and derive the associated deal ID server-side.
 *
 * Returns the authoritative dealId from HubSpot — callers must never rely on
 * a client-supplied dealId for write operations.
 *
 * Throws TokenMismatchError when the token does not match.
 */
export async function validateTokenAndGetDealId(
  quoteId: string,
  urlToken: string,
): Promise<string> {
  // Fetch token + deal associations in parallel
  const [quoteObj, dealAssocs] = await Promise.all([
    hs<HsObject<{ quote_link_token?: string | null }>>(
      `/crm/v3/objects/quotes/${quoteId}?properties=quote_link_token`,
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

  return dealId;
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
