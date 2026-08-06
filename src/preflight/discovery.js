import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import {
  errorEnvelopeSchema,
  preflightInputSchema,
  preflightReportSchema,
  remediationInputSchema,
} from "./schemas.js";

export const PRODUCT_NAME = "x402 Preflight";
export const PRODUCT_SLUG = "x402-preflight";
export const PRODUCT_DESCRIPTION =
  "Inspect and validate an unfamiliar x402 endpoint before an agent spends USDC. x402 Preflight observes the challenge, price, network, asset, receiver, discovery metadata, CORS, and operational signals without signing or paying for the buyer.";

const CAPABILITY_DESCRIPTIONS = {
  inspect_x402_endpoint:
    "Use before paying an unfamiliar x402 resource. Performs a free read-only probe and returns a deterministic policy decision from the observed challenge and caller limits.",
  audit_x402_endpoint:
    "Use when a buyer needs deeper evidence before spending: validates payment requirements, redirects, CORS, cache behavior, OpenAPI, llms.txt, agent metadata, and x402 discovery consistency.",
  order_x402_remediation:
    "Use after a failed or risky audit to purchase a durable remediation intake for the endpoint. This creates an order; it never deploys changes or spends automatically.",
};

export const remediationReceiptSchema = {
  $id: "https://x402-preflight.dev/schemas/remediation-receipt.json",
  type: "object",
  additionalProperties: false,
  required: [
    "capability",
    "service",
    "orderId",
    "status",
    "acceptedAt",
    "payment",
    "request",
    "review",
    "persistence",
    "claimBoundary",
  ],
  properties: {
    capability: { type: "string", const: "order_x402_remediation" },
    service: { type: "string" },
    orderId: { type: "string" },
    status: { type: "string" },
    acceptedAt: { type: "string", format: "date-time" },
    payment: {
      type: "object",
      additionalProperties: false,
      required: [
        "asset",
        "assetContract",
        "network",
        "networkCaip2",
        "expectedAmountAtomic",
        "expectedAmountUsd",
        "payTo",
        "facilitator",
      ],
      properties: {
        asset: { type: "string" },
        assetContract: { type: "string" },
        network: { type: "string" },
        networkCaip2: { type: "string" },
        expectedAmountAtomic: { type: "string" },
        expectedAmountUsd: { type: "number" },
        payTo: { type: "string" },
        facilitator: { type: "string", format: "uri" },
      },
    },
    request: {
      type: "object",
      additionalProperties: false,
      required: [
        "repository_or_url",
        "goal",
        "contact",
        "constraints",
        "callback_url",
        "response_format",
        "language",
      ],
      properties: {
        repository_or_url: { type: "string" },
        goal: { type: "string" },
        contact: { type: "string" },
        constraints: { type: "string" },
        callback_url: { type: "string" },
        response_format: { type: "string", enum: ["json", "markdown", "both"] },
        language: { type: "string" },
      },
    },
    review: {
      type: "object",
      additionalProperties: false,
      required: [
        "status",
        "statusUrl",
        "resultUrl",
        "reportUrl",
        "estimatedCompletionMinutes",
        "accessToken",
      ],
      properties: {
        status: { type: "string" },
        statusUrl: { type: "string", format: "uri" },
        resultUrl: { type: "string", format: "uri" },
        reportUrl: { type: "string", format: "uri" },
        estimatedCompletionMinutes: { type: "integer", minimum: 1 },
        accessToken: { type: "string" },
      },
    },
    persistence: {
      type: "object",
      additionalProperties: false,
      required: ["status", "settlementTracking"],
      properties: {
        status: { type: "string" },
        settlementTracking: { type: "boolean" },
      },
    },
    claimBoundary: {
      type: "object",
      additionalProperties: false,
      required: ["proves", "doesNotProve"],
      properties: {
        proves: { type: "array", items: { type: "string" } },
        doesNotProve: { type: "array", items: { type: "string" } },
      },
    },
  },
};

