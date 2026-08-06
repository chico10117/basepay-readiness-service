import express from "express";
import { assertPublicUrl, TargetAccessError } from "../review/target-policy.js";
import {
  errorEnvelope,
  preflightInputSchema,
  preflightReportSchema,
  remediationInputSchema,
  validatePreflightInput,
  validateRemediationInput,
} from "../preflight/schemas.js";
import { remediationReceiptSchema } from "../preflight/discovery.js";

export const MCP_PROTOCOL_VERSION = "2025-11-25";
const MCP_FALLBACK_PROTOCOL_VERSION = "2025-03-26";
const MCP_SUPPORTED_PROTOCOL_VERSIONS = new Set([
  MCP_PROTOCOL_VERSION,
  "2025-06-18",
  MCP_FALLBACK_PROTOCOL_VERSION,
]);
export const MCP_TOOL_NAMES = [
  "inspect_x402_endpoint",
  "audit_x402_endpoint",
  "order_x402_remediation",
];

export function createMcpTransportMiddleware() {
  return (req, res, next) => {
    if (req.method !== "POST" || req.path !== "/mcp") return next();
    if (!acceptsMcpResponse(req)) {
      return res.status(406).json(
        jsonRpcError(
          req.body?.id ?? null,
          -32600,
          "Accept must include application/json and text/event-stream",
        ),
      );
    }
    const message = req.body;
    if (!isPlainObject(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return res.status(400).json(
        jsonRpcError(message?.id ?? null, -32600, "Invalid JSON-RPC request"),
      );
    }
    const protocolVersion = requestProtocolVersion(req, message);
    if (!protocolVersion) {
      return res.status(400).json(
        jsonRpcError(
          message.id ?? null,
          -32602,
          message.method === "initialize"
            ? "initialize.params.protocolVersion is required"
            : "Unsupported MCP-Protocol-Version header",
          { supported: [...MCP_SUPPORTED_PROTOCOL_VERSIONS] },
        ),
      );
    }
    req.mcpProtocolVersion = protocolVersion;
    res.set("MCP-Protocol-Version", protocolVersion);
    return next();
  };
}

export function createMcpRouter(options) {
  const router = express.Router();
  const tools = buildMcpTools();

  router.get("/mcp", (_req, res) => {
    res.set("Allow", "POST");
    res.status(405).json({
      error: "This stateless MCP server does not provide a server-initiated SSE stream.",
    });
  });

  router.delete("/mcp", (_req, res) => {
    res.set("Allow", "POST");
    res.status(405).end();
  });

  router.post("/mcp", async (req, res) => {
    if (!acceptsMcpResponse(req)) {
      return res.status(406).json(
        jsonRpcError(req.body?.id ?? null, -32600, "Accept must include application/json and text/event-stream"),
      );
    }
    const message = req.body;
    if (!isPlainObject(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return res.status(400).json(jsonRpcError(message?.id ?? null, -32600, "Invalid JSON-RPC request"));
    }

    const protocolVersion = req.mcpProtocolVersion ?? requestProtocolVersion(req, message);
    if (!protocolVersion) {
      return res.status(400).json(
        jsonRpcError(
          message.id ?? null,
          -32602,
          message.method === "initialize"
            ? "initialize.params.protocolVersion is required"
            : "Unsupported MCP-Protocol-Version header",
          { supported: [...MCP_SUPPORTED_PROTOCOL_VERSIONS] },
        ),
      );
    }
    res.set("MCP-Protocol-Version", protocolVersion);

    if (message.id === undefined) {
      return res.status(202).end();
    }

    try {
      switch (message.method) {
        case "initialize":
          return res.json(jsonRpcResult(message.id, {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: {
              name: "x402-preflight",
              title: "x402 Preflight",
              version: options.version,
              description:
                "Inspect, audit, and remediate x402 endpoints before an agent spends USDC.",
            },
            instructions:
              "Use inspect first. Audit and remediation calls are x402-paid; the server returns a 402 challenge and never signs or spends for the client.",
          }));
        case "ping":
          return res.json(jsonRpcResult(message.id, {}));
        case "tools/list":
          options.onToolsListed?.(req);
          return res.json(jsonRpcResult(message.id, { tools }));
        case "tools/call":
          return await callTool(req, res, message, options);
        default:
          return res.status(404).json(jsonRpcError(message.id, -32601, "Method not found"));
      }
    } catch (error) {
      return sendToolExecutionError(res, message.id, req, error);
    }
  });

  return router;
}

export function createMcpOriginMiddleware(options) {
  const configuredOrigins = new Set(
    String(options.allowedOrigins ?? process.env.MCP_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map(value => value.trim())
      .filter(Boolean),
  );
  try {
    configuredOrigins.add(new URL(options.baseUrl).origin);
  } catch {
    // Invalid base URLs are handled by service startup configuration.
  }

  return (req, res, next) => {
    if (req.path !== "/mcp") return next();
    const origin = String(req.get("origin") ?? "").trim();
    if (!origin) return next();
    if (configuredOrigins.has(origin)) return next();
    return res.status(403).json(
      jsonRpcError(req.body?.id ?? null, -32003, "Origin is not allowed for this MCP endpoint"),
    );
  };
}

export function createMcpPaidToolValidator(options) {
  return async (req, res, next) => {
    const toolName = mcpToolName(req);
    if (!toolName || toolName === "inspect_x402_endpoint") return next();
    try {
      const args = req.body?.params?.arguments;
      if (toolName === "audit_x402_endpoint") {
        req.mcpValidatedArguments = validatePreflightInput(args, {
          defaultNetwork: options.network,
        });
        await assertPublicUrl(req.mcpValidatedArguments.resource_url);
      } else if (toolName === "order_x402_remediation") {
        req.mcpValidatedArguments = validateRemediationInput(args);
        await assertPublicUrl(req.mcpValidatedArguments.resource_url);
        if (req.mcpValidatedArguments.callback_url) {
          await assertPublicUrl(req.mcpValidatedArguments.callback_url);
        }
        if (options.remediationAvailable && !(await options.remediationAvailable())) {
          throw serviceUnavailableError();
        }
      }
      return next();
    } catch (error) {
      return sendToolExecutionError(res, req.body?.id ?? null, req, error, 400);
    }
  };
}

export function mcpToolName(req) {
  if (req.method !== "POST" || req.path !== "/mcp") return null;
  if (req.body?.method !== "tools/call") return null;
  const name = req.body?.params?.name;
  return MCP_TOOL_NAMES.includes(name) ? name : null;
}

export function buildMcpTools() {
  return [
    {
      name: "inspect_x402_endpoint",
      title: "Inspect x402 Endpoint",
      description:
        "Call before spending on an unfamiliar x402 resource. Free, read-only, and never sends payment credentials.",
      inputSchema: withoutId(preflightInputSchema),
      outputSchema: withoutId(preflightReportSchema),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    {
      name: "audit_x402_endpoint",
      title: "Audit x402 Endpoint",
      description:
        "Purchase a deep, deterministic audit of payment schema, discovery metadata, redirects, CORS, cache, and operational signals. Returns HTTP 402 until the MCP client supplies a valid payment for this call.",
      inputSchema: withoutId(preflightInputSchema),
      outputSchema: withoutId(preflightReportSchema),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    {
      name: "order_x402_remediation",
      title: "Order x402 Remediation",
      description:
        "Purchase a durable remediation intake after a failed audit. Creates an order but never deploys, signs, or spends automatically.",
      inputSchema: withoutId(remediationInputSchema),
      outputSchema: withoutId(remediationReceiptSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
  ];
}

async function callTool(req, res, message, options) {
  const name = message.params?.name;
  if (!MCP_TOOL_NAMES.includes(name)) {
    return res.status(404).json(jsonRpcError(message.id, -32602, "Unknown tool"));
  }
  const rawArguments = message.params?.arguments ?? {};
  let result;
  if (name === "inspect_x402_endpoint") {
    const args = validatePreflightInput(rawArguments, {
      defaultNetwork: options.network,
    });
    await assertPublicUrl(args.resource_url);
    result = await options.inspect(args, req);
  } else if (name === "audit_x402_endpoint") {
    const args = req.mcpValidatedArguments ?? validatePreflightInput(rawArguments, {
      defaultNetwork: options.network,
    });
    result = await options.audit(args, req);
  } else {
    const args = req.mcpValidatedArguments ?? validateRemediationInput(rawArguments);
    result = await options.remediate(args, req);
  }
  const text = JSON.stringify(result);
  return res.json(jsonRpcResult(message.id, {
    content: [{ type: "text", text }],
    structuredContent: result,
    isError: false,
  }));
}

function sendToolExecutionError(res, id, req, error, statusCode) {
  const retryable = Boolean(error?.retryable);
  const code = String(
    error instanceof TargetAccessError && error.code === "TARGET_ACCESS"
      ? "TARGET_BLOCKED"
      : error?.code || "TOOL_EXECUTION_FAILED",
  );
  const publicError = {
    code,
    message: String(error?.message || "Tool execution failed").slice(0, 2000),
    retryable,
    retryAfterMs: retryable ? 10_000 : null,
  };
  const envelope = errorEnvelope(publicError, req.requestId ?? "req_unknown");
  return res.status(statusCode ?? error?.statusCode ?? 500).json(jsonRpcResult(id, {
    content: [{ type: "text", text: JSON.stringify(envelope) }],
    structuredContent: envelope,
    isError: true,
  }));
}

function acceptsMcpResponse(req) {
  const accept = String(req.get("accept") ?? "").toLowerCase();
  return accept.includes("application/json") && accept.includes("text/event-stream");
}

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id, code, message, data) {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data ? { data } : {}) },
  };
}

function requestProtocolVersion(req, message) {
  if (message.method === "initialize") {
    const requested = message.params?.protocolVersion;
    if (typeof requested !== "string" || !requested) return null;
    return MCP_SUPPORTED_PROTOCOL_VERSIONS.has(requested)
      ? requested
      : MCP_PROTOCOL_VERSION;
  }
  const header = String(req.get("mcp-protocol-version") ?? "").trim();
  if (!header) return MCP_FALLBACK_PROTOCOL_VERSION;
  return MCP_SUPPORTED_PROTOCOL_VERSIONS.has(header) ? header : null;
}

function withoutId(schema) {
  const copy = structuredClone(schema);
  delete copy.$id;
  return copy;
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function serviceUnavailableError() {
  const error = new Error(
    "Durable remediation intake is unavailable until the order database is healthy.",
  );
  error.code = "REMEDIATION_UNAVAILABLE";
  error.statusCode = 503;
  error.retryable = true;
  error.retryAfterMs = 10_000;
  return error;
}
