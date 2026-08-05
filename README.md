# branchfurniture_proposals
B2B Sales Proposal Channel

Creates and sends HubSpot Quotes to clients, and reacts when a client
accepts one: updates the associated deal/contact in HubSpot and posts a
Slack notification.

## Setup

1. Go through **[docs/HUBSPOT_SETUP.md](docs/HUBSPOT_SETUP.md)** first — it's
   the admin-side checklist (private app scopes, webhook subscription,
   Slack incoming webhook) that has to happen in HubSpot's UI before any of
   this code will work. **The HubSpot connection available at the time this
   was built only had read access to Quotes** — writing quotes will fail
   until that's fixed on the portal.
2. `cp .env.example .env` and fill in the values from step 1.
3. `npm install`
4. `npm run dev` (or `npm run build && npm start` for production)

## What's here

- `src/hubspot/quotes.ts` — creates a quote for a deal (pulling its line
  items + contact), attaches the configured quote template, and publishes
  it so it's sendable to the buyer.
- `src/routes/quotes.ts` — `POST /quotes` internal endpoint that calls the
  above. Wire this up from wherever "send this quote" gets triggered
  (a HubSpot workflow custom-code action, an internal tool, etc).
- `src/routes/webhooks.ts` + `src/webhooks/` — `POST
  /webhooks/hubspot/quotes`, the endpoint HubSpot calls when a quote's
  status changes. Verifies HubSpot's v3 request signature, and on
  acceptance: logs a note on the deal/contact, optionally moves the deal
  stage, and pings Slack.
- `src/slack/notify.ts` — the Slack message sent on acceptance.

## Tests

`npm test` runs the webhook signature verification tests (the
security-critical piece — malformed/forged/stale requests all get
rejected). The HubSpot-calling code isn't covered by automated tests since
it talks to a real HubSpot portal; verify it manually against a test deal
per the checklist in docs/HUBSPOT_SETUP.md.
