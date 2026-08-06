import { serviceRuntime } from "../src/service-runtime.js";

const publicUrl = String(process.env.PUBLIC_URL ?? "").trim().replace(/\/$/, "");
if (!publicUrl) throw new Error("PUBLIC_URL is required for verify:runtime");
const expected = serviceRuntime();
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 10_000);

try {
  const response = await fetch(new URL("/health", publicUrl), {
    headers: { accept: "application/json" },
    signal: controller.signal,
  });
  if (!response.ok) throw new Error(`public health returned HTTP ${response.status}`);
  const actual = await response.json();
  if (actual.version !== expected.version) {
    throw new Error(`stale runtime: public version ${actual.version}, expected ${expected.version}`);
  }
  if (expected.commitSha !== "unknown" && actual.commitSha !== expected.commitSha) {
    throw new Error(
      `stale runtime: public commit ${actual.commitSha}, expected ${expected.commitSha}`,
    );
  }
  console.log(JSON.stringify({
    ok: true,
    publicUrl,
    expected: { version: expected.version, commitSha: expected.commitSha },
    actual: { version: actual.version, commitSha: actual.commitSha },
  }, null, 2));
} finally {
  clearTimeout(timer);
}
