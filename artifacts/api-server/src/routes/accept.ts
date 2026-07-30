/**
 * POST /api/q/:quoteId/accept
 *
 * Validates the quote token, records the signature audit trail as a HubSpot
 * note on the associated deal, updates the quote status to CLOSED (accepted),
 * and optionally fires the Zapier webhook.
 *
 * Request body (JSON):
 *   quoteId          — HubSpot quote ID (must match URL param)
 *   dealId           — HubSpot deal ID
 *   token            — quote_link_token from window.QUOTE.meta
 *   signature.name   — signer's full name
 *   signature.agreed — checkbox state (must be true)
 *   signature.signedAt — ISO timestamp from the client
 *   total            — computed total at signing time
 *   lineItems        — array of { sku, name, qty, price, quotedQty }
 *   availabilityCheck — whether quantities were edited
 */

import { Router, type IRouter, type Request, type Response } from "express";
import {
  validateTokenAndGetDealId,
  createAcceptanceNote,
  updateQuoteStatusAccepted,
  TokenMismatchError,
} from "../lib/hubspot.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(",")[0];
    return (first ?? "").trim();
  }
  return req.socket?.remoteAddress ?? "unknown";
}

function buildNoteBody(opts: {
  signerName: string;
  signedAt: string;
  ip: string;
  ua: string;
  total: number;
  quoteId: string;
  availabilityCheck: boolean;
  lineItems: Array<{ sku?: string; name?: string; qty: number; price: number; quotedQty?: number }>;
}): string {
  const lines: string[] = [
    `✅ Quote #${opts.quoteId} accepted via Branch quote portal`,
    ``,
    `Signer: ${opts.signerName}`,
    `Signed at: ${opts.signedAt}`,
    `Total at signing: $${opts.total.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    opts.availabilityCheck ? `⚠️ Availability check required (quantities were adjusted)` : ``,
    ``,
    `Audit trail:`,
    `  IP: ${opts.ip}`,
    `  User-Agent: ${opts.ua}`,
    ``,
    `Line items at acceptance:`,
    ...opts.lineItems.map((li) => {
      const sku = li.sku ? ` [${li.sku}]` : "";
      const changed = li.quotedQty !== undefined && li.qty !== li.quotedQty
        ? ` (quoted: ${li.quotedQty})`
        : "";
      return `  • ${li.name ?? "Unknown"}${sku} — qty ${li.qty}${changed} @ $${Number(li.price).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }),
  ];
  return lines.filter((l) => l !== undefined).join("\n");
}

async function fireZapierWebhook(payload: Record<string, unknown>): Promise<void> {
  const url = process.env["ZAPIER_WEBHOOK_URL"];
  if (!url) {
    logger.warn("ZAPIER_WEBHOOK_URL not set — skipping webhook");
    return;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, "Zapier webhook returned non-2xx");
    } else {
      logger.info("Zapier webhook fired successfully");
    }
  } catch (err) {
    // Non-fatal — log and continue
    logger.warn({ err }, "Zapier webhook request failed");
  }
}

router.post("/q/:quoteId/accept", async (req: Request, res: Response) => {
  const rawQuoteId = req.params["quoteId"];
  const quoteId: string = Array.isArray(rawQuoteId)
    ? (rawQuoteId[0] ?? "")
    : (rawQuoteId ?? "");

  if (!quoteId) {
    res.status(400).json({ error: "Missing quoteId in URL" });
    return;
  }

  const body = req.body as {
    quoteId?: string;
    dealId?: string;   // informational only — never used for writes; dealId is derived server-side
    token?: string;
    signature?: { name?: string; agreed?: boolean; signedAt?: string };
    total?: number;
    lineItems?: Array<{ sku?: string; name?: string; qty: number; price: number; quotedQty?: number }>;
    availabilityCheck?: boolean;
  };

  // ── Validate required fields ───────────────────────────────────────────────
  if (!body.token) {
    res.status(400).json({ error: "Missing token" });
    return;
  }

  // If the client sends quoteId in the body it must match the URL param.
  // This guards against confused-deputy payloads where the URL and body disagree.
  if (body.quoteId !== undefined && body.quoteId !== quoteId) {
    res.status(400).json({ error: "quoteId in body does not match URL" });
    return;
  }

  if (!body.signature?.name || !body.signature.agreed) {
    res.status(400).json({ error: "Signature name and agreement are required" });
    return;
  }

  if (!process.env["HUBSPOT_PRIVATE_APP_TOKEN"]) {
    logger.error("HUBSPOT_PRIVATE_APP_TOKEN is not set");
    res.status(503).json({ error: "Quote service is not configured" });
    return;
  }

  const ip = getClientIp(req);
  const ua = String(req.headers["user-agent"] ?? "unknown");
  const signedAt = body.signature.signedAt ?? new Date().toISOString();

  try {
    // ── 1. Validate token + derive the authoritative dealId from HubSpot ─────
    //    The client-supplied dealId is intentionally ignored for all writes.
    //    We look up the deal association server-side so no client can redirect
    //    note writes to an arbitrary HubSpot deal.
    const authorizedDealId = await validateTokenAndGetDealId(quoteId, body.token);

    // ── 2. Build note text ───────────────────────────────────────────────────
    const noteBody = buildNoteBody({
      signerName: body.signature.name,
      signedAt,
      ip,
      ua,
      total: body.total ?? 0,
      quoteId,
      availabilityCheck: body.availabilityCheck ?? false,
      lineItems: body.lineItems ?? [],
    });

    // ── 3. Write to HubSpot + fire webhook in parallel ───────────────────────
    const zapierPayload = {
      event: "quote_accepted",
      quoteId,
      dealId: authorizedDealId,
      signerName: body.signature.name,
      signedAt,
      total: body.total ?? 0,
      availabilityCheck: body.availabilityCheck ?? false,
      ip,
      userAgent: ua,
    };

    await Promise.all([
      createAcceptanceNote(authorizedDealId, noteBody),
      updateQuoteStatusAccepted(quoteId),
      fireZapierWebhook(zapierPayload),
    ]);

    logger.info({ quoteId, dealId: body.dealId, signerName: body.signature.name }, "Quote accepted");

    res.status(200).json({ ok: true, message: "Quote accepted successfully" });
  } catch (err) {
    if (err instanceof TokenMismatchError) {
      logger.warn({ quoteId }, "Token mismatch on accept");
      res.status(403).json({ error: "Invalid or expired quote link" });
      return;
    }

    logger.error({ err, quoteId }, "Error processing quote acceptance");
    res.status(500).json({ error: "Failed to record acceptance. Please try again or contact your Branch rep." });
  }
});

export default router;
