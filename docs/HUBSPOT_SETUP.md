# HubSpot setup checklist — Quotes + acceptance webhooks

This is the admin-side setup that has to happen inside HubSpot before the
code in this repo (`src/`) can create/send quotes and receive acceptance
notifications. None of this can be done via API — it requires someone with
**Super Admin** permissions on the Branch Furniture HubSpot portal.

> **Known gap at the time of writing:** the HubSpot connection currently
> available to this project (portal `5361087`) has `QUOTE` **read** access but
> **not write** access. Whoever owns that connection needs to go through the
> steps below (or grant a new private app the scopes below) before quote
> creation will work.

## 1. Confirm prerequisites

- [ ] **Sales Hub Professional or Enterprise** — the Quotes API and
      e-signature require a paid Sales Hub tier (Quotes exist on Starter but
      e-signature/payments do not).
- [ ] At least one **Quote template** exists (Settings → Objects → Quotes →
      Templates). The API needs a template ID to attach to every quote.
- [ ] Decide whether buyers need to **e-sign** the quote to "accept" it, or
      whether "accepted" just means the deal stage/quote status changes some
      other way (e.g. a payment, or a manual approval). This determines
      whether you turn on e-signature in the template.

## 2. Create a private app

Settings → Integrations → Private Apps → **Create a private app**.

Name it something like `Branch Furniture – Quotes & Proposals`.

### Required scopes

| Scope | Why |
|---|---|
| `crm.objects.quotes.read` / `.write` | Create quotes, read status changes |
| `crm.objects.deals.read` / `.write` | Read deal to quote, update stage on acceptance |
| `crm.objects.line_items.read` / `.write` | Attach priced products to the quote |
| `crm.objects.contacts.read` / `.write` | Resolve/verify the buyer, log acceptance on the contact |
| `crm.objects.companies.read` | Pull company details onto the quote |
| `crm.schemas.quotes.read` | Read quote template + property metadata |
| `e-commerce` (if payments are collected on the quote) | Only if you enable "Collect payment" on quotes |
| `files` (if you want the signed PDF pulled into the repo) | Download the generated quote/signature PDF |

After creating the app, copy the **Access token** into this project's
`.env` as `HUBSPOT_PRIVATE_APP_TOKEN` (see `.env.example`).

## 3. Configure the webhook subscription (acceptance ping)

Still inside the private app, go to the **Webhooks** tab.

- [ ] **Target URL**: the publicly reachable URL for this service's
      `/webhooks/hubspot/quotes` endpoint (e.g.
      `https://<your-deployment>/webhooks/hubspot/quotes`). This has to be a
      real HTTPS endpoint HubSpot can reach — not `localhost`. Use a tunnel
      (ngrok, Cloudflare Tunnel) while testing, and the real deployed URL in
      production.
- [ ] **Subscription**: `quote` → property change → property
      `hs_status`. HubSpot will POST an event any time a quote's status
      changes (draft → pending_approval → approved → **accepted**/rejected →
      expired).
- [ ] Leave the subscription **paused** until step 5 below is done, then
      activate it.
- [ ] Copy the app's **Client secret** shown on the Webhooks tab into
      `.env` as `HUBSPOT_WEBHOOK_CLIENT_SECRET`. This is the HMAC key the
      code uses to verify that a webhook call really came from HubSpot
      (`X-HubSpot-Signature-v3` header) — do not skip this, it's the only
      thing standing between this endpoint and a spoofed "quote accepted"
      call.

## 4. Slack notification

- [ ] In the Branch Slack workspace, create an **Incoming Webhook** for the
      channel that should hear about accepted quotes (Slack → Apps →
      Incoming Webhooks, or reuse an existing Slack app).
- [ ] Put the webhook URL in `.env` as `SLACK_WEBHOOK_URL`. Treat it as a
      secret — anyone with the URL can post to that channel.

## 5. Deploy and verify end-to-end

- [ ] Deploy this service (or run it behind a tunnel) with the three env
      vars above set.
- [ ] Send yourself a test quote from a test deal, hit accept on the buyer
      side (or simulate via HubSpot's webhook test tool in the private app
      settings), and confirm:
  - The service logs a verified webhook call.
  - The associated deal/contact get updated (see
    `src/webhooks/quoteAcceptedHandler.ts` for exactly what changes).
  - The Slack channel gets a message.
- [ ] Only then flip the webhook subscription from **paused** to **active**
      for real traffic.

## Property/association reference used by the code

The code in `src/hubspot/quotes.ts` assumes the following, which are
HubSpot defaults but should be double-checked against the actual portal
before going live (`Settings → Objects → Quotes`):

- New quotes are created with `hs_status = DRAFT` and
  `hs_template_type = CPQ_QUOTE`, then published by moving `hs_status`
  through `APPROVAL_NOT_NEEDED` (skip approval) once associations are set —
  HubSpot rejects quotes that carry a non-draft status *and* associations in
  the same create call, so it has to be a create-then-update flow.
- Association type IDs: deal → quote is `64`, line item → quote is `67`.
  Quote template and signer contact associations don't have stable
  documented IDs — `src/hubspot/quotes.ts` resolves these dynamically via
  the associations schema API instead of hardcoding them, but if HubSpot's
  behavior differs on this portal, that's the first place to look.
- `hs_status = 'accepted'` is what the webhook handler treats as "the buyer
  accepted the quote." If the Branch Furniture template uses a custom
  approval flow, adjust the check in
  `src/webhooks/quoteAcceptedHandler.ts`.
