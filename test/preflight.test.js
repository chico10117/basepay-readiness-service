import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import test from "node:test";

import { validateDiscoveryExtension } from "@x402/extensions/bazaar";
import {
  auditHttpDiscoveryExtension,
  auditQueryHttpDiscoveryExtension,
  auditMcpDiscoveryExtension,
  buildA2ANotImplemented,
  buildAgentMetadata,
  buildOpenApiDocument,
  buildPublicManifest,
} from "../src/preflight/discovery.js";
import { parseX402Challenge } from "../src/preflight/challenge.js";
import { inspectX402Endpoint } from "../src/preflight/inspector.js";
import {
  validatePreflightQuery,
  validatePreflightInput,
  validateRemediationInput,
} from "../src/preflight/schemas.js";
import {
  readResponseText,
  safeFetchWithTrace,
} from "../src/review/target-policy.js";
import { startServer } from "../src/index.js";
import { MCP_PROTOCOL_VERSION } from "../src/mcp/server.js";

const CONFIG = {
  technicalName: "base-wallet-readiness-service",
  baseUrl: "https://preflight.example",
  version: "1.0.0",
  network: "eip155:8453",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  payTo: "0x820a7bf90d944bb26bfD9b62Ab172Fc3A0829cB9",
  facilitator: "https://api.cdp.coinbase.com/platform/v2/x402",
  auditPrice: "$0.05",
  remediationPrice: "$100",
};

const LOOKUP_PUBLIC = async () => [{ address: "93.184.216.34", family: 4 }];
const CANONICAL_PUBLIC_URL = "https://x402.chikocorp.com";
const LEGACY_PUBLIC_URL = "https://x402-wallet-readiness-service.vercel.app";

test("fails closed when public identity origins are misconfigured", () => {
  const moduleUrl = new URL("../src/index.js", import.meta.url).href;
  const exactOrigins = `${CANONICAL_PUBLIC_URL},${LEGACY_PUBLIC_URL}`;
  const baseEnv = {
    ...process.env,
    PUBLIC_URL: CANONICAL_PUBLIC_URL,
    PUBLIC_URL_ALIASES: LEGACY_PUBLIC_URL,
    MCP_ALLOWED_ORIGINS: exactOrigins,
  };
  const invalidConfigurations = [
    [{ PUBLIC_URL: LEGACY_PUBLIC_URL }, /PUBLIC_URL must remain/],
    [{ PUBLIC_URL: "http://x402.chikocorp.com" }, /must use HTTPS/],
    [{ PUBLIC_URL_ALIASES: "" }, /PUBLIC_URL_ALIASES must contain exactly/],
    [{ PUBLIC_URL_ALIASES: `${LEGACY_PUBLIC_URL},https:\/\/other.example` },
      /PUBLIC_URL_ALIASES must contain exactly/],
    [{ MCP_ALLOWED_ORIGINS: `${exactOrigins},https:\/\/other.example` },
      /MCP_ALLOWED_ORIGINS must contain exactly/],
  ];

  for (const [overrides, expectedError] of invalidConfigurations) {
    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", `await import(${JSON.stringify(moduleUrl)})`],
      { encoding: "utf8", env: { ...baseEnv, ...overrides } },
    );
    assert.notEqual(child.status, 0, JSON.stringify(overrides));
    assert.match(child.stderr, expectedError, JSON.stringify(overrides));
  }
});

test("strictly validates preflight and remediation inputs", () => {
  assert.deepEqual(
    validatePreflightInput({
      resource_url: "https://merchant.example/paid#fragment",
      method: "get",
      expected_network: "eip155:8453",
      max_price_usd: 1,
    }),
    {
      resource_url: "https://merchant.example/paid",
      method: "GET",
      expected_network: "eip155:8453",
      max_price_usd: 1,
    },
  );
  assert.throws(
    () => validatePreflightInput({ resource_url: "https://merchant.example/?token=secret" }),
    /sensitive query parameter/i,
  );
  assert.throws(
    () => validatePreflightInput({ resource_url: "https://merchant.example", cookie: "x" }),
    /unsupported input field/i,
  );
  assert.throws(
    () => validatePreflightInput({
      resource_url: "https://merchant.example",
      max_price_usd: "1",
    }),
    /must be a number/i,
  );
  assert.throws(
    () => validatePreflightInput({
      resource_url: "https://merchant.example",
      expected_network: null,
    }),
    /must be a string/i,
  );
  assert.throws(
    () => validateRemediationInput({ resource_url: "http://merchant.example", goal: "fix" }),
    /HTTPS/i,
  );
  assert.throws(
    () => validateRemediationInput({
      resource_url: "https://merchant.example",
      goal: "fix this",
      constraints: "authorization=Bearer-secret-token",
    }),
    /must not contain/i,
  );
  assert.throws(
    () => validateRemediationInput({
      resource_url: "https://merchant.example",
      goal: "fix this",
      language: "x",
    }),
    /at least 2 characters/i,
  );
});

test("strictly validates the paid audit query alias and blocks POST targets", () => {
  assert.deepEqual(
    validatePreflightQuery(
      {
        resource_url: "https://merchant.example/paid#fragment",
        method: "head",
        expected_network: CONFIG.network,
        max_price_usd: "1",
      },
      { defaultNetwork: CONFIG.network },
    ),
    {
      resource_url: "https://merchant.example/paid",
      method: "HEAD",
      expected_network: CONFIG.network,
      max_price_usd: 1,
    },
  );
  assert.throws(
    () => validatePreflightQuery({ resource_url: "https://merchant.example", extra: "x" }),
    /unsupported query parameter/i,
  );
  assert.throws(
    () => validatePreflightQuery({
      resource_url: ["https://merchant.example/one", "https://merchant.example/two"],
    }),
    /only once/i,
  );
  assert.throws(
    () => validatePreflightQuery({
      resource_url: "https://merchant.example",
      method: "POST",
    }),
    /GET or HEAD/i,
  );
  assert.throws(
    () => validatePreflightQuery({
      resource_url: "https://merchant.example",
      max_price_usd: "not-a-number",
    }),
    /finite number/i,
  );
  assert.throws(
    () => validatePreflightQuery({ resource_url: "" }),
    /must not be empty|is required/i,
  );
  assert.throws(
    () => validatePreflightQuery({
      resource_url: `https://example.com/${"a".repeat(1025)}`,
    }),
    error => error.code === "QUERY_RESOURCE_URL_TOO_LONG",
  );
});

