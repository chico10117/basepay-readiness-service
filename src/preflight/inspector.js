import { performance } from "node:perf_hooks";
import {
  assertPublicUrl,
  readResponseText,
  safeFetchWithTrace,
  TargetAccessError,
} from "../review/target-policy.js";
import { parseX402Challenge } from "./challenge.js";
import { validatePreflightInput } from "./schemas.js";

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_BYTES = 256 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_TTL_SECONDS = 15 * 60;
const DEFAULT_PROBE_ORIGIN = "https://x402-preflight.dev";
const PAYMENT_HEADER_NAMES = [
  "payment-signature",
  "x-payment",
  "payment",
  "x-402-payment",
  "x402-payment",
];
const PAYMENT_EXPOSE_HEADER_NAMES = [
  "payment-required",
  "x-payment-required",
  "payment-response",
  "x-payment-response",
  "payment-signature",
  "x-payment",
];

export async function inspectX402Endpoint(value, options = {}) {
  const input = validatePreflightInput(value, {
    defaultNetwork: options.defaultNetwork,
  });
  const profile = options.profile === "audit" ? "audit" : "inspect";
  const requestId = normalizeRequestId(options.requestId);
  const observedAt = dateValue(options.now);
  const ttlSeconds = boundedInteger(
    options.ttlSeconds ?? process.env.PREFLIGHT_REPORT_TTL_SECONDS,
    DEFAULT_TTL_SECONDS,
    60,
    86_400,
  );
  const timeoutMs = boundedInteger(
    options.timeoutMs ?? process.env.PREFLIGHT_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    250,
    30_000,
  );
  const maxBytes = boundedInteger(
    options.maxBytes ?? process.env.PREFLIGHT_MAX_RESPONSE_BYTES,
    DEFAULT_MAX_BYTES,
    1_024,
    2 * 1024 * 1024,
  );
  const maxRedirects = boundedInteger(
    options.maxRedirects ?? process.env.PREFLIGHT_MAX_REDIRECTS,
    DEFAULT_MAX_REDIRECTS,
    0,
    5,
  );
  const securityOptions = {
    lookup: options.lookup,
    fetchImpl: options.fetchImpl,
    httpsOnly: true,
    timeoutMs,
    maxRedirects,
  };

  await assertPublicUrl(input.resource_url, securityOptions);
  const origin =
    options.probeOrigin ?? process.env.PREFLIGHT_PROBE_ORIGIN ?? DEFAULT_PROBE_ORIGIN;
  const [mainProbe, corsProbe] = await Promise.all([
    probeResource(input, {
      ...securityOptions,
      maxBytes,
      origin,
    }),
    probeCors(input, {
      ...securityOptions,
      origin,
    }),
  ]);
  const challenge = parseX402Challenge(mainProbe.response.headers, mainProbe.body, {
    usdcContract: options.usdcContract,
    usdcContracts: options.usdcContracts,
  });
  const cors = buildCors(
    mainProbe.response.headers,
    corsProbe?.headers,
    input.method,
    origin,
  );
  const discovery = profile === "audit"
    ? await inspectDiscovery(input.resource_url, challenge.payment, {
        ...securityOptions,
        maxBytes: Math.min(maxBytes, 128 * 1024),
      })
    : emptyDiscovery(input.resource_url);
  const assessment = assess({
    input,
    profile,
    statusCode: mainProbe.response.status,
    payment: challenge.payment,
    schemaIssues: challenge.schemaIssues,
    contradictions: challenge.contradictions,
    cors,
    discovery,
    operational: mainProbe,
  });

  return {
    profile,
    decision: assessment.decision,
    score: assessment.score,
    requestId,
    observedAt: observedAt.toISOString(),
    expiresAt: new Date(observedAt.getTime() + ttlSeconds * 1000).toISOString(),
    resource: {
      url: input.resource_url,
      method: input.method,
      finalUrl: mainProbe.finalUrl,
      statusCode: mainProbe.response.status,
      latencyMs: mainProbe.latencyMs,
    },
    payment: challenge.payment,
    cors,
    checks: assessment.checks,
    issues: assessment.issues,
    discovery,
    operational: {
      contentType: header(mainProbe.response.headers, "content-type"),
      cacheControl: header(mainProbe.response.headers, "cache-control"),
      responseBytes: Buffer.byteLength(mainProbe.body),
      timeoutMs,
      redirectChain: mainProbe.redirects,
    },
    evidence: buildEvidence(mainProbe, corsProbe, challenge, discovery),
    claimBoundary: {
      proves: [
        "The listed HTTP, payment, discovery, and operational signals were observed without sending payment credentials.",
        "The target and every followed redirect passed the configured public-network checks at observation time.",
      ],
      doesNotProve: [
        "That the seller will remain available or keep the same requirements after this report expires.",
        "That the receiver controls a trustworthy service or that downstream contracts are safe.",
        "That a future payment will verify, settle, or produce the advertised business outcome.",
      ],
    },
  };
}

