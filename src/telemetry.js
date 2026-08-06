import { createHash } from "node:crypto";
import { storeTelemetryEvent } from "./order-store.js";

export const TELEMETRY_EVENTS = new Set([
  "discovery_view",
  "agent_manifest_view",
  "openapi_view",
  "llms_view",
  "mcp_tools_listed",
  "preflight_inspection_completed",
  "payment_challenge_served",
  "payment_verification_started",
  "payment_settled",
  "resource_delivered",
  "resource_failed",
  "repeat_buyer_detected",
  "remediation_order_created",
  "remediation_order_completed",
]);

const ALLOWED_FIELDS = [
  "event",
  "timestamp",
  "request_id",
  "route",
  "method",
  "status_code",
  "latency_ms",
  "price_usd",
  "network",
  "facilitator",
  "discovery_source",
  "error_code",
  "buyer_wallet_hash",
];

export function createTelemetry(options = {}) {
  const enabled = options.enabled ?? process.env.TELEMETRY_ENABLED !== "false";
  const databaseEnabled =
    options.databaseEnabled ?? process.env.TELEMETRY_DATABASE_ENABLED !== "false";
  const pepper = String(options.buyerPepper ?? process.env.TELEMETRY_BUYER_PEPPER ?? "");
  const logger = options.logger ?? console;
  const store = options.store ?? storeTelemetryEvent;
  const now = options.now ?? (() => new Date());

  const record = (event, fields = {}) => {
    if (!enabled || !TELEMETRY_EVENTS.has(event)) return null;
    const payload = sanitizeEvent({
      event,
      timestamp: now().toISOString(),
      ...fields,
    });
    safeLog(logger, "log", payload);
    if (databaseEnabled) {
      void Promise.resolve().then(() => store(payload)).catch(() => {
        safeLog(logger, "error", sanitizeEvent({
          event: "resource_failed",
          timestamp: now().toISOString(),
          route: payload.route ?? "telemetry",
          error_code: "TELEMETRY_STORE_FAILED",
        }));
      });
    }
    return payload;
  };

  return {
    enabled,
    record,
    buyerWalletHash(wallet) {
      const normalized = String(wallet ?? "").trim().toLowerCase();
      if (!pepper || !normalized) return null;
      return createHash("sha256")
        .update(`${pepper}:${normalized}`)
        .digest("hex");
    },
    onHttpResponse(req, res, latencyMs) {
      const route = requestPath(req);
      const common = {
        request_id: req.requestId,
        route,
        method: req.method,
        status_code: res.statusCode,
        latency_ms: latencyMs,
        discovery_source: discoverySource(req),
        ...(res.locals.telemetry ?? {}),
      };
      const discoveryEvent = discoveryEventForPath(route);
      if (discoveryEvent && res.statusCode < 500) record(discoveryEvent, common);
      if (res.statusCode === 402) record("payment_challenge_served", common);
      if (res.statusCode >= 200 && res.statusCode < 300 && hasPaymentAttempt(req)) {
        record("resource_delivered", common);
      }
      if (res.statusCode >= 500) {
        record("resource_failed", {
          ...common,
          error_code: res.locals.errorCode ?? `HTTP_${res.statusCode}`,
        });
      }
    },
  };
}

export function sanitizeEvent(value) {
  const output = {};
  for (const field of ALLOWED_FIELDS) {
    const normalized = normalizeField(field, value?.[field]);
    if (normalized !== undefined && normalized !== null && normalized !== "") {
      output[field] = normalized;
    }
  }
  if (!TELEMETRY_EVENTS.has(output.event)) {
    throw new Error("unsupported telemetry event");
  }
  return output;
}

function normalizeField(field, value) {
  if (value === undefined || value === null) return null;
  if (["status_code", "latency_ms"].includes(field)) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.round(number)) : null;
  }
  if (field === "price_usd") {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  }
  if (field === "buyer_wallet_hash") {
    const hash = String(value).trim().toLowerCase();
    return /^[a-f0-9]{64}$/.test(hash) ? hash : null;
  }
  if (field === "discovery_source") {
    const source = String(value).trim();
    return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/.test(source) ? source : null;
  }
  if (field === "facilitator") return publicUrl(value);
  const maximum = field === "buyer_wallet_hash" ? 64 : 500;
  return String(value)
    .replace(/[\r\n\t]/g, " ")
    .slice(0, maximum);
}

function publicUrl(value) {
  try {
    const url = new URL(String(value));
    if (!/^https?:$/.test(url.protocol)) return null;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().slice(0, 500);
  } catch {
    return null;
  }
}

function safeLog(logger, level, payload) {
  try {
    logger?.[level]?.(JSON.stringify(payload));
  } catch {
    // Telemetry is deliberately fail-open.
  }
}

function discoveryEventForPath(path) {
  if (["/manifest", "/.well-known/agent.json"].includes(path)) {
    return "agent_manifest_view";
  }
  if (path === "/openapi.json") return "openapi_view";
  if (path === "/llms.txt") return "llms_view";
  if (["/.well-known/x402", "/.well-known/x402.json", "/.well-known/ai.txt"].includes(path)) {
    return "discovery_view";
  }
  return null;
}

function discoverySource(req) {
  const value = req.get?.("x-discovery-source") ?? req.query?.discovery_source;
  return value ? String(value).slice(0, 100) : null;
}

function hasPaymentAttempt(req) {
  return [
    "payment-signature",
    "x-payment",
    "payment",
    "x-402-payment",
    "x402-payment",
  ].some(name => Boolean(req.get?.(name)));
}

function requestPath(req) {
  const original = String(req.originalUrl ?? req.path ?? "");
  return original.split("?", 1)[0] || "/";
}
