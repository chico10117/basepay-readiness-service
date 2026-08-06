const CHALLENGE_HEADERS = [
  "payment-required",
  "x-payment-required",
  "payment",
  "x-payment",
  "www-authenticate",
];

export function parseX402Challenge(headers, body, options = {}) {
  const headerValue = firstHeader(headers, CHALLENGE_HEADERS);
  const candidates = [
    ...(headerValue
      ? [
          { source: "header", value: headerValue },
          { source: "header", value: stripAuthenticationScheme(headerValue) },
          { source: "header", value: decodeBase64Json(headerValue) },
          {
            source: "header",
            value: decodeBase64Json(stripAuthenticationScheme(headerValue)),
          },
        ]
      : []),
    ...(body ? [{ source: "body", value: body }] : []),
  ];

  let parsed = null;
  let source = null;
  for (const candidate of candidates) {
    if (!candidate.value) continue;
    const value = parseJson(candidate.value);
    if (!value) continue;
    const unwrapped = unwrapChallenge(value);
    if (!looksLikeChallenge(unwrapped)) continue;
    parsed = unwrapped;
    source = candidate.source;
    break;
  }

  if (!parsed) {
    return {
      payment: emptyPayment(Boolean(headerValue), headerValue ? "header" : null),
      schemaIssues: headerValue
        ? ["The advertised payment challenge is not valid JSON or base64url JSON."]
        : [],
      contradictions: [],
      requirementCount: 0,
    };
  }

  const requirements = paymentRequirements(parsed);
  const requirement = requirements[0] ?? directRequirement(parsed);
  const x402Version = integerOrNull(parsed.x402Version ?? parsed.version);
  const scheme = stringOrNull(requirement?.scheme ?? parsed.scheme);
  const network = stringOrNull(requirement?.network ?? parsed.network);
  const asset = stringOrNull(requirement?.asset ?? parsed.asset);
  const amountAtomic = atomicAmount(
    requirement?.amount ?? requirement?.maxAmountRequired ?? parsed.amount,
  );
  const payTo = stringOrNull(requirement?.payTo ?? requirement?.pay_to ?? parsed.payTo);
  const facilitator = facilitatorUrl(parsed, requirement);
  const maxTimeoutSeconds = integerOrNull(
    requirement?.maxTimeoutSeconds ?? parsed.maxTimeoutSeconds,
  );
  const bazaar = normalizeBazaar(parsed.extensions?.bazaar ?? requirement?.extensions?.bazaar);
  const schemaIssues = validateRequirements({
    parsed,
    requirements,
    requirement,
    x402Version,
    scheme,
    network,
    asset,
    amountAtomic,
    payTo,
  });

  return {
    payment: {
      detected: true,
      challengeSource: source,
      x402Version,
      scheme,
      network,
      asset,
      amountAtomic,
      priceUsd: usdPrice(amountAtomic, asset, requirement, options),
      payTo,
      facilitator,
      maxTimeoutSeconds,
      bazaar,
    },
    schemaIssues,
    contradictions: requirementContradictions(requirements),
    requirementCount: requirements.length || (requirement ? 1 : 0),
  };
}

function emptyPayment(detected, challengeSource) {
  return {
    detected,
    challengeSource,
    x402Version: null,
    scheme: null,
    network: null,
    asset: null,
    amountAtomic: null,
    priceUsd: null,
    payTo: null,
    facilitator: null,
    maxTimeoutSeconds: null,
    bazaar: normalizeBazaar(null),
  };
}

function firstHeader(headers, names) {
  for (const name of names) {
    const value = typeof headers?.get === "function"
      ? headers.get(name)
      : headers?.[name] ?? headers?.[name.toLowerCase()];
    if (value) return String(value).trim();
  }
  return "";
}

function stripAuthenticationScheme(value) {
  return String(value).replace(/^x402\s+/i, "").trim();
}

function decodeBase64Json(value) {
  const candidate = String(value ?? "").trim();
  if (!/^[A-Za-z0-9+/_=-]{8,}$/.test(candidate)) return "";
  try {
    const decoded = Buffer.from(candidate, "base64url").toString("utf8").trim();
    return decoded.startsWith("{") ? decoded : "";
  } catch {
    return "";
  }
}

