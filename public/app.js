const form = document.querySelector("#checker");
const input = document.querySelector("#address");
const output = document.querySelector("#output");
const statusText = document.querySelector("#status");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const address = input.value.trim();
  statusText.textContent = "Checking Base...";
  output.textContent = "";

  try {
    const response = await fetch(`/api/preview/${encodeURIComponent(address)}`);
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || `Request failed with ${response.status}`);
    }
    statusText.textContent = payload.status.readiness.replaceAll("_", " ");
    output.textContent = JSON.stringify(payload, null, 2);
  } catch (error) {
    statusText.textContent = "Preview failed";
    output.textContent = error.message;
  }
});