async function probeResource(input, options) {
  const headers = {
    accept: "application/json, text/plain;q=0.8, */*;q=0.1",
    origin: options.origin,
    "user-agent": "x402-preflight/1.0",
  };
  const init = { method: input.method, headers };
  if (input.method === "POST") {
    headers["content-type"] = "application/json";
    init.body = "{}";
  }
  const started = performance.now();
  const fetched = await safeFetchWithTrace(input.resource_url, init, options);
  const body = input.method === "HEAD"
    ? ""
    : await readResponseText(fetched.response, options.maxBytes, {
        deadlineAt: fetched.deadlineAt,
      });
  return {
    ...fetched,
    body,
    latencyMs: Math.max(0, Math.round(performance.now() - started)),
  };
}

async function probeCors(input, options) {
  try {
    const fetched = await safeFetchWithTrace(
      input.resource_url,
      {
        method: "OPTIONS",
        headers: {
          origin: options.origin,
          "access-control-request-method": input.method,
          "access-control-request-headers": "content-type,payment-signature",
          "user-agent": "x402-preflight/1.0",
        },
      },
      options,
    );
    await fetched.response.body?.cancel().catch(() => {});
    return {
      statusCode: fetched.response.status,
      headers: fetched.response.headers,
      finalUrl: fetched.finalUrl,
    };
  } catch (error) {
    if (error instanceof TargetAccessError && error.retryable) return null;
    throw error;
  }
}

function buildCors(responseHeaders, optionsHeaders, method, probeOrigin) {
  const allowOrigin =
    header(optionsHeaders, "access-control-allow-origin") ??
    header(responseHeaders, "access-control-allow-origin");
  const allowMethods = splitHeader(
    header(optionsHeaders, "access-control-allow-methods") ??
      header(responseHeaders, "access-control-allow-methods"),
  );
  const allowHeaders = splitHeader(
    header(optionsHeaders, "access-control-allow-headers") ??
      header(responseHeaders, "access-control-allow-headers"),
  );
  const normalizedHeaders = allowHeaders.map(value => value.toLowerCase());
  const exposeHeaders = splitHeader(
    header(optionsHeaders, "access-control-expose-headers") ??
      header(responseHeaders, "access-control-expose-headers"),
  );
  const normalizedExposed = exposeHeaders.map(value => value.toLowerCase());
  const credentialsValue =
    header(optionsHeaders, "access-control-allow-credentials") ??
    header(responseHeaders, "access-control-allow-credentials");
  const allowCredentials = credentialsValue === null
    ? null
    : credentialsValue.toLowerCase() === "true";
  const originAllowed = allowOrigin === probeOrigin ||
    (allowOrigin === "*" && allowCredentials !== true);
  const methodAllowed = allowMethods.includes("*") || allowMethods.includes(method);
  const paymentAllowed = normalizedHeaders.includes("*") ||
    normalizedHeaders.some(value => PAYMENT_HEADER_NAMES.includes(value));
  const paymentExposed = normalizedExposed.includes("*") ||
    normalizedExposed.some(value => PAYMENT_EXPOSE_HEADER_NAMES.includes(value));
  return {
    allowOrigin,
    allowMethods,
    allowHeaders,
    exposeHeaders,
    allowCredentials,
    browserAgentCompatible:
      originAllowed && methodAllowed && paymentAllowed && paymentExposed,
  };
}

