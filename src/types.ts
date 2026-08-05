export interface HubSpotWebhookEvent {
  eventId: number;
  subscriptionId: number;
  portalId: number;
  appId: number;
  occurredAt: number;
  subscriptionType: string;
  attemptNumber: number;
  objectId: number;
  propertyName?: string;
  propertyValue?: string;
  changeSource?: string;
  sourceId?: string;
}

export interface QuoteCreationRequest {
  dealId: string;
  title: string;
  expirationDate: string;
  senderOwnerId?: string;
}
