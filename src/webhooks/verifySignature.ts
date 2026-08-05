import crypto from "node:crypto";

const MAX_TIMESTAMP_AGE_MS = 5 * 60 * 1000;

export interface VerifySignatureInput {
  method: string;
  requestUrl: string;
  rawBody: string;
  signatureHeader: string | undefined;
  timestampHeader: string | undefined;
  clientSecret: string;
  now?: number;
}

/**
 * Verifies HubSpot's v3 webhook signature.
 * https://developers.hubspot.com/docs/apps/legacy-apps/authentication/validating-requests
 *
 * requestUrl must be the exact URI HubSpot used to compute the signature
 * (scheme+host+path+query as configured on the webhook subscription), not
 * whatever a reverse proxy rewrote it to — hence it's passed in rather than
 * derived from the Express request.
 */
export function verifyHubSpotSignatureV3(input: VerifySignatureInput): boolean {
  const { method, requestUrl, rawBody, signatureHeader, timestampHeader, clientSecret, now } = input;

  if (!signatureHeader || !timestampHeader) {
    return false;
  }

  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) {
    return false;
  }

  const currentTime = now ?? Date.now();
  if (Math.abs(currentTime - timestamp) > MAX_TIMESTAMP_AGE_MS) {
    return false;
  }

  const message = `${method.toUpperCase()}${requestUrl}${rawBody}${timestampHeader}`;
  const expected = crypto.createHmac("sha256", clientSecret).update(message, "utf8").digest("base64");

  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(signatureHeader);

  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}