async function inspectDiscovery(resourceUrl, payment, options) {
  const origin = new URL(resourceUrl).origin;
  const definitions = [
    ["openapi", "/openapi.json", "json"],
    ["llmsTxt", "/llms.txt", "text"],
    ["agentMetadata", "/.well-known/agent.json", "json"],
    ["x402Metadata", "/.well-known/x402.json", "json"],
  ];
  const entries = await Promise.all(
    definitions.map(async ([key, path, format]) => [
      key,
      await inspectDiscoveryResource(
        new URL(path, origin).toString(),
        format,
        resourceUrl,
        payment,
        options,
      ),
    ]),
  );
  return Object.fromEntries(entries);
}

async function inspectDiscoveryResource(url, format, resourceUrl, payment, options) {
  try {
    const fetched = await safeFetchWithTrace(
      url,
      {
        method: "GET",
        headers: {
          accept: format === "json" ? "application/json" : "text/plain",
          "user-agent": "x402-preflight/1.0",
        },
      },
      options,
    );
    const text = await readResponseText(fetched.response, options.maxBytes, {
      deadlineAt: fetched.deadlineAt,
    });
    const present = fetched.response.status >= 200 && fetched.response.status < 300;
    const parsed = format === "json" ? parseJson(text) : text;
    const valid = present
      ? format === "json"
        ? Boolean(parsed)
        : Boolean(text.trim())
      : false;
    return {
      url,
      statusCode: fetched.response.status,
      contentType: header(fetched.response.headers, "content-type"),
      present,
      valid,
      consistent: valid
        ? discoveryConsistency(url, parsed, resourceUrl, payment)
        : null,
    };
  } catch (error) {
    if (!(error instanceof TargetAccessError)) throw error;
    return {
      url,
      statusCode: null,
      contentType: null,
      present: false,
      valid: null,
      consistent: null,
    };
  }
}

function discoveryConsistency(discoveryUrl, value, resourceUrl, payment) {
  const path = new URL(resourceUrl).pathname;
  if (discoveryUrl.endsWith("/openapi.json")) {
    return Boolean(value?.openapi && value?.paths?.[path]);
  }
  if (discoveryUrl.endsWith("/llms.txt")) {
    return String(value).includes(path) || String(value).includes(resourceUrl);
  }
  if (discoveryUrl.endsWith("/.well-known/agent.json")) {
    const serialized = JSON.stringify(value);
    return serialized.includes(path) || serialized.includes("audit_x402_endpoint");
  }
  if (discoveryUrl.endsWith("/.well-known/x402.json")) {
    const resources = Array.isArray(value?.resources) ? value.resources : [];
    const resource = resources.find(item => {
      try {
        return new URL(item.url).pathname === path;
      } catch {
        return false;
      }
    });
    if (!resource) return false;
    const requirement = Array.isArray(resource.accepts) ? resource.accepts[0] : null;
    if (!requirement || !payment.detected) return null;
    const published = {
      network: requirement.network,
      asset: requirement.asset,
      amountAtomic: requirement.amount ?? requirement.maxAmountRequired,
      payTo: requirement.payTo ?? requirement.pay_to,
    };
    return ["network", "asset", "amountAtomic", "payTo"]
      .every(field => !payment[field] || sameText(published[field], payment[field]));
  }
  return null;
}

function emptyDiscovery(resourceUrl) {
  const origin = new URL(resourceUrl).origin;
  return {
    openapi: emptyDiscoverySignal(`${origin}/openapi.json`),
    llmsTxt: emptyDiscoverySignal(`${origin}/llms.txt`),
    agentMetadata: emptyDiscoverySignal(`${origin}/.well-known/agent.json`),
    x402Metadata: emptyDiscoverySignal(`${origin}/.well-known/x402.json`),
  };
}

