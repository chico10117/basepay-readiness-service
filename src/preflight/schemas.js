export const PREFLIGHT_DECISIONS = ["ALLOW", "CAUTION", "BLOCK", "UNKNOWN"];
export const PREFLIGHT_CHECK_STATUSES = ["PASS", "WARN", "FAIL", "UNKNOWN"];
export const PREFLIGHT_SEVERITIES = ["critical", "high", "medium", "low", "info"];

const nullableString = { type: ["string", "null"] };
const nullableNumber = { type: ["number", "null"] };
const nullableInteger = { type: ["integer", "null"] };

export const preflightInputSchema = {
  $id: "https://x402-preflight.dev/schemas/preflight-input.json",
  type: "object",
  additionalProperties: false,
  required: ["resource_url"],
  properties: {
    resource_url: {
      type: "string",
      format: "uri",
      pattern: "^https://",
      maxLength: 2048,
      description: "Public HTTPS x402 resource to inspect without payment credentials.",
    },
    method: {
      type: "string",
      enum: ["GET", "HEAD", "POST"],
      default: "GET",
    },
    expected_network: {
      type: "string",
      pattern: "^[a-z0-9]+:[A-Za-z0-9._-]+$",
      maxLength: 100,
    },
    max_price_usd: {
      type: "number",
      minimum: 0,
      maximum: 1000000,
    },
  },
};

export const remediationInputSchema = {
  $id: "https://x402-preflight.dev/schemas/remediation-input.json",
  type: "object",
  additionalProperties: false,
  required: ["resource_url", "goal"],
  properties: {
    resource_url: {
      type: "string",
      format: "uri",
      pattern: "^https://",
      maxLength: 500,
    },
    goal: { type: "string", minLength: 1, maxLength: 800 },
    contact: { type: "string", maxLength: 300 },
    constraints: { type: "string", maxLength: 1000 },
    callback_url: {
      type: "string",
      format: "uri",
      pattern: "^https://",
      maxLength: 2000,
    },
    response_format: {
      type: "string",
      enum: ["json", "markdown", "both"],
      default: "both",
    },
    language: { type: "string", minLength: 2, maxLength: 20, default: "en" },
  },
};

const discoverySignalSchema = {
  type: "object",
  additionalProperties: false,
  required: ["url", "statusCode", "contentType", "present", "valid", "consistent"],
  properties: {
    url: { type: "string" },
    statusCode: nullableInteger,
    contentType: nullableString,
    present: { type: "boolean" },
    valid: { type: ["boolean", "null"] },
    consistent: { type: ["boolean", "null"] },
  },
};

