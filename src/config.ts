import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  hubspot: {
    privateAppToken: required("HUBSPOT_PRIVATE_APP_TOKEN"),
    webhookClientSecret: required("HUBSPOT_WEBHOOK_CLIENT_SECRET"),
    webhookTargetUrl: required("HUBSPOT_WEBHOOK_TARGET_URL"),
    quoteTemplateId: required("HUBSPOT_QUOTE_TEMPLATE_ID"),
    // Optional: HubSpot dealstage ID to move a deal to once its quote is
    // accepted (Settings > Objects > Deals > Pipelines). If unset, the deal
    // stage is left alone and only the acceptance note + Slack ping fire.
    dealStageOnAccepted: process.env.HUBSPOT_DEAL_STAGE_ON_ACCEPTED || undefined,
    // Optional: used only to build a clickable "open in HubSpot" link in
    // the Slack notification (Settings > Account Setup > Account Defaults).
    portalId: process.env.HUBSPOT_PORTAL_ID || undefined,
  },
  slack: {
    webhookUrl: required("SLACK_WEBHOOK_URL"),
  },
};