function emptyDiscoverySignal(url) {
  return {
    url,
    statusCode: null,
    contentType: null,
    present: false,
    valid: null,
    consistent: null,
  };
}

function assess(context) {
  const checks = [];
  const issues = [];
  const addCheck = (id, status, severity, evidence) => {
    checks.push({ id, status, severity, evidence });
  };
  const addIssue = (code, severity, retryable, message, remediation) => {
    issues.push({ code, severity, retryable, message, remediation });
  };

  if (context.statusCode === 402) {
    addCheck("http.payment_required", "PASS", "info", "The target returned HTTP 402.");
  } else {
    addCheck(
      "http.payment_required",
      "FAIL",
      "high",
      `The target returned HTTP ${context.statusCode}, not HTTP 402.`,
    );
    addIssue(
      "PAYMENT_CHALLENGE_NOT_SERVED",
      "high",
      false,
      "The requested resource did not return HTTP 402 without payment credentials.",
      "Place x402 payment middleware before the resource handler and return a challenge before executing paid work.",
    );
  }

  if (!context.payment.detected) {
    addCheck("payment.challenge_decoded", "FAIL", "high", "No decodable x402 challenge was found.");
    addIssue(
      "MISSING_X402_CHALLENGE",
      "high",
      false,
      "No x402 challenge could be decoded from the response headers or body.",
      "Return a protocol-compliant PAYMENT-REQUIRED header containing the x402 PaymentRequired object.",
    );
  } else if (context.schemaIssues.length) {
    addCheck(
      "payment.requirements_schema",
      "FAIL",
      "high",
      context.schemaIssues.join(" "),
    );
    addIssue(
      "INVALID_X402_CHALLENGE",
      "high",
      false,
      context.schemaIssues.join(" "),
      "Publish complete x402 payment requirements with version, scheme, network, asset, integer amount, and receiver.",
    );
  } else {
    addCheck(
      "payment.requirements_schema",
      "PASS",
      "info",
      "The observed payment requirement contains the required normalized fields.",
    );
  }

  assessNetworkPolicy(context, addCheck, addIssue);
  assessPricePolicy(context, addCheck, addIssue);

  if (context.contradictions.length) {
    addCheck(
      "payment.requirements_consistent",
      "FAIL",
      "high",
      `Requirements disagree on: ${context.contradictions.join(", ")}.`,
    );
    addIssue(
      "CONTRADICTORY_PAYMENT_REQUIREMENTS",
      "high",
      false,
      `Multiple payment options contradict each other on ${context.contradictions.join(", ")}.`,
      "Publish intentional alternatives or make price, network, asset, receiver, and scheme consistent.",
    );
  } else {
    addCheck(
      "payment.requirements_consistent",
      context.payment.detected ? "PASS" : "UNKNOWN",
      "info",
      context.payment.detected
        ? "No contradictions were found among the advertised payment requirements."
        : "Payment requirement consistency could not be evaluated.",
    );
  }

  if (context.payment.bazaar.found && context.payment.bazaar.valid) {
    addCheck("discovery.bazaar", "PASS", "info", "Valid Bazaar metadata was found in the challenge.");
  } else {
    addCheck(
      "discovery.bazaar",
      "WARN",
      "medium",
      context.payment.bazaar.found
        ? "Bazaar metadata is present but incomplete."
        : "No Bazaar metadata was found in the challenge.",
    );
    addIssue(
      context.payment.bazaar.found ? "INVALID_BAZAAR_METADATA" : "MISSING_BAZAAR_METADATA",
      "medium",
      false,
      context.payment.bazaar.found
        ? "The challenge contains incomplete Bazaar discovery metadata."
        : "The challenge does not expose Bazaar discovery metadata.",
      "Register the Bazaar resource-server extension and declare strict input/output schemas plus examples on the paid route.",
    );
  }

  if (context.profile === "audit") {
    assessAuditSignals(context, addCheck, addIssue);
  }

  const severityPenalty = { critical: 45, high: 30, medium: 12, low: 4, info: 0 };
  const score = Math.max(
    0,
    100 - issues.reduce((total, issue) => total + severityPenalty[issue.severity], 0),
  );
  const hasBlocking = issues.some(issue => ["critical", "high"].includes(issue.severity));
  const hasCaution = issues.some(issue => ["medium", "low"].includes(issue.severity));
  const decision = hasBlocking
    ? "BLOCK"
    : !context.payment.detected
      ? "UNKNOWN"
      : hasCaution
        ? "CAUTION"
        : "ALLOW";
  return { checks, issues, score, decision };
}

