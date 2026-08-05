import express from "express";
import { config } from "./config.js";
import { webhooksRouter } from "./routes/webhooks.js";
import { quotesRouter } from "./routes/quotes.js";

const app = express();

app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));

// Raw body is required here so the webhook signature can be verified
// against the exact bytes HubSpot signed.
app.use("/webhooks", express.raw({ type: "application/json" }), webhooksRouter);

app.use(express.json());
app.use("/quotes", quotesRouter);

app.listen(config.port, () => {
  console.log(`branchfurniture_proposals listening on port ${config.port}`);
});