export function buildPublicManifest(config) {
  return {
    name: PRODUCT_NAME,
    technicalName: config.technicalName,
    service: PRODUCT_SLUG,
    version: config.version,
    description: PRODUCT_DESCRIPTION,
    whenToUse:
      "Call before an autonomous agent pays an unknown x402 resource, or after a failed audit when remediation is needed.",
    limitations: [
      "Reports describe observable behavior at a point in time and expire.",
      "The service cannot prove seller intent, future availability, smart-contract safety, or successful future settlement.",
      "The service never signs payment payloads, controls a buyer wallet, or spends funds for the buyer.",
    ],
    interfaces: {
      openapi: `${config.baseUrl}/openapi.json`,
      mcp: `${config.baseUrl}/mcp`,
      x402: `${config.baseUrl}/.well-known/x402.json`,
      llms: `${config.baseUrl}/llms.txt`,
      agent: `${config.baseUrl}/.well-known/agent.json`,
    },
    capabilities: canonicalCapabilities(config),
    labs: legacyCapabilities(config.baseUrl),
  };
}

export function buildAgentMetadata(config) {
  return {
    name: PRODUCT_NAME,
    service: PRODUCT_SLUG,
    version: config.version,
    description: PRODUCT_DESCRIPTION,
    url: config.baseUrl,
    protocols: {
      openapi: `${config.baseUrl}/openapi.json`,
      mcp: `${config.baseUrl}/mcp`,
      x402: `${config.baseUrl}/.well-known/x402.json`,
    },
    capabilities: canonicalCapabilities(config),
    safety: {
      readOnlyInspection: true,
      signsPayments: false,
      spendsBuyerFunds: false,
      acceptsSecrets: false,
      privateTargetsAllowed: false,
    },
    labs: legacyCapabilities(config.baseUrl),
  };
}

export function buildA2ANotImplemented(config, requestId) {
  return {
    error: {
      code: "A2A_NOT_IMPLEMENTED",
      message:
        "x402 Preflight does not implement the A2A protocol. Use the advertised MCP, OpenAPI, or x402 interfaces.",
      retryable: false,
      retryAfterMs: null,
      requestId,
    },
    interfaces: {
      mcp: `${config.baseUrl}/mcp`,
      openapi: `${config.baseUrl}/openapi.json`,
      agentMetadata: `${config.baseUrl}/.well-known/agent.json`,
    },
  };
}

export function buildX402Manifest(config) {
  return {
    x402Version: 2,
    name: PRODUCT_NAME,
    service: PRODUCT_SLUG,
    version: config.version,
    description: PRODUCT_DESCRIPTION,
    homepage: config.baseUrl,
    runtimeAuthority:
      "The live HTTP 402 response is authoritative for amount, network, asset, receiver, and extensions.",
    facilitator: config.facilitator,
    resources: [
      {
        capability: "audit_x402_endpoint",
        url: `${config.baseUrl}/api/x402/preflight/audit`,
        method: "POST",
        description: CAPABILITY_DESCRIPTIONS.audit_x402_endpoint,
        mimeType: "application/json",
        accepts: [paymentRequirement(config, config.auditPrice)],
      },
      {
        capability: "order_x402_remediation",
        url: `${config.baseUrl}/api/x402/preflight/remediation`,
        method: "POST",
        description: CAPABILITY_DESCRIPTIONS.order_x402_remediation,
        mimeType: "application/json",
        accepts: [paymentRequirement(config, config.remediationPrice)],
      },
    ],
    labs: legacyCapabilities(config.baseUrl),
  };
}