function assessNetworkPolicy(context, addCheck, addIssue) {
  if (!context.input.expected_network) {
    addCheck(
      "payment.network_matches_policy",
      "UNKNOWN",
      "info",
      "No expected_network policy was supplied.",
    );
    return;
  }
  if (!context.payment.network) {
    addCheck("payment.network_matches_policy", "FAIL", "high", "The payment network is missing.");
    return;
  }
  if (sameText(context.payment.network, context.input.expected_network)) {
    addCheck(
      "payment.network_matches_policy",
      "PASS",
      "info",
      `Published network is ${context.payment.network}.`,
    );
    return;
  }
  addCheck(
    "payment.network_matches_policy",
    "FAIL",
    "critical",
    `Published network ${context.payment.network} differs from expected ${context.input.expected_network}.`,
  );
  addIssue(
    "NETWORK_POLICY_MISMATCH",
    "critical",
    false,
    `The challenge requests ${context.payment.network}, but the caller allows ${context.input.expected_network}.`,
    "Do not pay until the resource publishes the expected CAIP-2 network or the caller changes policy intentionally.",
  );
}

function assessPricePolicy(context, addCheck, addIssue) {
  if (context.input.max_price_usd === null) {
    addCheck("payment.price_within_policy", "UNKNOWN", "info", "No max_price_usd policy was supplied.");
    return;
  }
  if (context.payment.priceUsd === null) {
    addCheck(
      "payment.price_within_policy",
      "WARN",
      "medium",
      "The USD price could not be determined from the advertised asset and amount.",
    );
    addIssue(
      "PRICE_NOT_DETERMINABLE",
      "medium",
      false,
      "The challenge amount cannot be converted to a USD price deterministically.",
      "Publish a recognized stablecoin asset and integer atomic amount, or omit the caller price policy only after manual review.",
    );
    return;
  }
  if (context.payment.priceUsd <= context.input.max_price_usd) {
    addCheck(
      "payment.price_within_policy",
      "PASS",
      "info",
      `Observed price $${context.payment.priceUsd} is within the $${context.input.max_price_usd} limit.`,
    );
    return;
  }
  addCheck(
    "payment.price_within_policy",
    "FAIL",
    "critical",
    `Observed price $${context.payment.priceUsd} exceeds the $${context.input.max_price_usd} limit.`,
  );
  addIssue(
    "PRICE_POLICY_EXCEEDED",
    "critical",
    false,
    "The advertised price exceeds the caller's maximum.",
    "Do not pay unless the caller deliberately raises max_price_usd after reviewing the resource.",
  );
}