test("returns ALLOW for a valid affordable challenge with Bazaar metadata", async () => {
  const report = await inspectX402Endpoint(input(), inspectOptions(fakeTarget()));
  assert.equal(report.decision, "ALLOW");
  assert.equal(report.score, 100);
  assert.equal(report.payment.priceUsd, 0.05);
  assert.equal(report.payment.bazaar.valid, true);
  assert.equal(report.resource.statusCode, 402);
});

test("defaults browser probes to the canonical service origin", async () => {
  const previousProbeOrigin = process.env.PREFLIGHT_PROBE_ORIGIN;
  delete process.env.PREFLIGHT_PROBE_ORIGIN;
  try {
    await inspectX402Endpoint(
      input(),
      inspectOptions(fakeTarget({ expectedProbeOrigin: CANONICAL_PUBLIC_URL })),
    );
  } finally {
    if (previousProbeOrigin === undefined) {
      delete process.env.PREFLIGHT_PROBE_ORIGIN;
    } else {
      process.env.PREFLIGHT_PROBE_ORIGIN = previousProbeOrigin;
    }
  }
});

test("returns CAUTION when Bazaar metadata is missing", async () => {
  const report = await inspectX402Endpoint(
    input(),
    inspectOptions(fakeTarget({ bazaar: false })),
  );
  assert.equal(report.decision, "CAUTION");
  assert.ok(report.issues.some(issue => issue.code === "MISSING_BAZAAR_METADATA"));
});

test("rejects incomplete Bazaar metadata and detects v1 requirement aliases", () => {
  const challenge = validChallenge({ bazaar: true });
  delete challenge.extensions.bazaar.info.output;
  const incomplete = parseX402Challenge(
    new Headers({
      "payment-required": Buffer.from(JSON.stringify(challenge)).toString("base64url"),
    }),
    "",
    { usdcContract: CONFIG.asset },
  );
  assert.equal(incomplete.payment.bazaar.found, true);
  assert.equal(incomplete.payment.bazaar.valid, false);

  const v1 = parseX402Challenge(new Headers(), JSON.stringify({
    x402Version: 1,
    paymentRequirements: [
      {
        scheme: "exact",
        network: CONFIG.network,
        asset: CONFIG.asset,
        maxAmountRequired: "50000",
        pay_to: CONFIG.payTo,
      },
      {
        scheme: "exact",
        network: CONFIG.network,
        asset: CONFIG.asset,
        maxAmountRequired: "90000",
        pay_to: "0x1111111111111111111111111111111111111111",
      },
    ],
  }), { usdcContract: CONFIG.asset });
  assert.deepEqual(v1.contradictions.sort(), ["amount", "payTo"]);
});

test("returns BLOCK for network and price policy violations", async () => {
  const report = await inspectX402Endpoint(
    { ...input(), expected_network: "eip155:84532", max_price_usd: 0.01 },
    inspectOptions(fakeTarget()),
  );
  assert.equal(report.decision, "BLOCK");
  assert.ok(report.issues.some(issue => issue.code === "NETWORK_POLICY_MISMATCH"));
  assert.ok(report.issues.some(issue => issue.code === "PRICE_POLICY_EXCEEDED"));
});

test("returns BLOCK for a malformed advertised challenge", async () => {
  const report = await inspectX402Endpoint(
    input(),
    inspectOptions(fakeTarget({ malformed: true })),
  );
  assert.equal(report.decision, "BLOCK");
  assert.ok(report.issues.some(issue => issue.code === "INVALID_X402_CHALLENGE"));
});

test("deep audit checks discovery, CORS, cache, redirects, and content type", async () => {
  const report = await inspectX402Endpoint(input(), {
    ...inspectOptions(fakeTarget({ discovery: true })),
    profile: "audit",
  });
  assert.equal(report.decision, "ALLOW");
  assert.equal(report.discovery.openapi.consistent, true);
  assert.equal(report.discovery.llmsTxt.consistent, true);
  assert.equal(report.cors.browserAgentCompatible, true);
  assert.deepEqual(report.operational.redirectChain, []);
});

test("deep audit warns when published x402 amount contradicts the live challenge", async () => {
  const report = await inspectX402Endpoint(input(), {
    ...inspectOptions(fakeTarget({ discovery: true, discoveryAmount: "90000" })),
    profile: "audit",
  });
  assert.equal(report.decision, "CAUTION");
  assert.equal(report.discovery.x402Metadata.consistent, false);
  assert.ok(
    report.issues.some(issue => issue.code === "DISCOVERY_X402_METADATA_NOT_READY"),
  );
});

test("blocks private URLs before fetch", async () => {
  let called = false;
  await assert.rejects(
    () => inspectX402Endpoint(
      { resource_url: "https://127.0.0.1/secret" },
      {
        ...inspectOptions(async () => {
          called = true;
          return new Response();
        }),
      },
    ),
    /private|loopback/i,
  );
  assert.equal(called, false);
});

test("blocks IPv6 loopback and IPv4-mapped literals before fetch", async () => {
  for (const resource_url of [
    "https://[::1]/secret",
    "https://[::ffff:127.0.0.1]/secret",
  ]) {
    let called = false;
    await assert.rejects(
      () => inspectX402Endpoint(
        { resource_url },
        inspectOptions(async () => {
          called = true;
          return new Response();
        }),
      ),
      /private|loopback|link-local/i,
    );
    assert.equal(called, false);
  }
});

