"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const config = require("./config");

/**
 * Token store: maps an unguessable token → dealId.
 *
 * The link is STABLE — once a deal has a token, we reuse it forever (the link a
 * rep already sent keeps working). The page renders live from HubSpot on every
 * open, so "reuse the token" does NOT mean "stale data" — content is always current.
 *
 * Storage is a JSON file on disk for the pilot. It's deliberately isolated behind
 * this module so it can be swapped for Airtable (or the Hub's DB) without touching
 * any route code — just reimplement load()/save().
 *
 * Shape: { [token]: { dealId, createdAt } , _byDeal: { [dealId]: token } }
 */

const STORE_PATH =
  process.env.TOKEN_STORE_PATH || path.join(__dirname, "..", ".token-store.json");

function load() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
  } catch {
    return { byToken: {}, byDeal: {} };
  }
}

function save(store) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

function mintToken() {
  return crypto.randomBytes(config.tokenBytes).toString("base64url");
}

/**
 * Return the existing token for a deal, or create one. Idempotent: re-triggering
 * the "Quote Ready" workflow on the same deal returns the same link.
 */
function getOrCreateTokenForDeal(dealId) {
  dealId = String(dealId);
  const store = load();
  const existing = store.byDeal[dealId];
  if (existing) return existing;

  const token = mintToken();
  store.byToken[token] = { dealId, createdAt: new Date().toISOString() };
  store.byDeal[dealId] = token;
  save(store);
  return token;
}

/** Resolve a token back to its dealId, or null if unknown. */
function resolveToken(token) {
  if (!token) return null;
  const store = load();
  const entry = store.byToken[token];
  return entry ? entry.dealId : null;
}

/** Build the full public link for a deal's token. */
function buildLink(token) {
  return `${config.publicBaseUrl}/q/${token}`;
}

module.exports = {
  getOrCreateTokenForDeal,
  resolveToken,
  buildLink,
};