export const preflightReportSchema = {
  $id: "https://x402-preflight.dev/schemas/preflight-report.json",
  type: "object",
  additionalProperties: false,
  required: [
    "profile",
    "decision",
    "score",
    "requestId",
    "observedAt",
    "expiresAt",
    "resource",
    "payment",
    "cors",
    "checks",
    "issues",
    "discovery",
    "operational",
    "evidence",
    "claimBoundary",
  ],
  properties: {
    profile: { type: "string", enum: ["inspect", "audit"] },
    decision: { type: "string", enum: PREFLIGHT_DECISIONS },
    score: { type: "integer", minimum: 0, maximum: 100 },
    requestId: { type: "string", pattern: "^req_[A-Za-z0-9_-]+$" },
    observedAt: { type: "string", format: "date-time" },
    expiresAt: { type: "string", format: "date-time" },
    resource: {
      type: "object",
      additionalProperties: false,
      required: ["url", "method", "finalUrl", "statusCode", "latencyMs"],
      properties: {
        url: { type: "string", format: "uri" },
        method: { type: "string", enum: ["GET", "HEAD", "POST"] },
        finalUrl: { type: "string", format: "uri" },
        statusCode: nullableInteger,
        latencyMs: { type: "integer", minimum: 0 },
      },
    },
    payment: {
      type: "object",
      additionalProperties: false,
      required: [
        "detected",
        "challengeSource",
        "x402Version",
        "scheme",
        "network",
        "asset",
        "amountAtomic",
        "priceUsd",
        "payTo",
        "facilitator",
        "maxTimeoutSeconds",
        "bazaar",
      ],
      properties: {
        detected: { type: "boolean" },
        challengeSource: { type: ["string", "null"], enum: ["header", "body", null] },
        x402Version: nullableInteger,
        scheme: nullableString,
        network: nullableString,
        asset: nullableString,
        amountAtomic: nullableString,
        priceUsd: nullableNumber,
        payTo: nullableString,
        facilitator: nullableString,
        maxTimeoutSeconds: nullableInteger,
        bazaar: {
          type: "object",
          additionalProperties: false,
          required: [
            "found",
            "valid",
            "type",
            "method",
            "toolName",
            "description",
            "inputSchemaPresent",
            "outputSchemaPresent",
            "examplePresent",
          ],
          properties: {
            found: { type: "boolean" },
            valid: { type: ["boolean", "null"] },
            type: nullableString,
            method: nullableString,
            toolName: nullableString,
            description: nullableString,
            inputSchemaPresent: { type: "boolean" },
            outputSchemaPresent: { type: "boolean" },
            examplePresent: { type: "boolean" },
          },
        },
      },
    },
    cors: {
      type: "object",
      additionalProperties: false,
      required: [
        "allowOrigin",
        "allowMethods",
        "allowHeaders",
        "exposeHeaders",
        "allowCredentials",
        "browserAgentCompatible",
      ],
      properties: {
        allowOrigin: nullableString,
        allowMethods: { type: "array", items: { type: "string" } },
        allowHeaders: { type: "array", items: { type: "string" } },
        exposeHeaders: { type: "array", items: { type: "string" } },
        allowCredentials: { type: ["boolean", "null"] },
        browserAgentCompatible: { type: ["boolean", "null"] },
      },
    },
    checks: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "status", "severity", "evidence"],
        properties: {
          id: { type: "string", maxLength: 120 },
          status: { type: "string", enum: PREFLIGHT_CHECK_STATUSES },
          severity: { type: "string", enum: PREFLIGHT_SEVERITIES },
          evidence: { type: "string", maxLength: 2000 },
        },
      },
    },
    issues: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["code", "severity", "retryable", "message", "remediation"],
        properties: {
          code: { type: "string", pattern: "^[A-Z0-9_]+$" },
          severity: { type: "string", enum: PREFLIGHT_SEVERITIES },
          retryable: { type: "boolean" },
          message: { type: "string", maxLength: 2000 },
          remediation: { type: "string", maxLength: 2000 },
        },
      },
    },
    discovery: {
      type: "object",
      additionalProperties: false,
      required: ["openapi", "llmsTxt", "agentMetadata", "x402Metadata"],
      properties: {
        openapi: discoverySignalSchema,
        llmsTxt: discoverySignalSchema,
        agentMetadata: discoverySignalSchema,
        x402Metadata: discoverySignalSchema,
      },
    },
    operational: {
      type: "object",
      additionalProperties: false,
      required: [
        "contentType",
        "cacheControl",
        "responseBytes",
        "timeoutMs",
        "redirectChain",
      ],
      properties: {
        contentType: nullableString,
        cacheControl: nullableString,
        responseBytes: { type: "integer", minimum: 0 },
        timeoutMs: { type: "integer", minimum: 1 },
        redirectChain: {
          type: "array",
          maxItems: 5,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["from", "to", "statusCode"],
            properties: {
              from: { type: "string", format: "uri" },
              to: { type: "string", format: "uri" },
              statusCode: { type: "integer", minimum: 300, maximum: 399 },
            },
          },
        },
      },
    },
    evidence: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "source", "observation"],
        properties: {
          id: { type: "string", maxLength: 120 },
          source: { type: "string", maxLength: 500 },
          observation: { type: "string", maxLength: 2000 },
        },
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

