import express, { type Express } from "express";
import cors from "cors";
import { rateLimit } from "express-rate-limit";
import pinoHttp from "pino-http";
import router from "./routes";
import healthRouter from "./routes/health";
import { hubspotWebhookHandler } from "./routes/provision";
import { logger } from "./lib/logger";
import { PgRateLimitStore } from "./lib/pgRateLimitStore";

const app: Express = express();

// ── Health check (registered before all other middleware) ─────────────────
// The deployment startup probe hits /api/healthz on every cold start.
// Registering it here — ahead of pino-http, CORS, and rate limiters —
// ensures an immediate 200 the moment the process is listening, rather
// than waiting for heavier middleware to initialise first.
app.use("/api", healthRouter);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// ── CORS ─────────────────────────────────────────────────────────────────────
// Restrict cross-origin requests to the known quote-viewer origin(s).
// Set CORS_ORIGIN (comma-separated) in the environment to override.
// Falls back to the Replit dev domain when running locally.
function buildAllowedOrigins(): string[] {
  const env = process.env["CORS_ORIGIN"];
  if (env) {
    return env.split(",").map((s) => s.trim()).filter(Boolean);
  }
  // In the Replit environment the dev domain is available via REPLIT_DOMAINS.
  const replitDomains = process.env["REPLIT_DOMAINS"];
  if (replitDomains) {
    // REPLIT_DOMAINS may be comma-separated; accept all of them.
    return replitDomains
      .split(",")
      .map((d) => `https://${d.trim()}`)
      .filter(Boolean);
  }
  // Local dev fallback — disallow unknown origins rather than open-wildcard.
  return ["http://localhost:3000", "http://localhost:5173"];
}

const allowedOrigins = buildAllowedOrigins();
logger.info({ allowedOrigins }, "CORS allowlist configured");

app.use(
  cors({
    origin(origin, callback) {
      // Same-origin / server-to-server requests have no Origin header — allow.
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error(`CORS: origin '${origin}' not allowed`));
    },
  }),
);

// ── Reverse-proxy trust ───────────────────────────────────────────────────────
// The deployment sits behind Replit's ingress proxy.  Trusting one hop tells
// Express to derive the real client IP from the first X-Forwarded-For entry
// added by that proxy, rather than treating the proxy address as the client.
// This is required for per-client rate limiting to work correctly.
app.set("trust proxy", 1);

// ── Rate limiting ─────────────────────────────────────────────────────────────
// A PostgreSQL-backed store is used so counters are shared across all
// autoscaled instances.  Without a shared store each instance would maintain
// independent counters, letting an attacker exhaust N independent budgets.
//
// Limits are intentionally conservative: a real user loads a quote once and
// submits acceptance once.  High request rates from a single IP are a strong
// signal of probing / brute-force.

const FETCH_WINDOW_MS  = 15 * 60 * 1000; // 15 min
const ACCEPT_WINDOW_MS = 15 * 60 * 1000; // 15 min

// Prefix is baked into the PG store so fetch and accept counters stay separate
// without a custom keyGenerator (which would trigger express-rate-limit's IPv6
// safety validation).  The default keyGenerator uses req.ip with proper IPv6
// normalization, which is exactly what we want.

/** GET /api/q/:slug — 30 requests per 15 minutes per IP */
const quoteFetchLimiter = rateLimit({
  windowMs: FETCH_WINDOW_MS,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  store: new PgRateLimitStore(FETCH_WINDOW_MS, "fetch"),
  message: { error: "Too many requests. Please try again later." },
});

/** POST /api/q/:quoteId/accept — 10 requests per 15 minutes per IP */
const quoteAcceptLimiter = rateLimit({
  windowMs: ACCEPT_WINDOW_MS,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  store: new PgRateLimitStore(ACCEPT_WINDOW_MS, "accept"),
  message: { error: "Too many requests. Please try again later." },
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Alias for the HubSpot developer-project webhook target URL. The project posts
// deal-stage changes to /webhooks/deal-stage; this routes that path to the same
// handler as /api/hubspot/webhook. (artifact.toml also routes the /webhooks
// prefix to this service.) Secret-gated like the canonical endpoint; the secret
// may be supplied as a query param, header, OR trailing path segment
// (/webhooks/deal-stage/<secret>) so the webhook target URL needs no query
// string.
app.post("/webhooks/deal-stage", hubspotWebhookHandler);
app.post("/webhooks/deal-stage/:secret", hubspotWebhookHandler);

// Attach rate limiters before the main router so they run on every matching
// request regardless of middleware order inside the router.
app.use("/api/q/:slug", quoteFetchLimiter);
app.use("/api/q/:quoteId/accept", quoteAcceptLimiter);
app.use("/api/d/:dealId", quoteFetchLimiter); // same budget as quote fetch

app.use("/api", router);

export default app;
