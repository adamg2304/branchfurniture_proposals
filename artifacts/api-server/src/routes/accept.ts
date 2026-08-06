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
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import {
  validateTokenAndGetDealId,
  fetchQuoteDataForAcceptance,
  createAcceptanceNote,
  updateQuoteStatusAccepted,
  TokenMismatchError,
  type ValidatedQuote,
} from "../lib/hubspot.js";
import { logger } from "../lib/logger.js";
import { db, quoteAcceptancesTable } from "@workspace/db";

const router: IRouter = Router();

/**
 * Return the client's IP address.
 *
 * app.set("trust proxy", 1) is configured in app.ts, so Express validates
 * the X-Forwarded-For chain against the trusted proxy hop and exposes the
 * real client address via req.ip.  Reading the raw header directly would
 * allow any client to spoof the IP field in the audit trail.
 */
function getClientIp(req: Request): string {
  return req.ip ?? req.socket?.remoteAddress ?? "unknown";
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

/**
 * Determine server-side whether the signer adjusted any quantities relative to
 * the original HubSpot quote.
 *
 * We match client items to HubSpot items by SKU (preferred) then by name.
 * If any client-submitted quantity differs from HubSpot's recorded quantity,
 * the availability-check flag is raised.  Unmatched client items are ignored
 * (they cannot be verified and do not affect the authoritative note content).
 */
function deriveAvailabilityCheck(
  clientItems: Array<{ sku?: string; name?: string; qty: number }>,
  hsItems: Array<{ sku: string; name: string; qty: number }>,
): boolean {
  for (const client of clientItems) {
    // Find the matching HubSpot line item
    const match =
      (client.sku
        ? hsItems.find((h) => h.sku && h.sku === client.sku)
        : undefined) ??
      (client.name
        ? hsItems.find(
            (h) => h.name.toLowerCase() === client.name!.toLowerCase(),
          )
        : undefined);

    if (match && client.qty !== match.qty) {
      return true;
    }
  }
  return false;
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
  // signedAt is always set server-side — the client-supplied value is ignored
  // to prevent a signer from backdating or forging the acceptance timestamp.
  const signedAt = new Date().toISOString();

  try {
    // ── 1. Validate token + derive the authoritative dealId from HubSpot ─────
    //    The client-supplied dealId is intentionally ignored for all writes.
    //    We look up the deal association server-side so no client can redirect
    //    note writes to an arbitrary HubSpot deal.
    //
    //    In parallel, fetch the authoritative quote data (total + line items)
    //    so the audit note is built from HubSpot's own records rather than
    //    client-supplied figures that could be tampered with.
    const [validated, authoritative] = await Promise.all([
      validateTokenAndGetDealId(quoteId, body.token),
      fetchQuoteDataForAcceptance(quoteId),
    ]);
    const { dealId: authorizedDealId, status: currentStatus } = validated;

    // ── 1a. Fast serial-replay pre-check ────────────────────────────────────
    //    If HubSpot already shows CLOSED we can return 409 immediately without
    //    touching the database or performing any writes.
    if (currentStatus === "CLOSED") {
      logger.warn({ quoteId }, "Replay attempt on already-accepted quote (HubSpot status=CLOSED)");
      res.status(409).json({ error: "This quote has already been accepted." });
      return;
    }

    // ── 1b. Derive availabilityCheck server-side ────────────────────────────
    //    Compare client-submitted quantities against HubSpot's authoritative
    //    quantities.  Any discrepancy means the order quantities were adjusted
    //    from the original quote and the availability-check flag must be raised.
    //    We never trust the client-supplied flag directly.
    const availabilityCheck = deriveAvailabilityCheck(
      body.lineItems ?? [],
      authoritative.lineItems,
    );

    // ── 2. Atomic claim — transactional INSERT with lease-based takeover ────
    //    A row in quote_acceptances with quote_id as primary key is the single
    //    source of truth for who owns the acceptance.  We use a SERIALIZABLE
    //    transaction to:
    //      a) DELETE any stale uncompleted claim whose lease has expired
    //         (claimed_at > CLAIM_LEASE_MS ago, completed_at IS NULL)
    //      b) INSERT the new claim
    //    If a fresh claim already exists (by another concurrent request or a
    //    recent in-flight attempt) the INSERT will conflict and the transaction
    //    rolls back — we catch that and return 409.
    //
    //    Lease expiry (120 s) bounds how long a crashed / timed-out request can
    //    block the critical acceptance path.
    const CLAIM_LEASE_MS = 120_000; // 2 minutes

    let claimInserted = false;
    try {
      await db.transaction(async (tx) => {
        // Remove any expired uncompleted claim so the signer can retry after a
        // prior request crashed or timed out before releasing.
        const leaseExpiry = new Date(Date.now() - CLAIM_LEASE_MS);
        await tx
          .delete(quoteAcceptancesTable)
          .where(
            and(
              eq(quoteAcceptancesTable.quoteId, quoteId),
              isNull(quoteAcceptancesTable.completedAt),
              lt(quoteAcceptancesTable.claimedAt, leaseExpiry),
            ),
          );

        // Claim ownership — throws on unique conflict if a fresh claim exists.
        await tx.insert(quoteAcceptancesTable).values({
          quoteId,
          signerName: body.signature.name,
          ip,
        });
      });
      claimInserted = true;
    } catch (claimErr) {
      // Distinguish a unique-constraint conflict (expected) from an unexpected
      // database error so we do not silently swallow real failures.
      const pg = claimErr as { code?: string };
      if (pg.code === "23505") {
        // Unique violation — a fresh (non-expired) claim already exists.
        const existing = await db
          .select()
          .from(quoteAcceptancesTable)
          .where(eq(quoteAcceptancesTable.quoteId, quoteId))
          .limit(1);
        const row = existing[0];
        if (row?.completedAt) {
          logger.warn({ quoteId }, "Replay attempt — acceptance already completed (DB claim)");
          res.status(409).json({ error: "This quote has already been accepted." });
        } else {
          // A fresh in-flight request owns the claim.
          logger.warn({ quoteId }, "Concurrent acceptance attempt — claim already held");
          res.status(409).json({
            error: "This quote is currently being processed. Please try again in a moment.",
          });
        }
      } else {
        // Real database error — propagate so the outer catch returns 500.
        throw claimErr;
      }
      return;
    }

    // ── 3. Build note text ───────────────────────────────────────────────────
    //    All financial figures come from HubSpot (authoritative), not from the
    //    client request body.  This prevents a signer from recording a
    //    misleading total, fabricated line items, or a forged timestamp.
    const noteBody = buildNoteBody({
      signerName: body.signature.name,
      signedAt,
      ip,
      ua,
      total: authoritative.total,
      quoteId,
      availabilityCheck,
      lineItems: authoritative.lineItems,
    });

    // ── 4. Write to HubSpot + fire webhook in parallel ───────────────────────
    //    If any of these fail we release the claim (delete the DB row) so the
    //    signer can retry.  On success we stamp completed_at to prevent replays.
    const zapierPayload = {
      event: "quote_accepted",
      quoteId,
      dealId: authorizedDealId,
      signerName: body.signature.name,
      signedAt,
      total: authoritative.total,
      availabilityCheck,
      ip,
      userAgent: ua,
    };

    try {
      await Promise.all([
        createAcceptanceNote(authorizedDealId, noteBody),
        updateQuoteStatusAccepted(quoteId),
        fireZapierWebhook(zapierPayload),
      ]);
    } catch (writeErr) {
      // Release the claim so the signer can retry.
      if (claimInserted) {
        await db
          .delete(quoteAcceptancesTable)
          .where(eq(quoteAcceptancesTable.quoteId, quoteId))
          .catch((delErr) => logger.error({ delErr, quoteId }, "Failed to release acceptance claim after write error"));
      }
      throw writeErr;
    }

    // Mark the claim complete — future replays will see a non-null completed_at.
    await db
      .update(quoteAcceptancesTable)
      .set({ completedAt: new Date() })
      .where(eq(quoteAcceptancesTable.quoteId, quoteId))
      .catch((stampErr) =>
        // Non-fatal: HubSpot status is already CLOSED, so the fast pre-check
        // above will catch replays even if this stamp fails.
        logger.warn({ stampErr, quoteId }, "Failed to stamp completed_at on acceptance claim"),
      );

    logger.info({ quoteId, dealId: authorizedDealId, signerName: body.signature.name }, "Quote accepted");

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