export const errorEnvelopeSchema = {
  $id: "https://x402-preflight.dev/schemas/error.json",
  type: "object",
  additionalProperties: false,
  required: ["error"],
  properties: {
    error: {
      type: "object",
      additionalProperties: false,
      required: ["code", "message", "retryable", "retryAfterMs", "requestId"],
      properties: {
        code: { type: "string", pattern: "^[A-Z0-9_]+$" },
        message: { type: "string" },
        retryable: { type: "boolean" },
        retryAfterMs: { type: ["integer", "null"], minimum: 0 },
        requestId: { type: "string" },
      },
    },
  },
};

export class PreflightInputError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "PreflightInputError";
    this.code = code;
    this.statusCode = options.statusCode ?? 400;
    this.retryable = Boolean(options.retryable);
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

export function validatePreflightInput(value, options = {}) {
  const input = requirePlainObject(value, "request body");
  rejectUnknownKeys(input, Object.keys(preflightInputSchema.properties));
  const resourceUrl = requiredString(input.resource_url, "resource_url", 2048);
  if (Object.hasOwn(input, "method") && typeof input.method !== "string") {
    throw new PreflightInputError("INVALID_FIELD_TYPE", "method must be a string");
  }
  const method = String(input.method ?? "GET").trim().toUpperCase();
  if (!preflightInputSchema.properties.method.enum.includes(method)) {
    throw new PreflightInputError(
      "INVALID_METHOD",
      "method must be GET, HEAD, or POST",
    );
  }

  const expectedNetwork = optionalString(
    input.expected_network === undefined ? options.defaultNetwork : input.expected_network,
    "expected_network",
    100,
  );
  if (expectedNetwork && !/^[a-z0-9]+:[A-Za-z0-9._-]+$/.test(expectedNetwork)) {
    throw new PreflightInputError(
      "INVALID_EXPECTED_NETWORK",
      "expected_network must be a CAIP-2 network identifier",
    );
  }

  let maxPriceUsd = null;
  if (input.max_price_usd !== undefined) {
    if (typeof input.max_price_usd !== "number") {
      throw new PreflightInputError(
        "INVALID_FIELD_TYPE",
        "max_price_usd must be a number",
      );
    }
    maxPriceUsd = input.max_price_usd;
    if (!Number.isFinite(maxPriceUsd) || maxPriceUsd < 0 || maxPriceUsd > 1_000_000) {
      throw new PreflightInputError(
        "INVALID_MAX_PRICE",
        "max_price_usd must be between 0 and 1000000",
      );
    }
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(resourceUrl);
  } catch {
    throw new PreflightInputError("INVALID_RESOURCE_URL", "resource_url must be a valid URL");
  }
  if (parsedUrl.protocol !== "https:") {
    throw new PreflightInputError(
      "INSECURE_RESOURCE_URL",
      "resource_url must use HTTPS",
    );
  }
  if (parsedUrl.username || parsedUrl.password) {
    throw new PreflightInputError(
      "RESOURCE_URL_CREDENTIALS_BLOCKED",
      "resource_url must not contain credentials",
    );
  }
  rejectSensitiveUrlParameters(parsedUrl);
  parsedUrl.hash = "";

  return {
    resource_url: parsedUrl.toString(),
    method,
    expected_network: expectedNetwork || null,
    max_price_usd: maxPriceUsd,
  };
}