function assessAuditSignals(context, addCheck, addIssue) {
  if (context.cors.browserAgentCompatible) {
    addCheck("browser.cors", "PASS", "info", "CORS permits the method and a recognized x402 payment header.");
  } else {
    addCheck("browser.cors", "WARN", "medium", "CORS does not fully permit a browser-agent payment retry.");
    addIssue(
      "BROWSER_AGENT_CORS_INCOMPLETE",
      "medium",
      false,
      "The observed CORS policy does not allow the requested method, origin, and x402 payment header together.",
      "Handle OPTIONS before payment middleware and expose/allow the protocol payment headers.",
    );
  }

  const contentType = header(context.operational.response.headers, "content-type");
  const jsonContent = /(?:application\/json|problem\+json)/i.test(contentType ?? "");
  addCheck(
    "http.content_type",
    jsonContent ? "PASS" : "WARN",
    jsonContent ? "info" : "low",
    contentType ? `Observed content type is ${contentType}.` : "No content type was advertised.",
  );
  if (!jsonContent) {
    addIssue(
      "NON_JSON_CHALLENGE_CONTENT_TYPE",
      "low",
      false,
      "The payment challenge is not advertised as JSON.",
      "Return application/json for agent-facing x402 challenges.",
    );
  }

  const cacheControl = header(context.operational.response.headers, "cache-control") ?? "";
  const noStore = /(?:^|,)\s*(?:no-store|private)\b/i.test(cacheControl);
  addCheck(
    "http.challenge_cache_control",
    noStore ? "PASS" : "WARN",
    noStore ? "info" : "low",
    cacheControl ? `Observed Cache-Control is ${cacheControl}.` : "No Cache-Control header was observed.",
  );
  if (!noStore) {
    addIssue(
      "PAYMENT_CHALLENGE_CACHEABLE",
      "low",
      false,
      "The challenge does not explicitly prevent shared caching.",
      "Set Cache-Control: private, no-store on paid routes and 402 responses.",
    );
  }

  for (const [name, signal] of Object.entries(context.discovery)) {
    const id = `discovery.${name}`;
    if (signal.present && signal.valid && signal.consistent !== false) {
      addCheck(id, "PASS", "info", `${signal.url} is present and structurally usable.`);
      continue;
    }
    const status = signal.present ? "WARN" : "WARN";
    addCheck(id, status, "medium", `${signal.url} is missing, invalid, or inconsistent with the resource.`);
    addIssue(
      `DISCOVERY_${camelToConstant(name)}_NOT_READY`,
      "medium",
      Boolean(signal.statusCode === null),
      `${signal.url} is missing, invalid, unreachable, or inconsistent with the audited resource.`,
      `Publish ${name} metadata that names the canonical capability and matches the runtime 402 requirements.`,
    );
  }
}

function buildEvidence(mainProbe, corsProbe, challenge, discovery) {
  const evidence = [
    {
      id: "resource.response",
      source: mainProbe.finalUrl,
      observation: `HTTP ${mainProbe.response.status} in ${mainProbe.latencyMs} ms; ${Buffer.byteLength(mainProbe.body)} response bytes.`,
    },
    {
      id: "payment.challenge",
      source: challenge.payment.challengeSource ?? "response",
      observation: challenge.payment.detected
        ? `Decoded x402 version ${challenge.payment.x402Version ?? "unknown"} with scheme ${challenge.payment.scheme ?? "unknown"}.`
        : "No decodable x402 challenge was observed.",
    },
    {
      id: "cors.preflight",
      source: mainProbe.finalUrl,
      observation: corsProbe
        ? `OPTIONS returned HTTP ${corsProbe.statusCode}.`
        : "The CORS preflight probe did not produce an observable response.",
    },
  ];
  for (const [name, signal] of Object.entries(discovery)) {
    if (signal.statusCode === null) continue;
    evidence.push({
      id: `discovery.${name}`,
      source: signal.url,
      observation: `HTTP ${signal.statusCode}; valid=${String(signal.valid)}; consistent=${String(signal.consistent)}.`,
    });
  }
  return evidence;
}

function header(headers, name) {
  const value = typeof headers?.get === "function"
    ? headers.get(name)
    : headers?.[name] ?? headers?.[name.toLowerCase()];
  return value ? String(value).slice(0, 2000) : null;
}

function splitHeader(value) {
  return String(value ?? "")
    .split(",")
    .map(item => item.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 50);
}

function parseJson(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function sameText(left, right) {
  return String(left ?? "").toLowerCase() === String(right ?? "").toLowerCase();
}

function camelToConstant(value) {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

function normalizeRequestId(value) {
  const candidate = String(value ?? "").trim();
  if (/^req_[A-Za-z0-9_-]{8,100}$/.test(candidate)) return candidate;
  throw new Error("A normalized requestId is required for preflight inspection");
}

function dateValue(value) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid preflight clock");
  return date;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(parsed)));
}