export function buildOpenApiDocument(config) {
  return {
    openapi: "3.1.0",
    info: {
      title: PRODUCT_NAME,
      version: config.version,
      description: PRODUCT_DESCRIPTION,
      "x-claim-boundary":
        "Preflight reports are time-bound observations, not guarantees of settlement, delivery, seller trust, or contract safety.",
    },
    servers: [{ url: config.baseUrl }],
    tags: [
      { name: "preflight", description: "The three canonical agent capabilities." },
      { name: "labs", description: "Backward-compatible experimental routes not included as primary operations." },
    ],
    paths: {
      "/api/preflight/inspect": {
        post: operation({
          operationId: "inspect_x402_endpoint",
          summary: "Inspect an x402 endpoint before spending",
          description: CAPABILITY_DESCRIPTIONS.inspect_x402_endpoint,
          requestSchema: "PreflightInput",
          responseSchema: "PreflightReport",
          paid: false,
        }),
      },
      "/api/x402/preflight/audit": {
        post: operation({
          operationId: "audit_x402_endpoint",
          summary: "Run a deep paid x402 endpoint audit",
          description: CAPABILITY_DESCRIPTIONS.audit_x402_endpoint,
          requestSchema: "PreflightInput",
          responseSchema: "PreflightReport",
          paid: true,
          payment: paymentInfo(config, config.auditPrice),
        }),
      },
      "/api/x402/preflight/remediation": {
        post: operation({
          operationId: "order_x402_remediation",
          summary: "Order remediation for a failed x402 preflight",
          description: CAPABILITY_DESCRIPTIONS.order_x402_remediation,
          requestSchema: "RemediationInput",
          responseSchema: "RemediationReceipt",
          paid: true,
          payment: paymentInfo(config, config.remediationPrice),
        }),
      },
    },
    components: {
      schemas: {
        PreflightInput: withoutId(preflightInputSchema),
        PreflightReport: withoutId(preflightReportSchema),
        RemediationInput: withoutId(remediationInputSchema),
        RemediationReceipt: withoutId(remediationReceiptSchema),
        ErrorEnvelope: withoutId(errorEnvelopeSchema),
        PaymentRequired: paymentRequiredSchema(),
      },
    },
    "x-mcp-endpoint": `${config.baseUrl}/mcp`,
    "x-labs": legacyCapabilities(config.baseUrl),
  };
}

export function buildLlmsTxt(config) {
  return `# ${PRODUCT_NAME}

${PRODUCT_DESCRIPTION}

Call this service before paying an unfamiliar x402 endpoint. It never signs a payment, forwards buyer credentials, or spends USDC.

## Canonical capabilities

1. inspect_x402_endpoint — POST ${config.baseUrl}/api/preflight/inspect — free
2. audit_x402_endpoint — POST ${config.baseUrl}/api/x402/preflight/audit — x402 ${config.auditPrice}
3. order_x402_remediation — POST ${config.baseUrl}/api/x402/preflight/remediation — x402 ${config.remediationPrice}

Input example:

{"resource_url":"https://example.com/api/resource","method":"GET","expected_network":"${config.network}","max_price_usd":1}

The live 402 challenge is authoritative for price, network, asset, receiver, and Bazaar extensions. Reports expire and do not guarantee future settlement or delivery.

## Interfaces

- OpenAPI: ${config.baseUrl}/openapi.json
- MCP Streamable HTTP: ${config.baseUrl}/mcp
- x402 metadata: ${config.baseUrl}/.well-known/x402.json
- Agent metadata: ${config.baseUrl}/.well-known/agent.json
- Manifest: ${config.baseUrl}/manifest

## Labs and compatibility

Legacy wallet readiness, market data, weather, repository snapshot, marketplace, webhook, and signer-helper routes remain available but are not primary agent capabilities. See the manifest's labs section.
`;
}

export function buildAiTxt(config) {
  return `# ${PRODUCT_NAME}

Description: ${PRODUCT_DESCRIPTION}
OpenAPI: ${config.baseUrl}/openapi.json
MCP: ${config.baseUrl}/mcp
x402: ${config.baseUrl}/.well-known/x402.json

Primary tools: inspect_x402_endpoint, audit_x402_endpoint, order_x402_remediation.
Never provide private keys, payment signatures, authorization headers, cookies, or access tokens as tool input.
`;
}

