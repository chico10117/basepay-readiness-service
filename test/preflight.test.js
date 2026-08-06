import assert from "node:assert/strict";
import test from "node:test";

import { validateDiscoveryExtension } from "@x402/extensions/bazaar";
import {
  auditHttpDiscoveryExtension,
  auditMcpDiscoveryExtension,
  buildA2ANotImplemented,
  buildAgentMetadata,
  buildOpenApiDocument,
  buildPublicManifest,
} from "../src/preflight/discovery.js";
import { parseX402Challenge } from "../src/preflight/challenge.js";
import { inspectX402Endpoint } from "../src/preflight/inspector.js";
import {
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

test("returns ALLOW for a valid affordable challenge with Bazaar metadata", async () => {
  const report = await inspectX402Endpoint(input(), inspectOptions(fakeTarget()));
  assert.equal(report.decision, "ALLOW");
  assert.equal(report.score, 100);
  assert.equal(report.payment.priceUsd, 0.05);
  assert.equal(report.payment.bazaar.valid, true);
  assert.equal(report.resource.statusCode, 402);
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

test("official Bazaar validator accepts HTTP and MCP audit declarations", () => {
  assert.equal(
    validateDiscoveryExtension(auditHttpDiscoveryExtension(CONFIG).bazaar).valid,
    true,
  );
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
  assert.equal(health.version, "1.0.0");
  assert.equal("payTo" in health, false);
  assert.equal(JSON.stringify(health).includes(CONFIG.payTo), false);

  const agentCard = await fetch(`${root}/.well-known/agent-card.json`);
  assert.equal(agentCard.status, 404);
  assert.equal((await agentCard.json()).error.code, "A2A_NOT_IMPLEMENTED");
});

test("free inspection errors include browser-agent CORS headers", async t => {
  const server = startServer(0);
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/api/preflight/inspect`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://agent.example",
      },
      body: JSON.stringify({ resource_url: "https://127.0.0.1/private" }),
    },
  );
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://agent.example");
  assert.match(response.headers.get("access-control-expose-headers"), /payment-required/i);
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
