import { assertPublicUrl, TargetAccessError } from "../review/target-policy.js";
import { inspectX402Endpoint } from "./inspector.js";
import {
  errorEnvelope,
  PreflightInputError,
  validatePreflightInput,
  validateRemediationInput,
} from "./schemas.js";

export function createPreflightHandlers(options) {
  const common = {
    defaultNetwork: options.network,
    usdcContract: options.usdcContract,
  };

  return {
    validateInspect: validatePreflightBody(common),
    validateAudit: validatePreflightBody(common),
    validateRemediation: validateRemediationBody(),
    inspect: async (req, res) => {
      try {
        const report = await inspectX402Endpoint(req.preflightInput ?? req.body, {
          ...common,
          profile: "inspect",
          requestId: req.requestId,
        });
        res.set("Cache-Control", "private, no-store");
        res.json(report);
        options.onInspection?.(req, report);
      } catch (error) {
        sendPreflightError(res, req, error);
      }
    },
    audit: async (req, res) => {
      try {
        const report = await inspectX402Endpoint(req.preflightInput ?? req.body, {
          ...common,
          profile: "audit",
          requestId: req.requestId,
        });
        res.set("Cache-Control", "private, no-store");
        res.json(report);
        options.onInspection?.(req, report);
      } catch (error) {
        sendPreflightError(res, req, error);
      }
    },
  };
}

export function createRemediationAvailabilityMiddleware(checkAvailability) {
  return async (req, res, next) => {
    try {
      if (await checkAvailability()) {
        next();
        return;
      }
      sendPreflightError(res, req, remediationUnavailableError());
    } catch {
      sendPreflightError(res, req, remediationUnavailableError());
    }
  };
}

export function canonicalRemediationParams(input) {
  const normalized = validateRemediationInput(input);
  return {
    repository_or_url: normalized.resource_url,
    goal: normalized.goal,
    contact: normalized.contact,
    constraints: normalized.constraints,
    callback_url: normalized.callback_url,
    response_format: normalized.response_format,
    language: normalized.language,
  };
}

export function canonicalRemediationReceipt(receipt) {
  return {
    capability: "order_x402_remediation",
    service: receipt.service,
    orderId: receipt.orderId,
    status: receipt.status,
    acceptedAt: receipt.acceptedAt,
    payment: {
      asset: receipt.payment.asset,
      assetContract: receipt.payment.assetContract,
      network: receipt.payment.network,
      networkCaip2: receipt.payment.networkCaip2,
      expectedAmountAtomic: receipt.payment.expectedAmountAtomic,
      expectedAmountUsd: receipt.payment.expectedAmountUsd,
      payTo: receipt.payment.payTo,
      facilitator: receipt.payment.facilitator,
    },
    request: receipt.request,
    review: receipt.review,
    persistence: receipt.persistence,
    claimBoundary: {
      proves: ["A paid remediation intake was durably accepted before settlement."],
      doesNotProve: [
        "That remediation is complete.",
        "That the service will deploy changes without explicit owner authorization.",
      ],
    },
  };
}

export function sendPreflightError(res, req, error) {
  const normalized = normalizePreflightError(error);
  res.locals.errorCode = normalized.code;
  if (normalized.retryAfterMs) {
    res.set("Retry-After", String(Math.ceil(normalized.retryAfterMs / 1000)));
  }
  res
    .status(normalized.statusCode)
    .json(errorEnvelope(normalized, req.requestId ?? "req_unknown"));
}

function validatePreflightBody(options) {
  return async (req, res, next) => {
    if (req.method === "OPTIONS") return next();
    try {
      req.preflightInput = validatePreflightInput(req.body, options);
      await assertPublicUrl(req.preflightInput.resource_url);
      return next();
    } catch (error) {
      return sendPreflightError(res, req, error);
    }
  };
}

function validateRemediationBody() {
  return async (req, res, next) => {
    if (req.method === "OPTIONS") return next();
    try {
      req.remediationInput = validateRemediationInput(req.body);
      await assertPublicUrl(req.remediationInput.resource_url);
      if (req.remediationInput.callback_url) {
        await assertPublicUrl(req.remediationInput.callback_url);
      }
      return next();
    } catch (error) {
      return sendPreflightError(res, req, error);
    }
  };
}

function normalizePreflightError(error) {
  if (error instanceof PreflightInputError) return error;
  if (error instanceof TargetAccessError) {
    const normalized = new PreflightInputError(
      error.code === "TARGET_ACCESS" ? "TARGET_BLOCKED" : error.code,
      error.message,
      {
        statusCode: error.statusCode,
        retryable: error.retryable,
        retryAfterMs: error.code === "TARGET_TIMEOUT" ? 10_000 : null,
      },
    );
    return normalized;
  }
  if (error?.code && Number.isInteger(error?.statusCode)) {
    return new PreflightInputError(error.code, error.message, {
      statusCode: error.statusCode,
      retryable: error.retryable,
      retryAfterMs: error.retryAfterMs,
    });
  }
  return new PreflightInputError(
    "INTERNAL_ERROR",
    "The preflight inspection failed unexpectedly.",
    { statusCode: 500, retryable: true, retryAfterMs: 10_000 },
  );
}

function remediationUnavailableError() {
  const error = new Error(
    "Durable remediation intake is unavailable until the order database is healthy.",
  );
  error.code = "REMEDIATION_UNAVAILABLE";
  error.statusCode = 503;
  error.retryable = true;
  error.retryAfterMs = 10_000;
  return error;
}
