import { performance } from "node:perf_hooks";
import {
  readResponseText,
  safeFetch,
  sanitizeEvidenceText,
  TargetAccessError,
} from "./target-policy.js";

const ORIGIN = process.env.REVIEW_PROBE_ORIGIN ?? "https://x402-wallet-readiness-service.vercel.app";

export async function inspectEndpoint(target) {
  const probes = [];
  const methods = [
    { method: "HEAD", headers: {} },
    {
      method: "OPTIONS",
      headers: {
        origin: ORIGIN,
        "access-control-request-method": "GET",
        "access-control-request-headers": "payment-signature,content-type",
      },
    },
    { method: "GET", headers: { accept: "application/json,text/plain;q=0.8" } },
  ];

  for (const probe of methods) {
    probes.push(await runProbe(target.url, probe));
  }

  const getProbe = probes.find(probe => probe.method === "GET");
  const challenge = getProbe?.challenge ?? null;
  const snapshot = {
    type: "https_endpoint",
    url: getProbe?.final_url || target.url,
    retrieved_at: new Date().toISOString(),
    probes: probes.map(probe => ({
      method: probe.method,
      status: probe.status,
      ok: probe.ok,
      duration_ms: probe.duration_ms,
      final_url: probe.final_url,
      error: probe.error || null,
    })),
    challenge_present: Boolean(challenge),
    challenge_scheme: challenge?.scheme || null,
    challenge_network: challenge?.network || null,
  };

  return {
    snapshot,
    evidence: {
      type: "https_endpoint",
      url: snapshot.url,
      probes: probes.map(probe => ({
        method: probe.method,
        status: probe.status,
        ok: probe.ok,
        duration_ms: probe.duration_ms,
        headers: probe.headers,
        challenge: probe.challenge,
        body_snippet: probe.body_snippet,
        error: probe.error || null,
      })),
    },
  };
}

async function runProbe(url, { method, headers }) {
  const started = performance.now();
  try {
    const response = await safeFetch(url, {
      method,
      headers,
    });
    const responseHeaders = selectHeaders(response.headers);
    const body = method === "GET" ? await readResponseText(response, 80_000) : "";
    const challenge = parsePaymentChallenge(response.headers, body);
    return {
      method,
      status: response.status,
      ok: response.ok,
      duration_ms: Math.round(performance.now() - started),
      final_url: response.url || url,
      headers: responseHeaders,
      challenge,
      body_snippet: sanitizeEvidenceText(body, 4000),
    };
  } catch (error) {
    if (error instanceof TargetAccessError) {
      return {
        method,
        status: null,
        ok: false,
        duration_ms: Math.round(performance.now() - started),
        final_url: url,
        headers: {},
        challenge: null,
        body_snippet: "",
        error: error.message,
      };
    }
    throw error;
  }
}

function selectHeaders(headers) {
  const names = [
    "content-type",
    "cache-control",
    "access-control-allow-origin",
    "access-control-allow-methods",
    "access-control-allow-headers",
    "www-authenticate",
    "payment-required",
    "payment-signature",
    "x-payment",
    "x-payment-required",
  ];
  return Object.fromEntries(
    names
      .map(name => [name, headers.get(name)])
      .filter(([, value]) => value !== null),
  );
}

function parsePaymentChallenge(headers, body) {
  const raw =
    headers.get("payment-required") ||
    headers.get("x-payment-required") ||
    headers.get("www-authenticate") ||
    "";
  if (!raw && !body) return null;

  const candidates = [raw, decodeBase64(raw), body];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (isPaymentChallengeObject(parsed)) {
        return {
          scheme: parsed.scheme || parsed.x402Version || parsed.version || null,
          network: parsed.network || parsed.accepts?.[0]?.network || null,
          asset: parsed.asset || parsed.accepts?.[0]?.asset || null,
          amount: parsed.amount || parsed.accepts?.[0]?.amount || null,
          payTo: parsed.payTo || parsed.accepts?.[0]?.payTo || null,
          raw: sanitizeEvidenceText(candidate, 2000),
        };
      }
    } catch {
      // Header may be a non-JSON challenge; keep the observation below.
    }
  }

  if (!raw && !/(x402|payment|required)/i.test(body)) return null;
  if (!raw && !/(amount|asset|payto|accepts|scheme)/i.test(body)) return null;
  return {
    scheme: null,
    network: null,
    asset: null,
    amount: null,
    payTo: null,
    raw: sanitizeEvidenceText(raw || body, 2000),
  };
}

function decodeBase64(value) {
  const candidate = String(value).trim();
  if (!/^[A-Za-z0-9+/=_-]+$/.test(candidate) || candidate.length < 8) return "";
  try {
    const decoded = Buffer.from(candidate, "base64url").toString("utf8");
    return decoded.startsWith("{") ? decoded : "";
  } catch {
    return "";
  }
}

function isPaymentChallengeObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (value.scheme || value.x402Version || value.paymentRequired || value.accepts) return true;
  const paymentFields = [value.asset, value.amount, value.payTo].filter(Boolean).length;
  return Boolean(value.network && paymentFields >= 2);
}