export function validateRemediationInput(value) {
  const input = requirePlainObject(value, "request body");
  rejectUnknownKeys(input, Object.keys(remediationInputSchema.properties));
  const resourceUrl = requiredString(input.resource_url, "resource_url", 500);
  const goal = requiredString(input.goal, "goal", 800);
  const responseFormat = optionalString(input.response_format, "response_format", 20) || "both";
  if (!remediationInputSchema.properties.response_format.enum.includes(responseFormat)) {
    throw new PreflightInputError(
      "INVALID_RESPONSE_FORMAT",
      "response_format must be json, markdown, or both",
    );
  }
  const parsedResourceUrl = parsePublicHttpsInputUrl(resourceUrl, "resource_url");
  const callbackUrl = optionalString(input.callback_url, "callback_url", 2000);
  const parsedCallbackUrl = callbackUrl
    ? parsePublicHttpsInputUrl(callbackUrl, "callback_url")
    : "";
  const contact = optionalString(input.contact, "contact", 300);
  const constraints = optionalString(input.constraints, "constraints", 1000);
  const language = optionalString(input.language, "language", 20) || "en";
  if (language.length < 2) {
    throw new PreflightInputError(
      "INVALID_LANGUAGE",
      "language must contain at least 2 characters",
    );
  }
  for (const [field, text] of Object.entries({ goal, contact, constraints })) {
    rejectSensitiveInputText(field, text);
  }
  return {
    resource_url: parsedResourceUrl,
    goal,
    contact,
    constraints,
    callback_url: parsedCallbackUrl,
    response_format: responseFormat,
    language,
  };
}

export function errorEnvelope(error, requestId) {
  return {
    error: {
      code: String(error?.code || "INTERNAL_ERROR"),
      message: String(error?.message || "Unexpected server error").slice(0, 2000),
      retryable: Boolean(error?.retryable),
      retryAfterMs: Number.isInteger(error?.retryAfterMs) ? error.retryAfterMs : null,
      requestId,
    },
  };
}

function requirePlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PreflightInputError("INVALID_REQUEST", `${label} must be a JSON object`);
  }
  return value;
}

function rejectUnknownKeys(value, allowed) {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length) {
    throw new PreflightInputError(
      "UNKNOWN_INPUT_FIELD",
      `unsupported input field: ${unknown[0]}`,
    );
  }
}

function requiredString(value, name, maxLength) {
  const result = optionalString(value, name, maxLength);
  if (!result) {
    throw new PreflightInputError("MISSING_REQUIRED_FIELD", `${name} is required`);
  }
  return result;
}

function optionalString(value, name, maxLength) {
  if (value === undefined) return "";
  if (typeof value !== "string") {
    throw new PreflightInputError("INVALID_FIELD_TYPE", `${name} must be a string`);
  }
  const result = value.trim();
  if (result.length > maxLength) {
    throw new PreflightInputError(
      "FIELD_TOO_LONG",
      `${name} must be ${maxLength} characters or fewer`,
    );
  }
  return result;
}

function rejectSensitiveUrlParameters(url) {
  const blocked = /^(?:token|access_?token|api_?key|authorization|cookie|password|private_?key|secret|signature)$/i;
  for (const name of url.searchParams.keys()) {
    if (blocked.test(name)) {
      throw new PreflightInputError(
        "RESOURCE_URL_SECRET_BLOCKED",
        `resource_url must not contain the sensitive query parameter ${name}`,
      );
    }
  }
}

function rejectSensitiveInputText(field, value) {
  const text = String(value ?? "");
  const looksSensitive =
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(text) ||
    /\b(?:sk|pk|ghp|gho|github_pat|xox[baprs]-)[A-Za-z0-9_-]{16,}\b/i.test(text) ||
    /\b(?:api[-_ ]?key|authorization|cookie|private[-_ ]?key|seed phrase|mnemonic|password)\s*[:=]\s*\S+/i.test(text) ||
    /\b0x[a-f0-9]{64}\b/i.test(text);
  if (!looksSensitive) return;
  throw new PreflightInputError(
    "SENSITIVE_INPUT_BLOCKED",
    `${field} must not contain private keys, credentials, access tokens, or cookies`,
  );
}

function parsePublicHttpsInputUrl(value, field) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new PreflightInputError("INVALID_RESOURCE_URL", `${field} must be a valid URL`);
  }
  if (url.protocol !== "https:") {
    throw new PreflightInputError("INSECURE_RESOURCE_URL", `${field} must use HTTPS`);
  }
  if (url.username || url.password) {
    throw new PreflightInputError(
      "RESOURCE_URL_CREDENTIALS_BLOCKED",
      `${field} must not contain credentials`,
    );
  }
  rejectSensitiveUrlParameters(url);
  url.hash = "";
  return url.toString();
}