test("does not accept a CORS policy for a different origin", async () => {
  const target = fakeTarget();
  const report = await inspectX402Endpoint(input(), {
    ...inspectOptions(async (url, init) => {
      const response = await target(url, init);
      if (init.method !== "OPTIONS") return response;
      const headers = new Headers(response.headers);
      headers.set("access-control-allow-origin", "https://other-agent.example");
      return new Response(null, { status: response.status, headers });
    }),
    profile: "audit",
  });
  assert.equal(report.cors.browserAgentCompatible, false);
  assert.ok(report.issues.some(issue => issue.code === "BROWSER_AGENT_CORS_INCOMPLETE"));
});

test("fails a request timeout with a retryable machine code", async () => {
  const neverResponds = (_url, init) => new Promise((_, reject) => {
    init.signal.addEventListener("abort", () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    });
  });
  await assert.rejects(
    () => safeFetchWithTrace("https://merchant.example/paid", {}, {
      lookup: LOOKUP_PUBLIC,
      fetchImpl: neverResponds,
      httpsOnly: true,
      timeoutMs: 5,
    }),
    error => error.code === "TARGET_TIMEOUT" && error.retryable,
  );
});

test("applies the request deadline while reading a slow response body", async () => {
  const fetched = await safeFetchWithTrace("https://merchant.example/paid", {}, {
    lookup: LOOKUP_PUBLIC,
    fetchImpl: async () => new Response(new ReadableStream({
      pull: () => new Promise(() => {}),
    })),
    httpsOnly: true,
    timeoutMs: 20,
  });
  await assert.rejects(
    () => readResponseText(fetched.response, 1024, { deadlineAt: fetched.deadlineAt }),
    error => error.code === "TARGET_TIMEOUT" && error.retryable,
  );
});

test("revalidates redirects and blocks a private redirect destination", async () => {
  let calls = 0;
  await assert.rejects(
    () => safeFetchWithTrace("https://merchant.example/paid", {}, {
      lookup: LOOKUP_PUBLIC,
      fetchImpl: async () => {
        calls += 1;
        return new Response(null, {
          status: 302,
          headers: { location: "https://169.254.169.254/latest/meta-data" },
        });
      },
      httpsOnly: true,
    }),
    /private|link-local|metadata/i,
  );
  assert.equal(calls, 1);
});

test("does not forward sensitive headers across redirect origins", async () => {
  const requests = [];
  const fetched = await safeFetchWithTrace("https://merchant.example/paid", {
    method: "GET",
    headers: {
      accept: "application/json",
      authorization: "Bearer must-not-forward",
      cookie: "session=must-not-forward",
      "payment-signature": "must-not-forward",
    },
  }, {
    lookup: LOOKUP_PUBLIC,
    fetchImpl: async (url, init) => {
      requests.push({ url, headers: new Headers(init.headers) });
      if (requests.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://cdn.example/resource" },
        });
      }
      return new Response("{}", { status: 200 });
    },
    httpsOnly: true,
  });
  await fetched.response.body.cancel();
  assert.equal(requests.length, 2);
  assert.equal(requests[0].headers.has("authorization"), true);
  assert.equal(requests[1].headers.has("authorization"), false);
  assert.equal(requests[1].headers.has("cookie"), false);
  assert.equal(requests[1].headers.has("payment-signature"), false);
  assert.equal(requests[1].headers.get("accept"), "application/json");
});

test("primary discovery surfaces expose exactly three canonical capabilities", () => {
  const expected = [
    "inspect_x402_endpoint",
    "audit_x402_endpoint",
    "order_x402_remediation",
  ];
  assert.deepEqual(buildPublicManifest(CONFIG).capabilities.map(item => item.name), expected);
  assert.deepEqual(buildAgentMetadata(CONFIG).capabilities.map(item => item.name), expected);
  assert.deepEqual(
    Object.values(buildOpenApiDocument(CONFIG).paths).map(path => path.post.operationId),
    expected,
  );
  assert.equal(JSON.stringify(buildOpenApiDocument(CONFIG)).includes('"additionalProperties":true'), false);
  assert.equal(buildA2ANotImplemented(CONFIG, "req_test").error.code, "A2A_NOT_IMPLEMENTED");
});

test("GET audit discovery is a compatibility query operation", () => {
  const openapi = buildOpenApiDocument(CONFIG);
  const auditGet = openapi.paths["/api/x402/preflight/audit"].get;
  assert.equal(auditGet.operationId, "audit_x402_endpoint_query");
  assert.equal(auditGet["x-compatibility"], true);
  assert.equal(auditGet["x-primary-capability"], "audit_x402_endpoint");
  assert.deepEqual(
    auditGet.parameters.map(parameter => parameter.name),
    ["resource_url", "method", "expected_network", "max_price_usd"],
  );
  assert.equal(auditGet.parameters[0].required, true);
  assert.equal(auditGet.parameters[0].in, "query");
  assert.equal(auditGet.parameters[1].schema.default, "GET");
  assert.deepEqual(auditGet.parameters[1].schema.enum, ["GET", "HEAD"]);
  assert.equal(auditGet["x-payment-info"].priceUsd, 0.05);
  const manifest = buildPublicManifest(CONFIG);
  assert.equal(
    manifest.labs.some(item => item.endpoint.includes("/api/x402/preflight/audit?")),
    true,
  );
});