function parseJson(value) {
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function unwrapChallenge(value) {
  if (value.paymentRequired && typeof value.paymentRequired === "object") {
    return value.paymentRequired;
  }
  if (value.payment_required && typeof value.payment_required === "object") {
    return value.payment_required;
  }
  return value;
}

function looksLikeChallenge(value) {
  return Boolean(
    value?.x402Version ||
      value?.accepts ||
      value?.paymentRequirements ||
      value?.scheme ||
      (value?.network && (value?.amount || value?.payTo || value?.asset)),
  );
}

function paymentRequirements(value) {
  if (Array.isArray(value.accepts)) return value.accepts.filter(isObject);
  if (Array.isArray(value.paymentRequirements)) {
    return value.paymentRequirements.filter(isObject);
  }
  return [];
}

function directRequirement(value) {
  return looksLikeChallenge(value) ? value : null;
}

function normalizeBazaar(extension) {
  const found = isObject(extension);
  const info = found && isObject(extension.info) ? extension.info : null;
  const input = info && isObject(info.input) ? info.input : null;
  const output = info && isObject(info.output) ? info.output : null;
  const schema = found && isObject(extension.schema) ? extension.schema : null;
  const schemaInput = schema && isObject(schema.properties?.input)
    ? schema.properties.input
    : null;
  const schemaOutput = schema && isObject(schema.properties?.output)
    ? schema.properties.output
    : null;
  const type = stringOrNull(input?.type);
  const inputSchemaPresent = Boolean(
    input?.inputSchema || input?.queryParams || input?.body || schemaInput,
  );
  const outputSchemaPresent = Boolean(
    output && (schemaOutput || output.type || output.format),
  );
  const examplePresent = Boolean(input?.example || output?.example);
  const valid = found
    ? Boolean(
        info &&
          input &&
          ["http", "mcp"].includes(type) &&
          schema &&
          schema.type === "object" &&
          schemaInput &&
          inputSchemaPresent &&
          outputSchemaPresent &&
          examplePresent,
      )
    : null;

  return {
    found,
    valid,
    type,
    method: stringOrNull(input?.method),
    toolName: stringOrNull(input?.toolName),
    description: stringOrNull(input?.description),
    inputSchemaPresent,
    outputSchemaPresent,
    examplePresent,
  };
}

function validateRequirements(values) {
  const issues = [];
  if (!values.x402Version || ![1, 2].includes(values.x402Version)) {
    issues.push("x402Version must be 1 or 2.");
  }
  if (!values.requirement) issues.push("At least one payment requirement is required.");
  if (!values.scheme) issues.push("Payment scheme is missing.");
  if (!values.network) issues.push("Payment network is missing.");
  if (!values.asset) issues.push("Payment asset is missing.");
  if (!values.amountAtomic) issues.push("Payment amount is missing or is not an integer string.");
  if (!values.payTo) issues.push("Payment receiver is missing.");
  if (values.payTo && !isChainAddress(values.payTo)) {
    issues.push("Payment receiver is not a recognized EVM or Solana address.");
  }
  if (values.requirements.some(item => !isObject(item))) {
    issues.push("Payment requirements contain a non-object entry.");
  }
  return issues;
}

function requirementContradictions(requirements) {
  if (requirements.length < 2) return [];
  const contradictions = [];
  const valuesFor = {
    network: requirement => requirement.network,
    asset: requirement => requirement.asset,
    amount: requirement => requirement.amount ?? requirement.maxAmountRequired,
    payTo: requirement => requirement.payTo ?? requirement.pay_to,
    scheme: requirement => requirement.scheme,
  };
  for (const [field, read] of Object.entries(valuesFor)) {
    const values = new Set(
      requirements
        .map(requirement => stringOrNull(read(requirement)))
        .filter(Boolean)
        .map(value => value.toLowerCase()),
    );
    if (values.size > 1) contradictions.push(field);
  }
  return contradictions;
}

function facilitatorUrl(payload, requirement) {
  const candidates = [
    payload.facilitator,
    payload.facilitator?.url,
    requirement?.facilitator,
    requirement?.facilitator?.url,
    requirement?.extra?.facilitator,
    requirement?.extra?.facilitatorUrl,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    try {
      const url = new URL(candidate);
      if (url.protocol === "https:") return url.toString();
    } catch {
      // An unparseable advertised facilitator remains unknown.
    }
  }
  return null;
}

function usdPrice(amountAtomic, asset, requirement, options) {
  if (!amountAtomic) return null;
  const normalizedAsset = String(asset ?? "").toLowerCase();
  const knownUsdc = [options.usdcContract, ...(options.usdcContracts ?? [])]
    .filter(Boolean)
    .some(value => String(value).toLowerCase() === normalizedAsset);
  const name = String(requirement?.extra?.name ?? "").toLowerCase();
  const symbol = String(requirement?.extra?.symbol ?? "").toLowerCase();
  if (!knownUsdc && name !== "usd coin" && symbol !== "usdc") return null;
  const decimals = integerOrNull(requirement?.extra?.decimals) ?? 6;
  if (decimals < 0 || decimals > 30) return null;
  try {
    const atomic = BigInt(amountAtomic);
    const divisor = 10n ** BigInt(decimals);
    const whole = Number(atomic / divisor);
    const fraction = Number(atomic % divisor) / Number(divisor);
    return Number((whole + fraction).toFixed(Math.min(decimals, 8)));
  } catch {
    return null;
  }
}

function atomicAmount(value) {
  if (typeof value === "bigint") return value >= 0n ? value.toString() : null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  const candidate = typeof value === "string" ? value.trim() : "";
  return /^\d+$/.test(candidate) ? candidate : null;
}

function integerOrNull(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function stringOrNull(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, 2000) : null;
}

function isChainAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(value) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