export function auditHttpDiscoveryExtension(config) {
  return declareDiscoveryExtension({
    method: "POST",
    bodyType: "json",
    input: preflightInputExample(config),
    inputSchema: schemaBody(preflightInputSchema),
    output: {
      type: "json",
      schema: schemaBody(preflightReportSchema),
      example: preflightReportExample(config),
    },
  });
}

export function remediationHttpDiscoveryExtension(config) {
  return declareDiscoveryExtension({
    method: "POST",
    bodyType: "json",
    input: remediationInputExample(),
    inputSchema: schemaBody(remediationInputSchema),
    output: {
      type: "json",
      schema: schemaBody(remediationReceiptSchema),
      example: remediationReceiptExample(config),
    },
  });
}

export function auditMcpDiscoveryExtension(config) {
  return declareDiscoveryExtension({
    toolName: "audit_x402_endpoint",
    description: CAPABILITY_DESCRIPTIONS.audit_x402_endpoint,
    transport: "streamable-http",
    inputSchema: schemaBody(preflightInputSchema),
    example: preflightInputExample(config),
    output: {
      type: "json",
      schema: schemaBody(preflightReportSchema),
      example: preflightReportExample(config),
    },
  });
}

export function remediationMcpDiscoveryExtension(config) {
  return declareDiscoveryExtension({
    toolName: "order_x402_remediation",
    description: CAPABILITY_DESCRIPTIONS.order_x402_remediation,
    transport: "streamable-http",
    inputSchema: schemaBody(remediationInputSchema),
    example: remediationInputExample(),
    output: {
      type: "json",
      schema: schemaBody(remediationReceiptSchema),
      example: remediationReceiptExample(config),
    },
  });
}

export function preflightInputExample(config) {
  return {
    resource_url: "https://example.com/api/resource",
    method: "GET",
    expected_network: config.network,
    max_price_usd: 1,
  };
}

export function preflightReportExample(config) {
  const observedAt = "2026-08-06T00:00:00.000Z";
  return {
    profile: "audit",
    decision: "ALLOW",
    score: 100,
    requestId: "req_example1234",
    observedAt,
    expiresAt: "2026-08-06T00:15:00.000Z",
    resource: {
      url: "https://example.com/api/resource",
      method: "GET",
      finalUrl: "https://example.com/api/resource",
      statusCode: 402,
      latencyMs: 210,
    },
    payment: {
      detected: true,
      challengeSource: "header",
      x402Version: 2,
      scheme: "exact",
      network: config.network,
      asset: config.asset,
      amountAtomic: "50000",
      priceUsd: 0.05,
      payTo: config.payTo,
      facilitator: config.facilitator,
      maxTimeoutSeconds: 300,
      bazaar: {
        found: true,
        valid: true,
        type: "http",
        method: "POST",
        toolName: null,
        description: null,
        inputSchemaPresent: true,
        outputSchemaPresent: true,
        examplePresent: true,
      },
    },
    cors: {
      allowOrigin: "*",
      allowMethods: ["POST", "OPTIONS"],
      allowHeaders: ["CONTENT-TYPE", "PAYMENT-SIGNATURE"],
      exposeHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE"],
      allowCredentials: null,
      browserAgentCompatible: true,
    },
    checks: [
      {
        id: "payment.network_matches_policy",
        status: "PASS",
        severity: "info",
        evidence: `Published network is ${config.network}.`,
      },
    ],
    issues: [],
    discovery: exampleDiscoverySignals(),
    operational: {
      contentType: "application/json",
      cacheControl: "private, no-store",
      responseBytes: 0,
      timeoutMs: 8000,
      redirectChain: [],
    },
    evidence: [
      {
        id: "resource.response",
        source: "https://example.com/api/resource",
        observation: "HTTP 402 in 210 ms; 0 response bytes.",
      },
    ],
    claimBoundary: {
      proves: ["The listed signals were observed without sending payment credentials."],
      doesNotProve: ["That a future payment will settle or deliver the advertised result."],
    },
  };
}

