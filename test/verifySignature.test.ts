import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { verifyHubSpotSignatureV3 } from "../src/webhooks/verifySignature.js";

const clientSecret = "test-secret";
const requestUrl = "https://proposals.branchfurniture.com/webhooks/hubspot/quotes";
const rawBody = JSON.stringify([{ objectId: 1 }]);

function sign(method: string, url: string, body: string, timestamp: string, secret: string): string {
  const message = `${method}${url}${body}${timestamp}`;
  return crypto.createHmac("sha256", secret).update(message, "utf8").digest("base64");
}

test("accepts a correctly signed request", () => {
  const now = 1_700_000_000_000;
  const timestamp = String(now - 1000);
  const signature = sign("POST", requestUrl, rawBody, timestamp, clientSecret);

  const result = verifyHubSpotSignatureV3({
    method: "POST",
    requestUrl,
    rawBody,
    signatureHeader: signature,
    timestampHeader: timestamp,
    clientSecret,
    now,
  });

  assert.equal(result, true);
});

test("rejects a request signed with the wrong secret", () => {
  const now = 1_700_000_000_000;
  const timestamp = String(now - 1000);
  const signature = sign("POST", requestUrl, rawBody, timestamp, "wrong-secret");

  const result = verifyHubSpotSignatureV3({
    method: "POST",
    requestUrl,
    rawBody,
    signatureHeader: signature,
    timestampHeader: timestamp,
    clientSecret,
    now,
  });

  assert.equal(result, false);
});

test("rejects a tampered body even with a valid-looking signature", () => {
  const now = 1_700_000_000_000;
  const timestamp = String(now - 1000);
  const signature = sign("POST", requestUrl, rawBody, timestamp, clientSecret);

  const result = verifyHubSpotSignatureV3({
    method: "POST",
    requestUrl,
    rawBody: JSON.stringify([{ objectId: 999 }]),
    signatureHeader: signature,
    timestampHeader: timestamp,
    clientSecret,
    now,
  });

  assert.equal(result, false);
});

test("rejects a stale timestamp beyond the 5 minute window", () => {
  const now = 1_700_000_000_000;
  const timestamp = String(now - 6 * 60 * 1000);
  const signature = sign("POST", requestUrl, rawBody, timestamp, clientSecret);

  const result = verifyHubSpotSignatureV3({
    method: "POST",
    requestUrl,
    rawBody,
    signatureHeader: signature,
    timestampHeader: timestamp,
    clientSecret,
    now,
  });

  assert.equal(result, false);
});

test("rejects when headers are missing", () => {
  const result = verifyHubSpotSignatureV3({
    method: "POST",
    requestUrl,
    rawBody,
    signatureHeader: undefined,
    timestampHeader: undefined,
    clientSecret,
  });

  assert.equal(result, false);
});