test("official Bazaar validator accepts HTTP, query HTTP, and MCP audit declarations", () => {
  assert.equal(
    validateDiscoveryExtension(auditHttpDiscoveryExtension(CONFIG).bazaar).valid,
    true,
  );
  const queryDeclaration = auditQueryHttpDiscoveryExtension(CONFIG).bazaar;
  assert.equal(validateDiscoveryExtension(queryDeclaration).valid, true);
  assert.equal(queryDeclaration.info.input.method, "GET");
  assert.deepEqual(queryDeclaration.info.input.queryParams, {
    resource_url: "https://example.com/api/resource",
    method: "GET",
    expected_network: CONFIG.network,
    max_price_usd: 1,
  });
  assert.deepEqual(
    queryDeclaration.schema.properties.input.properties.queryParams.properties.method.enum,
    ["GET", "HEAD"],
  );
  assert.equal("bodyType" in queryDeclaration.info.input, false);
  assert.equal(
    validateDiscoveryExtension(auditMcpDiscoveryExtension(CONFIG).bazaar).valid,
    true,
  );
});

test("health exposes release identity without payment or order secrets", async t => {
  const server = startServer(0);
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const root = `http://127.0.0.1:${server.address().port}`;

  const response = await fetch(`${root}/health`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-service-version"), "1.0.0");
  assert.match(response.headers.get("x-request-id"), /^req_/);
  const health = await response.json();
  assert.equal(health.service, "x402-preflight");
  assert.equal(health.publicUrl, CANONICAL_PUBLIC_URL);
  assert.equal(health.version, "1.0.0");
  assert.equal("payTo" in health, false);
  assert.equal(JSON.stringify(health).includes(CONFIG.payTo), false);

  const agentCard = await fetch(`${root}/.well-known/agent-card.json`);
  assert.equal(agentCard.status, 404);
  assert.equal((await agentCard.json()).error.code, "A2A_NOT_IMPLEMENTED");
});

test("order-result rate limiting does not consume unrelated API requests", async t => {
  const server = startServer(0);
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const root = `http://127.0.0.1:${server.address().port}`;

  for (let index = 0; index < 65; index += 1) {
    const response = await fetch(`${root}/health`);
    assert.equal(response.status, 200, `health request ${index + 1}`);
  }
  assert.equal((await fetch(`${root}/manifest`)).status, 200);
});

test("spoofed forwarded IPs cannot bypass the order-result rate limit", async t => {
  const server = startServer(0);
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const root = `http://127.0.0.1:${server.address().port}`;

  for (let index = 0; index < 60; index += 1) {
    const response = await fetch(`${root}/api/x402/orders/missing-order`, {
      headers: { "x-forwarded-for": `198.51.100.${(index % 250) + 1}` },
    });
    assert.equal(response.status, 404, `order request ${index + 1}`);
  }
  const limited = await fetch(`${root}/api/x402/orders/missing-order`, {
    headers: { "x-forwarded-for": "203.0.113.250" },
  });
  assert.equal(limited.status, 429);
});

test("canonicalizes discovery and HTTP/MCP challenges by an explicit host allowlist", async t => {
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/supported")) {
      return jsonResponse({
        kinds: [{ x402Version: 2, scheme: "exact", network: CONFIG.network }],
        extensions: ["bazaar"],
        signers: {},
      });
    }
    return nativeFetch(url, init);
  };
  t.after(() => {
    globalThis.fetch = nativeFetch;
  });

  const server = startServer(0);
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const root = `http://127.0.0.1:${server.address().port}`;
  const aliases = [
    [new URL(CANONICAL_PUBLIC_URL).host, CANONICAL_PUBLIC_URL],
    [new URL(LEGACY_PUBLIC_URL).host, LEGACY_PUBLIC_URL],
    ["untrusted.example", CANONICAL_PUBLIC_URL],
    ["evil.example@x402-wallet-readiness-service.vercel.app", CANONICAL_PUBLIC_URL],
  ];

  for (const [host, expectedBaseUrl] of aliases) {
    const manifestResponse = await fetchWithHost(root, "/manifest", host);
    assert.equal(manifestResponse.status, 200, host);
    const manifest = await manifestResponse.json();
    assert.equal(manifest.interfaces.mcp, `${expectedBaseUrl}/mcp`, host);

    const openapiResponse = await fetchWithHost(root, "/openapi.json", host);
    assert.equal(openapiResponse.status, 200, host);
    assert.equal((await openapiResponse.json()).servers[0].url, expectedBaseUrl, host);

    const x402Response = await fetchWithHost(root, "/.well-known/x402.json", host);
    assert.equal(x402Response.status, 200, host);
    assert.equal((await x402Response.json()).homepage, expectedBaseUrl, host);

    const healthResponse = await fetchWithHost(root, "/health", host);
    assert.equal(healthResponse.status, 200, host);
    assert.equal((await healthResponse.json()).publicUrl, expectedBaseUrl, host);

    const previewResponse = await fetchWithHost(root, "/api/800402/preview", host);
    assert.equal(previewResponse.status, 200, host);
    const preview = await previewResponse.json();
    assert.equal(preview.agent.agentUri, `${expectedBaseUrl}/.well-known/agent.json`, host);
    assert.equal(
      preview.endpoints.paidReadiness,
      `${expectedBaseUrl}/api/readiness/${CONFIG.payTo}`,
      host,
    );

    const legacyCardResponse = await fetchWithHost(
      root,
      "/labs/legacy-agent-card.json",
      host,
    );
    assert.equal(legacyCardResponse.status, 200, host);
    const legacyCard = await legacyCardResponse.json();
    assert.equal(legacyCard.url, expectedBaseUrl, host);
    const paidCardCapability = legacyCard.capabilities.find(
      capability => capability.name === "paid_top_crypto_price_snapshot_feed",
    );
    assert.equal(
      paidCardCapability.payment.endpoint,
      `${expectedBaseUrl}/api/x402/market/crypto-snapshot?limit=50`,
      host,
    );

    const legacyAgentResponse = await fetchWithHost(
      root,
      "/labs/legacy-agent.json",
      host,
    );
    assert.equal(legacyAgentResponse.status, 200, host);
    const legacyAgent = await legacyAgentResponse.json();
    assert.equal(legacyAgent.url, expectedBaseUrl, host);
    assert.equal(
      legacyAgent.erc8004.agentUri,
      `${expectedBaseUrl}/.well-known/agent.json`,
      host,
    );
    assert.equal(
      legacyAgent.pyrimid.recommendationEndpoint,
      `${expectedBaseUrl}/api/pyrimid/recommend?need=paid%20mcp%20tool&limit=3`,
      host,
    );

    const the402Response = await fetchWithHost(
      root,
      "/.well-known/the402.json",
      host,
    );
    assert.equal(the402Response.status, 200, host);
    const the402 = await the402Response.json();
    assert.equal(the402.webhook_url, `${expectedBaseUrl}/api/the402/webhook`, host);
    assert.equal(
      the402.services.find(service => service.name === "Base USDC x402 Quick Review")
        .purchase_url,
      `${expectedBaseUrl}/api/x402/services/quick-review`,
      host,
    );

    const tools402Response = await fetchWithHost(
      root,
      "/api/tools402/services/quick-review?repository_or_url=https%3A%2F%2Fgithub.com%2Fexample%2Fproject&goal=Check%20the%20x402%20challenge",
      host,
    );
    assert.equal(tools402Response.status, 200, host);
    const tools402 = await tools402Response.json();
    assert.equal(tools402.provider.publicServiceUrl, expectedBaseUrl, host);
    assert.equal(
      tools402.provider.tools402Upstream,
      `${expectedBaseUrl}/api/tools402/services/quick-review`,
      host,
    );

    const openFrameResponse = await fetchWithHost(root, "/open-frame", host);
    assert.equal(openFrameResponse.status, 200, host);
    assert.match(
      await openFrameResponse.text(),
      new RegExp(`content="${escapeRegExp(expectedBaseUrl)}/open-frame"`),
      host,
    );

    const auditResponse = await fetchWithHost(root, "/api/x402/preflight/audit", host, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        resource_url: "https://93.184.216.34/resource",
        method: "GET",
        expected_network: CONFIG.network,
        max_price_usd: 1,
      }),
    });
    assert.equal(auditResponse.status, 402, host);
    const auditChallenge = decodePaymentRequired(auditResponse);
    assert.equal(
      auditChallenge.resource.url,
      `${expectedBaseUrl}/api/x402/preflight/audit`,
      host,
    );

    const triageResponse = await fetchWithHost(
      root,
      "/api/x402/services/integration-triage?repository_or_url=https%3A%2F%2Fgithub.com%2Fexample%2Fproject&goal=Check%20the%20x402%20challenge",
      host,
      { headers: { accept: "application/json" } },
    );
    assert.equal(triageResponse.status, 402, host);
    const triageChallenge = decodePaymentRequired(triageResponse);
    assert.equal(
      triageChallenge.extensions.bazaar.info.output.example.review.statusUrl,
      `${expectedBaseUrl}/api/x402/orders/triage-example`,
      host,
    );

    const mcpResponse = await fetchWithHost(root, "/mcp", host, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": MCP_PROTOCOL_VERSION,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: {
          name: "audit_x402_endpoint",
          arguments: {
            resource_url: "https://93.184.216.34/resource",
            method: "GET",
            expected_network: CONFIG.network,
            max_price_usd: 1,
          },
        },
      }),
    });
    assert.equal(mcpResponse.status, 402, host);
    const mcpChallenge = decodePaymentRequired(mcpResponse);
    assert.equal(
      mcpChallenge.resource.url,
      `${expectedBaseUrl}/mcp#audit_x402_endpoint`,
      host,
    );
  }

  for (const [host, forwardedHost, expectedBaseUrl] of [
    [CANONICAL_PUBLIC_URL, LEGACY_PUBLIC_URL, CANONICAL_PUBLIC_URL],
    [LEGACY_PUBLIC_URL, CANONICAL_PUBLIC_URL, LEGACY_PUBLIC_URL],
  ]) {
    const response = await getJsonWithHostHeaders(root, "/manifest", {
      host: new URL(host).host,
      forwardedHost: new URL(forwardedHost).host,
    });
    assert.equal(response.status, 200, `${host} before ${forwardedHost}`);
    assert.equal(
      response.body.interfaces.mcp,
      `${expectedBaseUrl}/mcp`,
      `${host} before ${forwardedHost}`,
    );
  }

  const ambiguousForwardedHost = await getJsonWithHostHeaders(root, "/manifest", {
    host: "internal.example",
    forwardedHost:
      `evil.example, ${new URL(LEGACY_PUBLIC_URL).host}`,
  });
  assert.equal(ambiguousForwardedHost.status, 200);
  assert.equal(
    ambiguousForwardedHost.body.interfaces.mcp,
    `${CANONICAL_PUBLIC_URL}/mcp`,
  );

  const varied = await fetchWithHost(
    root,
    "/manifest",
    new URL(LEGACY_PUBLIC_URL).host,
  );
  assert.match(varied.headers.get("vary") ?? "", /x-forwarded-host/i);
});

