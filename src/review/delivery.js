import crypto from "node:crypto";
import { assertPublicUrl, safeFetch, readResponseText } from "./target-policy.js";

const WEBHOOK_SIGNING_KEY = String(process.env.WEBHOOK_SIGNING_KEY ?? "").trim();

export function validateCallbackUrl(value) {
  if (value === undefined || value === null || value === "") return null;
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new Error("callback_url must be a valid HTTPS URL");
  }
  if (url.protocol !== "https:") throw new Error("callback_url must use HTTPS");
  if (url.username || url.password) throw new Error("callback_url must not contain credentials");
  return url.toString();
}

export async function sendWebhook(delivery) {
  if (!WEBHOOK_SIGNING_KEY) throw new Error("WEBHOOK_SIGNING_KEY is not configured");
  const callbackUrl = await assertPublicUrl(delivery.destination);
  if (callbackUrl.protocol !== "https:") throw new Error("webhook destination must use HTTPS");

  const status = delivery.result_json?.status || "completed";
  const event = {
    event: `x402.order.${status}`,
    event_id: delivery.event_id,
    order_id: delivery.order_id,
    service: delivery.service,
    status,
    verdict: delivery.result_json?.verdict || null,
    summary: delivery.result_json?.summary || null,
    result_url:
      delivery.result_json?.result_url ||
      `${String(process.env.PUBLIC_URL || "https://x402-wallet-readiness-service.vercel.app").replace(/\/$/, "")}/api/x402/orders/${encodeURIComponent(delivery.order_id)}/result`,
    completed_at: delivery.result_json?.completed_at || null,
  };
  const body = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createWebhookSignature(WEBHOOK_SIGNING_KEY, timestamp, body);

  const response = await safeFetch(callbackUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": "x402-wallet-readiness-review-worker",
      "x-x402-event-id": delivery.event_id,
      "x-x402-timestamp": timestamp,
      "x-x402-signature": `sha256=${signature}`,
    },
    body,
  }, { timeoutMs: 10_000, maxRedirects: 2 });

  if (!response.ok) {
    const text = await readResponseText(response, 2000).catch(() => "");
    throw new Error(`webhook returned HTTP ${response.status}${text ? `: ${text.slice(0, 300)}` : ""}`);
  }
  return { status: response.status, event };
}

export function createWebhookSignature(secret, timestamp, body) {
  return crypto
    .createHmac("sha256", String(secret))
    .update(`${timestamp}.${body}`)
    .digest("hex");
}

export function verifyWebhookSignature(secret, timestamp, body, received) {
  const expected = createWebhookSignature(secret, timestamp, body);
  const actual = String(received || "").replace(/^sha256=/, "");
  const expectedBuffer = Buffer.from(expected, "hex");
  const actualBuffer = Buffer.from(actual, "hex");
  return actualBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}
