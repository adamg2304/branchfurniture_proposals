---
name: White Glove line item detection
description: How the quote server separates the White Glove delivery line item from product line items.
---

## Rule
A line item is White Glove if its `name` (lowercased) contains any of:
- `white glove` / `whiteglove` / `white-glove`
- `delivery & install` / `delivery and install`
- both `delivery` AND `install`

Product items are everything else.

**Why:** HubSpot quotes include WG as a regular line item. The window.QUOTE shape separates products (shown in the items table) from WG (shown as a summary row). The `wgAmount` and `wgRate` fields in `rates` are derived from the WG line item, not stored separately in HubSpot.

## How to apply
`isWhiteGlove()` helper in `artifacts/api-server/src/lib/hubspot.ts`. If no WG line item is found, `wgAmount` defaults to 0 and `wgRate` to 0 — the summary will show $0 for White Glove, which is correct for standard-delivery quotes.
