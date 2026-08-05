export const REVIEW_RESULT_SCHEMA_VERSION = "x402-review-result/v1";

const VERDICTS = new Set(["ready", "needs_changes", "blocked", "inconclusive"]);
const SEVERITIES = new Set(["critical", "high", "medium", "low", "info"]);
const CHECK_STATUSES = new Set(["passed", "failed", "needs_changes", "not_run", "blocked"]);
const RESULT_STATUSES = new Set(["completed", "needs_input", "failed"]);

export function validateReviewResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("review result must be an object");
  }
  requireString(result.schema_version, "schema_version");
  if (result.schema_version !== REVIEW_RESULT_SCHEMA_VERSION) {
    throw new Error(`unsupported review result schema: ${result.schema_version}`);
  }
  requireString(result.order_id, "order_id", 200);
  requireString(result.service, "service", 200);
  requireString(result.status, "status", 50);
  if (!RESULT_STATUSES.has(result.status)) throw new Error(`invalid review result status: ${result.status}`);
  requireString(result.goal, "goal", 4000);
  if (!VERDICTS.has(result.verdict)) throw new Error("invalid review verdict");
  requireString(result.summary, "summary", 4000);
  if (result.score !== null && result.score !== undefined &&
      (!Number.isInteger(result.score) || result.score < 0 || result.score > 100)) {
    throw new Error("review score must be an integer from 0 to 100 or null");
  }
  if (!Array.isArray(result.checks) || result.checks.length > 50) {
    throw new Error("review checks must be an array with at most 50 entries");
  }
  for (const check of result.checks) {
    requireString(check?.id, "check.id", 100);
    if (!CHECK_STATUSES.has(check.status)) throw new Error(`invalid check status: ${check.status}`);
    requireString(check.summary, "check.summary", 1000);
  }
  if (!Array.isArray(result.findings) || result.findings.length > 50) {
    throw new Error("review findings must be an array with at most 50 entries");
  }
  for (const finding of result.findings) validateFinding(finding);
  validateStringArray(result.next_steps, "next_steps", 50, 1000);
  validateStringArray(result.limitations, "limitations", 50, 1000);
  if (!result.target_snapshot || typeof result.target_snapshot !== "object") {
    throw new Error("target_snapshot is required");
  }
  if (!result.agent || typeof result.agent !== "object") {
    throw new Error("agent metadata is required");
  }
  return result;
}

export function validateFinding(finding) {
  if (!finding || typeof finding !== "object") throw new Error("finding must be an object");
  requireString(finding.id, "finding.id", 100);
  if (!SEVERITIES.has(finding.severity)) throw new Error(`invalid finding severity: ${finding.severity}`);
  requireString(finding.title, "finding.title", 500);
  requireString(finding.impact, "finding.impact", 2000);
  requireString(finding.recommendation, "finding.recommendation", 2000);
  if (!finding.evidence || typeof finding.evidence !== "object") {
    throw new Error("finding evidence is required");
  }
  const hasLocation = finding.evidence.file || finding.evidence.url || finding.evidence.observation;
  if (!hasLocation) throw new Error("finding evidence must contain a location or observation");
  return finding;
}

export function buildReviewResult({
  orderId,
  service,
  goal,
  verdict,
  score,
  summary,
  checks,
  findings,
  nextSteps,
  limitations,
  targetSnapshot,
  agent,
  status = "completed",
}) {
  const result = {
    schema_version: REVIEW_RESULT_SCHEMA_VERSION,
    order_id: orderId,
    status,
    service,
    goal,
    verdict,
    score: score ?? null,
    summary,
    checks,
    findings,
    next_steps: nextSteps,
    limitations,
    target_snapshot: targetSnapshot,
    agent,
    completed_at: new Date().toISOString(),
  };
  return validateReviewResult(result);
}

function requireString(value, name, maxLength = 5000) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  if (value.length > maxLength) throw new Error(`${name} exceeds its size limit`);
}

function validateStringArray(value, name, maxItems, maxLength) {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${name} must be an array`);
  for (const item of value) requireString(item, `${name} item`, maxLength);
}