test("MCP allows both public origins and rejects an unknown origin", async t => {
  const server = startServer(0);
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const root = `http://127.0.0.1:${server.address().port}`;
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  });
  const headers = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": MCP_PROTOCOL_VERSION,
  };

  for (const origin of [CANONICAL_PUBLIC_URL, LEGACY_PUBLIC_URL]) {
    const response = await fetchWithHost(root, "/mcp", "untrusted.example", {
      method: "POST",
      headers: { ...headers, origin },
      body,
    });
    assert.equal(response.status, 200, origin);
  }

  const rejected = await fetchWithHost(root, "/mcp", "untrusted.example", {
    method: "POST",
    headers: { ...headers, origin: "https://evil.example" },
    body,
  });
  assert.equal(rejected.status, 403);
});

test("browser CORS allows only the two public origins and fixed request headers", async t => {
  const server = startServer(0);
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const root = `http://127.0.0.1:${server.address().port}`;

  for (const origin of [CANONICAL_PUBLIC_URL, LEGACY_PUBLIC_URL]) {
    const response = await fetch(`${root}/api/preflight/inspect`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
      },
      body: JSON.stringify({ resource_url: "https://127.0.0.1/private" }),
    });
    assert.equal(response.status, 400, origin);
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
    assert.match(response.headers.get("access-control-expose-headers"), /payment-required/i);
  }

  const preflight = await fetch(`${root}/api/preflight/inspect`, {
    method: "OPTIONS",
    headers: {
      origin: CANONICAL_PUBLIC_URL,
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type, x-secret-header",
    },
  });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /content-type/i);
  assert.doesNotMatch(
    preflight.headers.get("access-control-allow-headers") ?? "",
    /x-secret-header/i,
  );

  for (const path of ["/api/preflight/inspect", "/api/x402/preflight/audit"]) {
    const rejected = await fetch(`${root}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
      },
      body: JSON.stringify({ resource_url: "https://93.184.216.34/resource" }),
    });
    assert.equal(rejected.status, 403, path);
    assert.equal(rejected.headers.get("access-control-allow-origin"), null, path);
    assert.equal(rejected.headers.get("payment-required"), null, path);
  }
});

test("blocked audit targets fail before facilitator initialization", async t => {
  const server = startServer(0);
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/api/x402/preflight/audit`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resource_url: "https://127.0.0.1/private" }),
    },
  );
  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.equal(payload.error.code, "TARGET_BLOCKED");
  assert.match(payload.error.requestId, /^req_/);
});

