/**
 * OpenAI webhook signatures (Standard Webhooks, https://www.standardwebhooks.com, as OpenAI's SDK
 * verifies them in `client.webhooks.unwrap`):
 * - headers `webhook-id`, `webhook-timestamp` (Unix seconds) and `webhook-signature`, a
 *   space-separated list of `v1,<base64 HMAC>` entries;
 * - the HMAC is SHA-256 over `${id}.${timestamp}.${rawBody}`, keyed with the base64 secret after
 *   its `whsec_` prefix (a secret without the prefix is used as UTF-8 text);
 * - the timestamp must be within five minutes of now, either way, so a captured request cannot
 *   be replayed later.
 * Verify the raw body exactly as received, before parsing it.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export class WebhookSignatureError extends Error {}

export interface WebhookHeaders {
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
}

const TOLERANCE_SECONDS = 300;

function key(secret: string): Buffer {
  return secret.startsWith("whsec_") ? Buffer.from(secret.slice("whsec_".length), "base64") : Buffer.from(secret, "utf8");
}

function hmac(rawBody: string, id: string, timestamp: string, secret: string): Buffer {
  return createHmac("sha256", key(secret)).update(`${id}.${timestamp}.${rawBody}`, "utf8").digest();
}

/** Throws WebhookSignatureError unless the request is OpenAI's, unaltered and recent. */
export function verifyWebhook(rawBody: string, headers: WebhookHeaders, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): void {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) throw new WebhookSignatureError("Missing webhook signature headers.");
  const sent = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(sent)) throw new WebhookSignatureError("Invalid webhook timestamp.");
  if (Math.abs(nowSeconds - sent) > TOLERANCE_SECONDS) throw new WebhookSignatureError("Webhook timestamp is outside the five-minute window.");
  const expected = hmac(rawBody, id, timestamp, secret);
  // At most 32 candidates, as in OpenAI's SDK, so a long header cannot cost unbounded work.
  for (const entry of signature.split(" ").slice(0, 32)) {
    const candidate = Buffer.from(entry.startsWith("v1,") ? entry.slice(3) : entry, "base64");
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) return;
  }
  throw new WebhookSignatureError("Webhook signature does not match.");
}

/** A `webhook-signature` value for a body, as OpenAI sends it. Used by tests and scripts/phone-check.ts. */
export function signWebhook(rawBody: string, id: string, timestamp: number, secret: string): string {
  return `v1,${hmac(rawBody, id, String(timestamp), secret).toString("base64")}`;
}