function canonicalCapabilities(config) {
  return [
    {
      name: "inspect_x402_endpoint",
      description: CAPABILITY_DESCRIPTIONS.inspect_x402_endpoint,
      transport: "https",
      method: "POST",
      endpoint: `${config.baseUrl}/api/preflight/inspect`,
      payment: { required: false },
      inputSchema: preflightInputSchema,
      outputSchema: preflightReportSchema,
    },
    {
      name: "audit_x402_endpoint",
      description: CAPABILITY_DESCRIPTIONS.audit_x402_endpoint,
      transport: "https+x402",
      method: "POST",
      endpoint: `${config.baseUrl}/api/x402/preflight/audit`,
      payment: paymentInfo(config, config.auditPrice),
      inputSchema: preflightInputSchema,
      outputSchema: preflightReportSchema,
    },
    {
      name: "order_x402_remediation",
      description: CAPABILITY_DESCRIPTIONS.order_x402_remediation,
      transport: "https+x402",
      method: "POST",
      endpoint: `${config.baseUrl}/api/x402/preflight/remediation`,
      payment: paymentInfo(config, config.remediationPrice),
      inputSchema: remediationInputSchema,
      outputSchema: remediationReceiptSchema,
    },
  ];
}

function legacyCapabilities(baseUrl) {
  return [
    { category: "wallet", endpoint: `${baseUrl}/api/preview`, status: "labs" },
    { category: "wallet", endpoint: `${baseUrl}/api/readiness`, status: "legacy" },
    { category: "market", endpoint: `${baseUrl}/api/market/crypto-snapshot`, status: "labs" },
    { category: "market", endpoint: `${baseUrl}/api/market/ohlcv`, status: "labs" },
    { category: "developer", endpoint: `${baseUrl}/api/dev/repo-snapshot`, status: "labs" },
    { category: "weather", endpoint: `${baseUrl}/api/weather/current`, status: "labs" },
    { category: "services", endpoint: `${baseUrl}/api/x402/services/quick-review`, status: "legacy" },
    {
      category: "services",
      endpoint: `${baseUrl}/api/x402/services/integration-triage`,
      status: "legacy",
    },
  ];
}

function operation({
  operationId,
  summary,
  description,
  requestSchema,
  responseSchema,
  paid,
  payment,
}) {
  return {
    tags: ["preflight"],
    operationId,
    summary,
    description,
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: { $ref: `#/components/schemas/${requestSchema}` },
        },
      },
    },
    ...(paid ? { "x-payment-info": payment } : {}),
    responses: {
      200: {
        description: "Deterministic structured result.",
        content: {
          "application/json": {
            schema: { $ref: `#/components/schemas/${responseSchema}` },
          },
        },
      },
      ...(paid
        ? {
            402: {
              description: "x402 payment challenge. Runtime values are authoritative.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/PaymentRequired" },
                },
              },
            },
          }
        : {}),
      400: errorResponse("Invalid or blocked target."),
      502: errorResponse("The target or facilitator was unavailable."),
      504: errorResponse("The target timed out."),
    },
  };
}

function errorResponse(description) {
  return {
    description,
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/ErrorEnvelope" },
      },
    },
  };
}

function paymentRequiredSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["x402Version", "accepts", "resource"],
    properties: {
      x402Version: { type: "integer", enum: [2] },
      error: { type: "string" },
      accepts: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["scheme", "network", "asset", "amount", "payTo", "maxTimeoutSeconds"],
          properties: {
            scheme: { type: "string" },
            network: { type: "string" },
            asset: { type: "string" },
            amount: { type: "string", pattern: "^\\d+$" },
            payTo: { type: "string" },
            maxTimeoutSeconds: { type: "integer" },
            extra: {
              type: "object",
              additionalProperties: false,
              properties: {
                name: { type: "string" },
                version: { type: "string" },
              },
            },
          },
        },
      },
      resource: {
        type: "object",
        additionalProperties: false,
        required: ["url", "description", "mimeType"],
        properties: {
          url: { type: "string" },
          description: { type: "string" },
          mimeType: { type: "string" },
        },
      },
      extensions: {
        type: "object",
        additionalProperties: false,
        properties: {
          bazaar: { type: "object" },
        },
      },
    },
  };
}

