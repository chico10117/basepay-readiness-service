const form = document.querySelector("#checker");
const output = document.querySelector("#output");
const statusOutput = document.querySelector("#status");
const submitButton = form?.querySelector('button[type="submit"]');
const mcpEndpoint = document.querySelector("#mcp-endpoint");

if (mcpEndpoint) mcpEndpoint.textContent = new URL("/mcp", window.location.origin).toString();

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
