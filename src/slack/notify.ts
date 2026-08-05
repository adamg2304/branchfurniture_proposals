export interface QuoteAcceptedSlackMessage {
  quoteTitle: string;
  dealName?: string;
  amount?: string;
  pdfUrl?: string | null;
  hubspotDealUrl?: string;
}

export async function notifyQuoteAccepted(
  webhookUrl: string,
  message: QuoteAcceptedSlackMessage,
): Promise<void> {
  const lines = [`:tada: *Quote accepted:* ${message.quoteTitle}`];
  if (message.dealName) lines.push(`*Deal:* ${message.dealName}`);
  if (message.amount) lines.push(`*Amount:* ${message.amount}`);
  if (message.pdfUrl) lines.push(`*Signed PDF:* ${message.pdfUrl}`);
  if (message.hubspotDealUrl) lines.push(`*HubSpot deal:* ${message.hubspotDealUrl}`);

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: lines.join("\n") }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Slack webhook returned ${response.status}: ${body}`);
  }
}
