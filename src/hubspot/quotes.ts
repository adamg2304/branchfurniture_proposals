import { config } from "../config.js";
import { getHubSpotClient } from "./client.js";
import { buildAssociation, resolveAssociationTypeId } from "./associations.js";

export const OBJECT_TYPE = {
  quotes: "quotes",
  deals: "deals",
  lineItems: "line_items",
  contacts: "contacts",
  quoteTemplates: "quote_templates",
  notes: "notes",
} as const;

export interface CreateAndSendQuoteInput {
  dealId: string;
  title: string;
  /** ISO 8601 date string, e.g. "2026-09-05" */
  expirationDate: string;
  senderOwnerId?: string;
}

export interface CreateAndSendQuoteResult {
  quoteId: string;
  /** Populated only after the quote finishes publishing; null until then. */
  publicUrl: string | null;
}

/**
 * Creates a quote for a deal (pulling its associated line items and
 * contacts), attaches the configured quote template, and publishes it
 * (skipping HubSpot's internal approval step) so it's immediately sendable
 * to the buyer.
 *
 * Requires the private app token to have quotes/deals/line_items/contacts
 * read+write scopes — see docs/HUBSPOT_SETUP.md.
 */
export async function createAndSendQuote(input: CreateAndSendQuoteInput): Promise<CreateAndSendQuoteResult> {
  const client = getHubSpotClient(config.hubspot.privateAppToken);

  const deal = await client.crm.deals.basicApi.getById(input.dealId, undefined, undefined, [
    OBJECT_TYPE.lineItems,
    OBJECT_TYPE.contacts,
  ]);

  const lineItemIds = (deal.associations?.[OBJECT_TYPE.lineItems]?.results ?? []).map((r) => r.id);
  const contactIds = (deal.associations?.[OBJECT_TYPE.contacts]?.results ?? []).map((r) => r.id);

  if (lineItemIds.length === 0) {
    throw new Error(`Deal ${input.dealId} has no line items — add products to the deal before quoting it.`);
  }
  if (contactIds.length === 0) {
    throw new Error(`Deal ${input.dealId} has no associated contact — a quote needs a buyer to send to.`);
  }

  const [dealAssociationTypeId, lineItemAssociationTypeId, templateAssociationTypeId, contactAssociationTypeId] =
    await Promise.all([
      resolveAssociationTypeId(client, OBJECT_TYPE.quotes, OBJECT_TYPE.deals),
      resolveAssociationTypeId(client, OBJECT_TYPE.quotes, OBJECT_TYPE.lineItems),
      resolveAssociationTypeId(client, OBJECT_TYPE.quotes, OBJECT_TYPE.quoteTemplates),
      resolveAssociationTypeId(client, OBJECT_TYPE.quotes, OBJECT_TYPE.contacts),
    ]);

  const associations = [
    buildAssociation(input.dealId, "HUBSPOT_DEFINED", dealAssociationTypeId),
    buildAssociation(config.hubspot.quoteTemplateId, "HUBSPOT_DEFINED", templateAssociationTypeId),
    ...lineItemIds.map((id) => buildAssociation(id, "HUBSPOT_DEFINED", lineItemAssociationTypeId)),
    ...contactIds.map((id) => buildAssociation(id, "HUBSPOT_DEFINED", contactAssociationTypeId)),
  ];

  const properties: Record<string, string> = {
    hs_title: input.title,
    hs_expiration_date: input.expirationDate,
    // Quotes must be created in DRAFT status — HubSpot rejects a create call
    // that carries both associations and a non-draft status.
    hs_status: "DRAFT",
    hs_template_type: "CPQ_QUOTE",
  };
  if (input.senderOwnerId) {
    properties.hubspot_owner_id = input.senderOwnerId;
  }

  const quote = await client.crm.quotes.basicApi.create({
    properties,
    associations,
  });

  // Publish the quote, skipping HubSpot's internal approval workflow, so
  // it's immediately viewable/signable by the buyer. If Branch Furniture's
  // template requires internal approval before sending, change this to
  // "PENDING_APPROVAL" instead and let the approver flip it to "APPROVED".
  await client.crm.quotes.basicApi.update(quote.id, {
    properties: { hs_status: "APPROVAL_NOT_NEEDED" },
  });

  const published = await client.crm.quotes.basicApi.getById(quote.id, ["hs_quote_link"]);

  return {
    quoteId: quote.id,
    publicUrl: published.properties.hs_quote_link ?? null,
  };
}