function paymentInfo(config, price) {
  return {
    required: true,
    protocol: "x402",
    scheme: "exact",
    priceUsd: priceNumber(price),
    network: config.network,
    asset: config.asset,
    payTo: config.payTo,
    facilitator: config.facilitator,
    runtimeAuthority: true,
  };
}

function paymentRequirement(config, price) {
  return {
    scheme: "exact",
    network: config.network,
    asset: config.asset,
    amount: String(Math.round(priceNumber(price) * 1_000_000)),
    payTo: config.payTo,
    maxTimeoutSeconds: 300,
  };
}

function remediationInputExample() {
  return {
    resource_url: "https://example.com/api/resource",
    goal: "Make the x402 challenge consistent and browser-agent compatible.",
    response_format: "both",
    language: "en",
  };
}

function remediationReceiptExample(config) {
  return {
    capability: "order_x402_remediation",
    service: "Base USDC x402 Integration Triage",
    orderId: "triage-example",
    status: "paid_intake_received",
    acceptedAt: "2026-08-06T00:00:00.000Z",
    payment: {
      asset: "native USDC",
      assetContract: config.asset,
      network: "Base",
      networkCaip2: config.network,
      expectedAmountAtomic: String(Math.round(priceNumber(config.remediationPrice) * 1_000_000)),
      expectedAmountUsd: priceNumber(config.remediationPrice),
      payTo: config.payTo,
      facilitator: config.facilitator,
    },
    request: {
      repository_or_url: "https://example.com/api/resource",
      goal: "Make the x402 challenge consistent and browser-agent compatible.",
      contact: "",
      constraints: "",
      callback_url: "",
      response_format: "both",
      language: "en",
    },
    review: {
      status: "awaiting_settlement",
      statusUrl: `${config.baseUrl}/api/x402/orders/triage-example`,
      resultUrl: `${config.baseUrl}/api/x402/orders/triage-example/result`,
      reportUrl: `${config.baseUrl}/api/x402/orders/triage-example/report.md`,
      estimatedCompletionMinutes: 30,
      accessToken: "returned-once-after-valid-payment",
    },
    persistence: {
      status: "durable_intake_record_created",
      settlementTracking: true,
    },
    claimBoundary: {
      proves: ["A paid remediation intake was durably accepted before settlement."],
      doesNotProve: ["That remediation is complete."],
    },
  };
}

function exampleDiscoverySignals() {
  const signal = path => ({
    url: `https://example.com${path}`,
    statusCode: 200,
    contentType: path.endsWith(".txt") ? "text/plain" : "application/json",
    present: true,
    valid: true,
    consistent: true,
  });
  return {
    openapi: signal("/openapi.json"),
    llmsTxt: signal("/llms.txt"),
    agentMetadata: signal("/.well-known/agent.json"),
    x402Metadata: signal("/.well-known/x402.json"),
  };
}

function schemaBody(schema) {
  const copy = withoutId(schema);
  delete copy.$schema;
  normalizeBazaarFormats(copy);
  return copy;
}

function normalizeBazaarFormats(value) {
  if (!value || typeof value !== "object") return;
  if (value.format === "uri") {
    delete value.format;
    value.pattern ??= "^https?://";
  } else if (value.format === "date-time") {
    delete value.format;
    value.pattern ??= "^\\d{4}-\\d{2}-\\d{2}T";
  }
  for (const child of Object.values(value)) normalizeBazaarFormats(child);
}

function withoutId(schema) {
  const copy = structuredClone(schema);
  delete copy.$id;
  return copy;
}

function priceNumber(value) {
  return Number(String(value).replace(/^\$/, ""));
}