test("canonical remediation fails before payment when durable storage is unavailable", async t => {
  const server = startServer(0);
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/api/x402/preflight/remediation`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        resource_url: "https://93.184.216.34/resource",
        goal: "Correct the x402 discovery contract.",
      }),
    },
  );
  assert.equal(response.status, 503);
  const payload = await response.json();
  assert.equal(payload.error.code, "REMEDIATION_UNAVAILABLE");
  assert.equal(payload.error.retryable, true);
  assert.equal(response.headers.has("payment-required"), false);
});

test("GET audit validates required, unique, and safe query parameters before x402", async t => {
  const server = startServer(0);
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const root = `http://127.0.0.1:${server.address().port}`;
  const target = encodeURIComponent("https://93.184.216.34/resource");
  const requests = [
    {
      url: `${root}/api/x402/preflight/audit`,
      code: "MISSING_REQUIRED_FIELD",
    },
    {
      url: `${root}/api/x402/preflight/audit?resource_url=${target}&resource_url=${target}`,
      code: "DUPLICATE_QUERY_PARAMETER",
    },
    {
      url: `${root}/api/x402/preflight/audit?resource_url=${target}&unexpected=value`,
      code: "UNKNOWN_QUERY_PARAMETER",
    },
    {
      url: `${root}/api/x402/preflight/audit?resource_url=${target}&method=POST`,
      code: "UNSAFE_QUERY_METHOD",
      headers: { "payment-signature": "not-a-payment" },
    },
  ];
  for (const request of requests) {
    const response = await fetch(request.url, { method: "GET", headers: request.headers });
    assert.equal(response.status, 400, request.url);
    assert.equal((await response.json()).error.code, request.code, request.url);
    assert.equal(response.headers.has("payment-required"), false, request.url);
  }
});

test("unpaid canonical audit returns a valid 0.05 USD Bazaar challenge", async t => {
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/supported")) {
      return jsonResponse({
        kinds: [{ x402Version: 2, scheme: "exact", network: CONFIG.network }],
        extensions: ["bazaar"],
        signers: {},
      });
    }
    return nativeFetch(url, init);
  };
  t.after(() => {
    globalThis.fetch = nativeFetch;
  });

  const server = startServer(0);
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await nativeFetch(
    `http://127.0.0.1:${server.address().port}/api/x402/preflight/audit`,
    {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        resource_url: "https://93.184.216.34/resource",
        method: "GET",
        expected_network: CONFIG.network,
        max_price_usd: 1,
      }),
    },
  );
  assert.equal(response.status, 402);
  assert.match(response.headers.get("cache-control"), /no-store|private/i);
  const challenge = parseX402Challenge(response.headers, await response.text(), {
    usdcContract: CONFIG.asset,
  });
  assert.equal(challenge.payment.network, CONFIG.network);
  assert.equal(challenge.payment.amountAtomic, "50000");
  assert.equal(challenge.payment.payTo.toLowerCase(), CONFIG.payTo.toLowerCase());
  assert.equal(challenge.payment.bazaar.found, true);
  assert.equal(challenge.payment.bazaar.valid, true);
});

