import { randomUUID } from "node:crypto";

export function serviceRuntime(env = process.env) {
  return {
    service: "x402-preflight",
    version: normalizedText(env.SERVICE_VERSION, "1.0.0", 100),
    commitSha: normalizedText(env.GIT_COMMIT_SHA, "unknown", 100),
    deployedAt: normalizedDate(env.DEPLOYED_AT),
  };
}

export function createRequestContextMiddleware(runtime, options = {}) {
  return (req, res, next) => {
    const startedAt = performance.now();
    req.requestId = requestId(req.get("x-request-id"));
    res.set("X-Service-Version", runtime.version);
    res.set("X-Commit-SHA", runtime.commitSha);
    res.set("X-Request-ID", req.requestId);
    res.once("finish", () => {
      options.onResponse?.(req, res, Math.max(0, Math.round(performance.now() - startedAt)));
    });
    next();
  };
}

function requestId(value) {
  const incoming = String(value ?? "").trim();
  if (/^req_[A-Za-z0-9_-]{8,100}$/.test(incoming)) return incoming;
  return `req_${randomUUID().replace(/-/g, "")}`;
}

function normalizedText(value, fallback, maxLength) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, maxLength) : fallback;
}

function normalizedDate(value) {
  const text = String(value ?? "").trim();
  if (!text || !Number.isFinite(Date.parse(text))) return "unknown";
  return new Date(text).toISOString();
}
