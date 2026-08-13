/**
 * POST /api/q/:dealId/accept
 *
 * Validates the deal-based quote token, records the signature audit trail as a
 * HubSpot note on the deal, advances the deal to the accepted stage, and
 * optionally fires the Zapier webhook.
 *
 * The quote is deal-centric: the URL param is a HubSpot deal ID and the token
 * is validated against the value embedded in the deal's own `hub_quote_link`.
 *
 * Request body (JSON):
 *   dealId           — HubSpot deal ID (must match URL param if provided)
 *   token            — token from window.QUOTE.meta (embedded in hub_quote_link)
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
  validateDealTokenAndStatus,
  fetchDealDataForAcceptance,
  createAcceptanceNote,
  advanceDealStageAccepted,
  TokenMismatchError,
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
  dealId: string;
  availabilityCheck: boolean;
  lineItems: Array<{ sku?: string; name?: string; qty: number; price: number; quotedQty?: number }>;
}): string {
  const lines: string[] = [
    `Quote for deal #${opts.dealId} accepted via Branch quote portal`,
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

async function fireAcceptanceWebhook(payload: Record<string, unknown>): Promise<void> {
  // ACCEPTANCE_WEBHOOK_URL is the HubSpot workflow webhook-trigger (or any
  // endpoint) to ping when a quote is accepted. ZAPIER_WEBHOOK_URL is kept as a
  // backward-compatible fallback.
  const url = process.env["ACCEPTANCE_WEBHOOK_URL"] || process.env["ZAPIER_WEBHOOK_URL"];
  if (!url) {
    logger.warn("ACCEPTANCE_WEBHOOK_URL not set — skipping acceptance webhook");
    return;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, "Acceptance webhook returned non-2xx");
    } else {
      logger.info("Acceptance webhook fired successfully");
    }
  } catch (err) {
    // Non-fatal — log and continue
    logger.warn({ err }, "Acceptance webhook request failed");
  }
}

router.post("/q/:dealId/accept", async (req: Request, res: Response) => {
  const rawDealId = req.params["dealId"];
  const dealId: string = Array.isArray(rawDealId)
    ? (rawDealId[0] ?? "")
    : (rawDealId ?? "");

  if (!dealId) {
    res.status(400).json({ error: "Missing dealId in URL" });
    return;
  }

  const body = req.body as {
    quoteId?: string;  // informational only (deal-centric flow) — never used for writes
    dealId?: string;
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

  // If the client sends dealId in the body it must match the URL param.
  // This guards against confused-deputy payloads where the URL and body disagree.
  if (body.dealId !== undefined && body.dealId !== dealId) {
    res.status(400).json({ error: "dealId in body does not match URL" });
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
    // ── 1. Validate token against the deal's own hub_quote_link ──────────────
    //    The token is the gate. In parallel, fetch the authoritative acceptance
    //    data (total + line items) from the deal's own line items so the audit
    //    note is built from HubSpot's own records rather than client-supplied
    //    figures that could be tampered with.
    const [validated, authoritative] = await Promise.all([
      validateDealTokenAndStatus(dealId, body.token),
      fetchDealDataForAcceptance(dealId),
    ]);
    const authorizedDealId = dealId;

    // ── 1a. Fast serial-replay pre-check ────────────────────────────────────
    //    If the deal already sits in the accepted stage we can return 409
    //    immediately without touching the database or performing any writes.
    if (validated.alreadyAccepted) {
      logger.warn({ dealId }, "Replay attempt on already-accepted deal (already in accepted stage)");
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
    //    A row in quote_acceptances keyed by the deal ID is the single source
    //    of truth for who owns the acceptance (the quote_id column stores the
    //    deal ID in this deal-centric flow).  We use a SERIALIZABLE
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
              eq(quoteAcceptancesTable.quoteId, dealId),
              isNull(quoteAcceptancesTable.completedAt),
              lt(quoteAcceptancesTable.claimedAt, leaseExpiry),
            ),
          );

        // Claim ownership — throws on unique conflict if a fresh claim exists.
        await tx.insert(quoteAcceptancesTable).values({
          quoteId: dealId,
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
          .where(eq(quoteAcceptancesTable.quoteId, dealId))
          .limit(1);
        const row = existing[0];
        if (row?.completedAt) {
          logger.warn({ dealId }, "Replay attempt — acceptance already completed (DB claim)");
          res.status(409).json({ error: "This quote has already been accepted." });
        } else {
          // A fresh in-flight request owns the claim.
          logger.warn({ dealId }, "Concurrent acceptance attempt — claim already held");
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
      dealId,
      availabilityCheck,
      lineItems: authoritative.lineItems,
    });

    // ── 4. Write to HubSpot + fire webhook in parallel ───────────────────────
    //    If any of these fail we release the claim (delete the DB row) so the
    //    signer can retry.  On success we stamp completed_at to prevent replays.
    const zapierPayload = {
      event: "quote_accepted",
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
        advanceDealStageAccepted(authorizedDealId),
        fireAcceptanceWebhook(zapierPayload),
      ]);
    } catch (writeErr) {
      // Release the claim so the signer can retry.
      if (claimInserted) {
        await db
          .delete(quoteAcceptancesTable)
          .where(eq(quoteAcceptancesTable.quoteId, dealId))
          .catch((delErr) => logger.error({ delErr, dealId }, "Failed to release acceptance claim after write error"));
      }
      throw writeErr;
    }

    // Mark the claim complete — future replays will see a non-null completed_at.
    await db
      .update(quoteAcceptancesTable)
      .set({ completedAt: new Date() })
      .where(eq(quoteAcceptancesTable.quoteId, dealId))
      .catch((stampErr) =>
        // Non-fatal: the DB claim and (when configured) the accepted deal stage
        // also guard against replays even if this stamp fails.
        logger.warn({ stampErr, dealId }, "Failed to stamp completed_at on acceptance claim"),
      );

    logger.info({ dealId: authorizedDealId, signerName: body.signature.name }, "Quote accepted");

    res.status(200).json({ ok: true, message: "Quote accepted successfully" });
  } catch (err) {
    if (err instanceof TokenMismatchError) {
      logger.warn({ dealId }, "Token mismatch on accept");
      res.status(403).json({ error: "Invalid or expired quote link" });
      return;
    }

    logger.error({ err, dealId }, "Error processing quote acceptance");
    res.status(500).json({ error: "Failed to record acceptance. Please try again or contact your Branch rep." });
  }
});

export default router;
