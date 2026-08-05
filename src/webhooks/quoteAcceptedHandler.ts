import { config } from "../config.js";
import { getHubSpotClient } from "../hubspot/client.js";
import { buildAssociation, resolveAssociationTypeId } from "../hubspot/associations.js";
import { OBJECT_TYPE } from "../hubspot/quotes.js";
import { notifyQuoteAccepted } from "../slack/notify.js";
import type { HubSpotWebhookEvent } from "../types.js";

const ACCEPTED_STATUS = "ACCEPTED";

/**
 * Reacts to a `quote.propertyChange` webhook event for `hs_status`. No-ops
 * for any status other than ACCEPTED (draft/pending_approval/rejected/etc.
 * are not "acceptance pings").
 */
export async function handleQuoteAcceptedEvent(event: HubSpotWebhookEvent): Promise<void> {
  if (event.subscriptionType !== "quote.propertyChange" || event.propertyName !== "hs_status") {
    return;
  }
  if (event.propertyValue?.toUpperCase() !== ACCEPTED_STATUS) {
    return;
  }

  const client = getHubSpotClient(config.hubspot.privateAppToken);
  const quoteId = String(event.objectId);

  const quote = await client.crm.quotes.basicApi.getById(
    quoteId,
    ["hs_title", "hs_pdf_download_link"],
    undefined,
    [OBJECT_TYPE.deals, OBJECT_TYPE.contacts],
  );

  const dealIds = (quote.associations?.[OBJECT_TYPE.deals]?.results ?? []).map((r) => r.id);
  const contactIds = (quote.associations?.[OBJECT_TYPE.contacts]?.results ?? []).map((r) => r.id);
  const pdfUrl = quote.properties.hs_pdf_download_link ?? null;
  const quoteTitle = quote.properties.hs_title ?? `Quote ${quoteId}`;

  // 1. Update internal records: move the deal stage (if configured) and log
  //    an acceptance note associated with the deal + contact(s).
  await Promise.all(dealIds.map((dealId) => applyAcceptanceToDeal(dealId, contactIds, quoteTitle, pdfUrl)));

  // 2. Notify Branch's Slack channel.
  const firstDeal = dealIds[0]
    ? await client.crm.deals.basicApi.getById(dealIds[0], ["dealname", "amount"]).catch(() => null)
    : null;

  await notifyQuoteAccepted(config.slack.webhookUrl, {
    quoteTitle,
    dealName: firstDeal?.properties.dealname ?? undefined,
    amount: firstDeal?.properties.amount ?? undefined,
    pdfUrl,
    hubspotDealUrl: firstDeal ? dealUrl(firstDeal.id) : undefined,
  });
}

async function applyAcceptanceToDeal(
  dealId: string,
  contactIds: string[],
  quoteTitle: string,
  pdfUrl: string | null,
): Promise<void> {
  const client = getHubSpotClient(config.hubspot.privateAppToken);

  if (config.hubspot.dealStageOnAccepted) {
    await client.crm.deals.basicApi.update(dealId, {
      properties: { dealstage: config.hubspot.dealStageOnAccepted },
    });
  }

  const [noteToDealTypeId, noteToContactTypeId] = await Promise.all([
    resolveAssociationTypeId(client, OBJECT_TYPE.notes, OBJECT_TYPE.deals),
    resolveAssociationTypeId(client, OBJECT_TYPE.notes, OBJECT_TYPE.contacts),
  ]);

  const body = [
    `Quote "${quoteTitle}" was accepted by the buyer.`,
    pdfUrl ? `Signed copy: ${pdfUrl}` : undefined,
  ]
    .filter(Boolean)
    .join(" ");

  await client.crm.objects.notes.basicApi.create({
    properties: {
      hs_note_body: body,
      hs_timestamp: new Date().toISOString(),
    },
    associations: [
      buildAssociation(dealId, "HUBSPOT_DEFINED", noteToDealTypeId),
      ...contactIds.map((contactId) => buildAssociation(contactId, "HUBSPOT_DEFINED", noteToContactTypeId)),
    ],
  });
}

function dealUrl(dealId: string): string | undefined {
  return config.hubspot.portalId
    ? `https://app.hubspot.com/contacts/${config.hubspot.portalId}/deal/${dealId}`
    : undefined;
}