test("unpaid GET audit returns a valid query Bazaar challenge", async t => {
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/supported")) {
      return jsonResponse({
        kinds: [{ x402Version: 2, scheme: "exact", network: CONFIG.network }],
        extensions: ["bazaar"],
        signers: {},
      });
    }
    return nativeFetch(url, init);
  };
  t.after(() => {
    globalThis.fetch = nativeFetch;
  });

  const server = startServer(0);
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = new URL(
    `/api/x402/preflight/audit`,
    `http://127.0.0.1:${server.address().port}`,
  );
  url.searchParams.set("resource_url", "https://93.184.216.34/resource");
  url.searchParams.set("method", "GET");
  url.searchParams.set("expected_network", CONFIG.network);
  url.searchParams.set("max_price_usd", "1");
  const response = await nativeFetch(url, {
    method: "GET",
    redirect: "manual",
  });
  assert.equal(response.status, 402);
  assert.match(response.headers.get("cache-control"), /no-store|private/i);
  const encoded = response.headers.get("payment-required");
  const rawChallenge = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  assert.deepEqual(rawChallenge.extensions.bazaar.info.input, {
    type: "http",
    method: "GET",
    queryParams: {
      resource_url: "https://example.com/api/resource",
      method: "GET",
      expected_network: CONFIG.network,
      max_price_usd: 1,
    },
  });
  assert.equal(
    rawChallenge.extensions.bazaar.schema.properties.input.properties.queryParams.required.includes(
      "resource_url",
    ),
    true,
  );
  assert.equal("bodyType" in rawChallenge.extensions.bazaar.info.input, false);
  const challenge = parseX402Challenge(response.headers, await response.text(), {
    usdcContract: CONFIG.asset,
  });
  assert.equal(challenge.payment.network, CONFIG.network);
  assert.equal(challenge.payment.amountAtomic, "50000");
  assert.equal(challenge.payment.payTo.toLowerCase(), CONFIG.payTo.toLowerCase());
  assert.equal(challenge.payment.bazaar.method, "GET");
  assert.equal(challenge.payment.bazaar.valid, true);
});

test("GET audit challenge remains header-safe at the query URL limit", async t => {
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/supported")) {
      return jsonResponse({
        kinds: [{ x402Version: 2, scheme: "exact", network: CONFIG.network }],
        extensions: ["bazaar"],
        signers: {},
      });
    }
    return nativeFetch(url, init);
  };
  t.after(() => {
    globalThis.fetch = nativeFetch;
  });

  const server = startServer(0);
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = new URL(
    "/api/x402/preflight/audit",
    `http://127.0.0.1:${server.address().port}`,
  );
  const prefix = "https://example.com/";
  url.searchParams.set("resource_url", `${prefix}${"a".repeat(1024 - prefix.length)}`);
  url.searchParams.set("method", "GET");
  const response = await nativeFetch(url, { method: "GET", redirect: "manual" });
  assert.equal(response.status, 402);
  const encoded = response.headers.get("payment-required");
  assert.ok(encoded);
  assert.ok(
    Buffer.byteLength(encoded, "utf8") < 8_000,
    `PAYMENT-REQUIRED header is ${Buffer.byteLength(encoded, "utf8")} bytes`,
  );
  const rawChallenge = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  assert.deepEqual(
    Object.keys(rawChallenge.extensions.bazaar.info.output.example).sort(),
    ["decision", "issues", "payment", "profile", "requestId", "resource", "score"],
  );
  assert.equal(
    rawChallenge.extensions.bazaar.schema.properties.input.properties.queryParams.properties
      .resource_url.maxLength,
    1024,
  );
});

test("empty unauthenticated audit POST returns a challenge for method probes", async t => {
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/supported")) {
      return jsonResponse({
        kinds: [{ x402Version: 2, scheme: "exact", network: CONFIG.network }],
        extensions: ["bazaar"],
        signers: {},
      });
    }
    return nativeFetch(url, init);
  };
  t.after(() => {
    globalThis.fetch = nativeFetch;
  });

  const server = startServer(0);
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  for (const body of [undefined, "{}"]) {
    const response = await nativeFetch(
      `http://127.0.0.1:${server.address().port}/api/x402/preflight/audit`,
      {
        method: "POST",
        redirect: "manual",
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body,
      },
    );
    assert.equal(response.status, 402);
    const challenge = parseX402Challenge(response.headers, await response.text(), {
      usdcContract: CONFIG.asset,
    });
    assert.equal(challenge.payment.amountAtomic, "50000");
    assert.equal(challenge.payment.bazaar.valid, true);
  }
});

test("empty audit POST with any recognized payment attempt still fails before payment", async t => {
  const server = startServer(0);
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  for (const paymentHeader of [
    "payment-signature",
    "x-payment",
    "payment",
    "x-402-payment",
    "x402-payment",
  ]) {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/x402/preflight/audit`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [paymentHeader]: "not-a-payment",
        },
        body: "{}",
      },
    );
    assert.equal(response.status, 400, paymentHeader);
    assert.equal((await response.json()).error.code, "MISSING_REQUIRED_FIELD", paymentHeader);
    assert.equal(response.headers.has("payment-required"), false, paymentHeader);
  }
});

test("audit challenge probes reject noncanonical paths and unparsed request bodies", async t => {
  const server = startServer(0);
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));

  for (const request of [
    {
      path: "/api/x402/preflight/audit/extra",
      headers: { "content-type": "application/json" },
      body: "{}",
      expectedCode: "MISSING_REQUIRED_FIELD",
    },
    {
      path: "/api/x402/preflight/audit",
      headers: { "content-type": "text/plain" },
      body: "not-json",
      expectedCode: "INVALID_REQUEST",
    },
  ]) {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}${request.path}`,
      {
        method: "POST",
        headers: request.headers,
        body: request.body,
      },
    );
    assert.equal(response.status, 400, request.path);
    assert.equal((await response.json()).error.code, request.expectedCode, request.path);
    assert.equal(response.headers.has("payment-required"), false, request.path);
  }
});

test("unpaid MCP audit call returns a valid Bazaar x402 challenge", async t => {
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/supported")) {
      return jsonResponse({
        kinds: [{ x402Version: 2, scheme: "exact", network: CONFIG.network }],
        extensions: ["bazaar"],
        signers: {},
      });
    }
    return nativeFetch(url, init);
  };
  t.after(() => {
    globalThis.fetch = nativeFetch;
  });

  const server = startServer(0);
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await nativeFetch(`http://127.0.0.1:${server.address().port}/mcp`, {
    method: "POST",
    redirect: "manual",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "audit_x402_endpoint",
        arguments: {
          resource_url: "https://93.184.216.34/resource",
          method: "GET",
          expected_network: CONFIG.network,
          max_price_usd: 1,
        },
      },
    }),
  });
  assert.equal(response.status, 402);
  assert.equal(response.headers.get("mcp-protocol-version"), MCP_PROTOCOL_VERSION);
  const challenge = parseX402Challenge(response.headers, await response.text(), {
    usdcContract: CONFIG.asset,
  });
  assert.equal(challenge.payment.amountAtomic, "50000");
  assert.equal(challenge.payment.bazaar.valid, true);
  assert.equal(challenge.payment.bazaar.toolName, "audit_x402_endpoint");
});

