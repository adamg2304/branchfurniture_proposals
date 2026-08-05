import { Router } from "express";
import { createAndSendQuote } from "../hubspot/quotes.js";

export const quotesRouter = Router();

// Internal endpoint — not called by HubSpot. Wire this up from wherever
// Branch's sales process decides "send this deal's quote now" (a Zapier
// step, an internal tool button, HubSpot workflow custom-code action, etc).
quotesRouter.post("/", async (req, res) => {
  const { dealId, title, expirationDate, senderOwnerId } = req.body ?? {};

  if (!dealId || !title || !expirationDate) {
    res.status(400).json({ error: "dealId, title, and expirationDate are required" });
    return;
  }

  try {
    const result = await createAndSendQuote({ dealId, title, expirationDate, senderOwnerId });
    res.status(201).json(result);
  } catch (error) {
    console.error("Failed to create/send quote:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "unknown error" });
  }
});
