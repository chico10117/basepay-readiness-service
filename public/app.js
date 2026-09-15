const form = document.querySelector("#checker");
const output = document.querySelector("#output");
const statusOutput = document.querySelector("#status");
const submitButton = form?.querySelector('button[type="submit"]');
const mcpEndpoint = document.querySelector("#mcp-endpoint");
const resourceUrlInput = document.querySelector("#resource-url");
const methodInput = document.querySelector("#request-method");
const expectedNetworkInput = document.querySelector("#expected-network");
const maxPriceInput = document.querySelector("#max-price");
const paidAuditUrl = document.querySelector("#paid-audit-url");
const paidAuditLink = document.querySelector("#paid-audit-link");
const paidAuditNote = document.querySelector("#paid-audit-note");
const copyPaidAuditButton = document.querySelector("#copy-paid-audit");
const quickReviewUrl = document.querySelector("#quick-review-url");
const quickReviewLink = document.querySelector("#quick-review-link");
const integrationTriageUrl = document.querySelector("#integration-triage-url");
const integrationTriageLink = document.querySelector("#integration-triage-link");
const defaultResourceUrl = "https://example.com/api/resource";

if (mcpEndpoint) mcpEndpoint.textContent = new URL("/mcp", window.location.origin).toString();

for (const field of [resourceUrlInput, methodInput, expectedNetworkInput, maxPriceInput]) {
  field?.addEventListener("input", updatePaidAuditHandoff);
  field?.addEventListener("change", updatePaidAuditHandoff);
}

copyPaidAuditButton?.addEventListener("click", async () => {
  const value = paidAuditUrl?.textContent?.trim();
  if (!value) return;

  const originalLabel = copyPaidAuditButton.textContent.trim();
  try {
    await copyText(value);
    copyPaidAuditButton.textContent = "Copied";
  } catch {
    copyPaidAuditButton.textContent = "Copy failed";
  } finally {
    window.setTimeout(() => {
      copyPaidAuditButton.textContent = originalLabel;
    }, 1600);
  }
});

updatePaidAuditHandoff();

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!form.reportValidity()) return;

  const data = new FormData(form);
  const payload = {
    resource_url: String(data.get("resource_url") ?? "").trim(),
    method: String(data.get("method") ?? "GET"),
    expected_network: String(data.get("expected_network") ?? "").trim(),
    max_price_usd: Number(data.get("max_price_usd")),
  };

  if (!payload.expected_network) delete payload.expected_network;
  if (!Number.isFinite(payload.max_price_usd)) delete payload.max_price_usd;

  setState("Inspecting…", "loading");
  submitButton.disabled = true;
  output.setAttribute("aria-busy", "true");
  output.textContent = "Resolving the target and performing bounded read-only probes…";

  try {
    const response = await fetch("/api/preflight/inspect", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const result = await readJson(response);
    if (!response.ok) {
      throw new InspectionError(
        result?.error?.message ?? `Inspection failed with HTTP ${response.status}`,
        result,
      );
    }
    output.textContent = JSON.stringify(result, null, 2);
    setState(result.decision ?? "UNKNOWN", result.decision ?? "UNKNOWN");
  } catch (error) {
    const result = error instanceof InspectionError
      ? error.payload
      : {
          error: {
            code: "CLIENT_REQUEST_FAILED",
            message: error.message,
            retryable: true,
          },
        };
    output.textContent = JSON.stringify(result, null, 2);
    setState("Request failed", "error");
  } finally {
    submitButton.disabled = false;
    output.removeAttribute("aria-busy");
  }
});

function setState(label, state) {
  statusOutput.value = label;
  statusOutput.textContent = label;
  statusOutput.dataset.state = state;
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("The service returned a non-JSON response.");
  }
}

class InspectionError extends Error {
  constructor(message, payload) {
    super(message);
    this.payload = payload;
  }
}

function updatePaidAuditHandoff() {
  if (!paidAuditUrl || !paidAuditLink || !paidAuditNote) return;

  const method = String(methodInput?.value ?? "GET").trim().toUpperCase();
  const queryUrl = ["GET", "HEAD"].includes(method) ? buildPaidAuditQueryUrl(method) : null;
  updateServiceRoutes();

  if (!queryUrl) {
    paidAuditUrl.textContent = new URL("/api/x402/preflight/audit", window.location.origin).toString();
    paidAuditLink.removeAttribute("href");
    paidAuditLink.setAttribute("aria-disabled", "true");
    paidAuditLink.tabIndex = -1;
    paidAuditNote.textContent = "POST targets use the canonical JSON endpoint. The GET alias only audits GET and HEAD targets.";
    return;
  }

  paidAuditUrl.textContent = queryUrl;
  paidAuditLink.href = queryUrl;
  paidAuditLink.removeAttribute("aria-disabled");
  paidAuditLink.tabIndex = 0;
  paidAuditNote.textContent = "Opening this URL returns an x402 challenge until a compatible client supplies payment.";
}

function updateServiceRoutes() {
  const quickUrl = buildServiceRouteUrl(
    "/api/x402/services/quick-review",
    "Verify the x402 payment challenge and identify the next patch.",
  );
  const triageUrl = buildServiceRouteUrl(
    "/api/x402/services/integration-triage",
    "Make the x402 Base USDC endpoint browser-agent readable.",
  );

  setLinkedCode(quickReviewUrl, quickReviewLink, quickUrl);
  setLinkedCode(integrationTriageUrl, integrationTriageLink, triageUrl);
}

function buildServiceRouteUrl(path, goal) {
  const url = new URL(path, window.location.origin);
  url.searchParams.set("repository_or_url", resourceUrlInput?.value?.trim() || defaultResourceUrl);
  url.searchParams.set("goal", goal);
  url.searchParams.set("response_format", "both");
  return url.toString();
}

function setLinkedCode(codeElement, linkElement, value) {
  if (codeElement) codeElement.textContent = value;
  if (linkElement) linkElement.href = value;
}

function buildPaidAuditQueryUrl(method) {
  const url = new URL("/api/x402/preflight/audit", window.location.origin);
  const resourceUrl = resourceUrlInput?.value?.trim() || defaultResourceUrl;
  const expectedNetwork = expectedNetworkInput?.value?.trim();
  const maxPriceValue = maxPriceInput?.value?.trim();
  const maxPrice = Number(maxPriceValue);

  url.searchParams.set("resource_url", resourceUrl);
  url.searchParams.set("method", method);
  if (expectedNetwork) url.searchParams.set("expected_network", expectedNetwork);
  if (maxPriceValue && Number.isFinite(maxPrice)) {
    url.searchParams.set("max_price_usd", String(maxPrice));
  }

  return url.toString();
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const helper = document.createElement("textarea");
  helper.value = value;
  helper.setAttribute("readonly", "");
  helper.style.position = "fixed";
  helper.style.top = "-999px";
  document.body.append(helper);
  helper.select();
  const copied = document.execCommand("copy");
  helper.remove();
  if (!copied) throw new Error("copy command failed");
}