test("MCP lists exactly three tools and rejects an untrusted Origin", async t => {
  const server = startServer(0);
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const root = `http://127.0.0.1:${server.address().port}`;
  const headers = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  };
  const initialized = await fetch(`${root}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    }),
  });
  assert.equal(initialized.status, 200);
  assert.equal(initialized.headers.get("mcp-protocol-version"), MCP_PROTOCOL_VERSION);
  assert.equal((await initialized.json()).result.protocolVersion, MCP_PROTOCOL_VERSION);

  const listed = await fetch(`${root}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  assert.equal(listed.status, 200);
  const payload = await listed.json();
  assert.deepEqual(
    payload.result.tools.map(tool => tool.name),
    ["inspect_x402_endpoint", "audit_x402_endpoint", "order_x402_remediation"],
  );
  assert.ok(payload.result.tools.every(tool => tool.inputSchema.additionalProperties === false));

  const invalidTransport = await fetch(`${root}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "audit_x402_endpoint",
        arguments: { resource_url: "https://93.184.216.34/resource" },
      },
    }),
  });
  assert.equal(invalidTransport.status, 406);
  assert.equal(invalidTransport.headers.has("payment-required"), false);

  const unsupported = await fetch(`${root}/mcp`, {
    method: "POST",
    headers: { ...headers, "mcp-protocol-version": "2099-01-01" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }),
  });
  assert.equal(unsupported.status, 400);
  assert.equal((await unsupported.json()).error.code, -32602);

  const rejected = await fetch(`${root}/mcp`, {
    method: "POST",
    headers: { ...headers, origin: "https://evil.example" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });
  assert.equal(rejected.status, 403);
});

function input() {
  return {
    resource_url: "https://merchant.example/paid",
    method: "GET",
    expected_network: CONFIG.network,
    max_price_usd: 1,
  };
}

function inspectOptions(fetchImpl) {
  return {
    profile: "inspect",
    requestId: "req_testpreflight123",
    defaultNetwork: CONFIG.network,
    usdcContract: CONFIG.asset,
    lookup: LOOKUP_PUBLIC,
    fetchImpl,
    timeoutMs: 1000,
    now: new Date("2026-08-06T00:00:00.000Z"),
  };
}

function fakeTarget(options = {}) {
  const challenge = validChallenge({ bazaar: options.bazaar !== false });
  return async (url, init) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/paid" && options.expectedProbeOrigin) {
      assert.equal(
        new Headers(init.headers).get("origin"),
        options.expectedProbeOrigin,
      );
    }
    if (init.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type, payment-signature",
          "access-control-expose-headers": "payment-required, payment-response",
        },
      });
    }
    if (parsed.pathname === "/paid") {
      return new Response("{}", {
        status: 402,
        headers: {
          "content-type": "application/json",
          "cache-control": "private, no-store",
          "payment-required": options.malformed
            ? "advertised-but-not-json"
            : Buffer.from(JSON.stringify(challenge)).toString("base64url"),
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type, payment-signature",
          "access-control-expose-headers": "payment-required, payment-response",
        },
      });
    }
    if (!options.discovery) return new Response("not found", { status: 404 });
    if (parsed.pathname === "/openapi.json") {
      return jsonResponse({ openapi: "3.1.0", paths: { "/paid": { get: {} } } });
    }
    if (parsed.pathname === "/llms.txt") {
      return new Response("Use GET /paid before payment.", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }
    if (parsed.pathname === "/.well-known/agent.json") {
      return jsonResponse({ capabilities: [{ name: "audit_x402_endpoint", endpoint: "/paid" }] });
    }
    if (parsed.pathname === "/.well-known/x402.json") {
      return jsonResponse({
        resources: [{
          url: "https://merchant.example/paid",
          accepts: [{
            network: CONFIG.network,
            asset: CONFIG.asset,
            amount: options.discoveryAmount ?? "50000",
            payTo: CONFIG.payTo,
          }],
        }],
      });
    }
    return new Response("not found", { status: 404 });
  };
}

function validChallenge({ bazaar }) {
  return {
    x402Version: 2,
    accepts: [{
      scheme: "exact",
      network: CONFIG.network,
      asset: CONFIG.asset,
      amount: "50000",
      payTo: CONFIG.payTo,
      maxTimeoutSeconds: 300,
      extra: { name: "USD Coin", version: "2" },
    }],
    resource: {
      url: "https://merchant.example/paid",
      description: "Paid resource",
      mimeType: "application/json",
    },
    ...(bazaar
      ? {
          extensions: {
            bazaar: {
              info: {
                input: { type: "http", method: "GET", queryParams: {} },
                output: { type: "json", example: { ok: true } },
              },
              schema: {
                type: "object",
                properties: {
                  input: { type: "object" },
                  output: { type: "object" },
                },
              },
            },
          },
        }
      : {}),
  };
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function fetchWithHost(root, path, host, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("x-forwarded-host", host);
  return fetch(`${root}${path}`, { ...init, headers });
}

function decodePaymentRequired(response) {
  const encoded = response.headers.get("payment-required");
  assert.ok(encoded, "payment-required header is present");
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getJsonWithHostHeaders(root, path, { host, forwardedHost }) {
  const url = new URL(path, root);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: {
        host,
        "x-forwarded-host": forwardedHost,
      },
    }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => {
        try {
          resolve({
            status: response.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("error", reject);
    request.end();
  });
}
