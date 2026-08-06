import crypto from "node:crypto";
import {
  claimNextDelivery,
  claimNextReviewJob,
  completeReviewJob,
  failReviewJob,
  heartbeatReviewJob,
  initializeOrderStore,
  markDeliveryDelivered,
  markDeliveryFailed,
  recordServiceHeartbeat,
  requeueExpiredReviewJobs,
  requeueStaleDeliveries,
} from "../order-store.js";
import { serviceRuntime } from "../service-runtime.js";
import { createTelemetry } from "../telemetry.js";
import { sendWebhook } from "./delivery.js";
import { runReviewAgent } from "./agent-runner.js";
import { renderReviewMarkdown } from "./markdown-renderer.js";
import { inspectEndpoint } from "./endpoint-inspector.js";
import { inspectRepository } from "./repository-inspector.js";
import { buildReviewResult } from "./result-schema.js";
import { normalizeReviewTarget, TargetAccessError } from "./target-policy.js";

const WORKER_ENABLED = process.env.REVIEW_WORKER_ENABLED === "true";
const CONCURRENCY = Math.max(1, Number(process.env.REVIEW_WORKER_CONCURRENCY ?? "1"));
const LEASE_SECONDS = Math.max(60, Number(process.env.REVIEW_JOB_LEASE_SECONDS ?? "300"));
const POLL_MS = Math.max(500, Number(process.env.REVIEW_WORKER_POLL_MS ?? "2000"));
const MAX_DURATION_MS = Math.max(
  30_000,
  Number(process.env.REVIEW_MAX_DURATION_SECONDS ?? "1800") * 1000,
);
const PUBLIC_URL = String(
  process.env.PUBLIC_URL ?? "https://x402-wallet-readiness-service.vercel.app",
).replace(/\/$/, "");
const RUNTIME = serviceRuntime();
const TELEMETRY = createTelemetry();

export async function runReviewWorker({ once = false } = {}) {
  if (!once && !WORKER_ENABLED) {
    console.log("review worker disabled by REVIEW_WORKER_ENABLED");
    return;
  }

  validateWorkerConfiguration();
  await initializeOrderStore();
  const workerId = `${process.env.HOSTNAME || "x402-worker"}-${crypto.randomUUID().slice(0, 8)}`;
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);

  do {
    await recordServiceHeartbeat("review-worker", {
      version: RUNTIME.version,
      commitSha: RUNTIME.commitSha,
    }).catch(error => logError("record worker heartbeat", error));
    await requeueExpiredReviewJobs().catch(error => logError("requeue expired jobs", error));
    await requeueStaleDeliveries().catch(error => logError("requeue stale deliveries", error));
    let worked = false;
    for (let index = 0; index < CONCURRENCY; index += 1) {
      const job = await claimNextReviewJob(workerId, LEASE_SECONDS);
      if (!job) break;
      worked = true;
      await processJob(job, workerId);
    }
    if (await processDelivery(workerId)) worked = true;
    if (once || stopping) break;
    if (!worked) await sleep(POLL_MS);
  } while (!stopping);
}

async function processJob(job, workerId) {
  const heartbeat = setInterval(() => {
    heartbeatReviewJob(job.job_id, workerId, LEASE_SECONDS).catch(error =>
      logError(`heartbeat ${job.order_id}`, error),
    );
  }, Math.max(15_000, Math.floor((LEASE_SECONDS * 1000) / 3)));

  try {
    const reviewWork = (async () => {
      const target = normalizeReviewTarget(job.repository_or_url);
      const inspected = target.kind === "github_repo"
        ? await inspectRepository(target)
        : await inspectEndpoint(target);
      const review = await runReviewAgent({
        job,
        evidence: inspected.evidence,
        targetSnapshot: inspected.snapshot,
      });
      return { inspected, review };
    })();
    const { inspected, review } = await withTimeout(reviewWork, MAX_DURATION_MS);
    review.result.result_url = `${PUBLIC_URL}/api/x402/orders/${encodeURIComponent(job.order_id)}/result`;
    const markdown = renderReviewMarkdown(review.result);
    await completeReviewJob({
      jobId: job.job_id,
      orderId: job.order_id,
      workerId,
      result: review.result,
      reportMarkdown: markdown,
      targetSnapshot: inspected.snapshot,
      agentMetadata: review.metadata,
      status: "completed",
    });
    if (job.service.includes("Integration Triage")) {
      TELEMETRY.record("remediation_order_completed", {
        route: "/api/x402/preflight/remediation",
        network: job.network,
        price_usd: job.amount_usd,
      });
    }
    console.log(JSON.stringify({ event: "review.completed", orderId: job.order_id }));
  } catch (error) {
    if (error instanceof TargetAccessError) {
      await completeNeedsInput(job, workerId, error);
      console.log(JSON.stringify({ event: "review.needs_input", orderId: job.order_id }));
    } else {
      const retry = error.retryable !== false;
      const failure = buildFailureResult(job, error);
      const outcome = await failReviewJob({
        jobId: job.job_id,
        workerId,
        error: error.message,
        retry,
        result: failure.result,
        reportMarkdown: renderReviewMarkdown(failure.result),
        targetSnapshot: failure.targetSnapshot,
        agentMetadata: failure.result.agent,
      });
      if (outcome.job?.status === "failed") {
        console.log(JSON.stringify({ event: "review.failed", orderId: job.order_id }));
      } else {
        logError(`review ${job.order_id} (${outcome.job?.status || "unknown"})`, error);
      }
    }
  } finally {
    clearInterval(heartbeat);
  }
}

async function completeNeedsInput(job, workerId, error) {
  const targetSnapshot = {
    type: "unavailable",
    retrieved_at: new Date().toISOString(),
  };
  const result = buildReviewResult({
    orderId: job.order_id,
    service: job.service,
    goal: job.goal,
    status: "needs_input",
    verdict: "blocked",
    score: null,
    summary: "The automated reviewer could not access or safely inspect the supplied target.",
    checks: [
      {
        id: "target-access",
        status: "blocked",
        summary: error.message,
      },
    ],
    findings: [
      {
        id: "F-001",
        severity: "high",
        title: "Target access is required",
        evidence: { observation: error.message },
        impact: "The reviewer cannot produce evidence-backed findings.",
        recommendation: "Provide a public GitHub repository or HTTPS endpoint and resubmit the review.",
      },
    ],
    nextSteps: ["Confirm that the repository or endpoint is public and reachable."],
    limitations: ["No repository files or endpoint responses were reviewed."],
    targetSnapshot,
    agent: {
      runner_version: "1.0.0",
      provider: "target-policy",
      model: "not-run",
    },
  });
  result.result_url = `${PUBLIC_URL}/api/x402/orders/${encodeURIComponent(job.order_id)}/result`;
  await completeReviewJob({
    jobId: job.job_id,
    orderId: job.order_id,
    workerId,
    result,
    reportMarkdown: renderReviewMarkdown(result),
    targetSnapshot,
    agentMetadata: result.agent,
    status: "needs_input",
  });
}

function buildFailureResult(job, error) {
  const message = String(error?.message || "automated review failed").slice(0, 500);
  const targetSnapshot = {
    type: "review_failure",
    retrieved_at: new Date().toISOString(),
  };
  return {
    targetSnapshot,
    result: buildReviewResult({
      orderId: job.order_id,
      service: job.service,
      goal: job.goal,
      status: "failed",
      verdict: "inconclusive",
      score: null,
      summary: "The automated reviewer exhausted its retry policy before producing a valid review.",
      checks: [
        {
          id: "review-execution",
          status: "failed",
          summary: message,
        },
      ],
      findings: [
        {
          id: "F-001",
          severity: "high",
          title: "Automated review did not complete",
          evidence: { observation: message },
          impact: "No evidence-backed review could be delivered for this paid order.",
          recommendation: "Inspect the worker error and retry the order after correcting the target or service configuration.",
        },
      ],
      nextSteps: ["Inspect the worker error and resubmit the review after the blocker is corrected."],
      limitations: ["The worker exhausted its configured retry policy."],
      targetSnapshot,
      agent: {
        runner_version: "1.0.0",
        provider: "worker",
        model: "not-run",
      },
    }),
  };
}

async function processDelivery(workerId) {
  const delivery = await claimNextDelivery(workerId);
  if (!delivery) return false;
  try {
    const response = await sendWebhook(delivery);
    await markDeliveryDelivered(delivery.delivery_id, response.status);
    TELEMETRY.record("resource_delivered", {
      route: "review-webhook",
      method: "POST",
      status_code: response.status,
    });
    console.log(JSON.stringify({ event: "review.delivery_completed", orderId: delivery.order_id }));
  } catch (error) {
    const retry = !/private|localhost|metadata|HTTPS|credentials/i.test(error.message);
    await markDeliveryFailed(delivery.delivery_id, error.message, retry, error.httpStatus ?? null);
    TELEMETRY.record("resource_failed", {
      route: "review-webhook",
      method: "POST",
      status_code: error.httpStatus ?? 500,
      error_code: "WEBHOOK_DELIVERY_FAILED",
    });
    logError(`delivery ${delivery.order_id}`, error);
  }
  return true;
}

function logError(context, error) {
  console.error(JSON.stringify({ event: "review.error", context, error: error.message }));
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`review exceeded ${Math.round(timeoutMs / 1000)} second limit`);
      error.retryable = true;
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function validateWorkerConfiguration() {
  if (!String(process.env.WEBHOOK_SIGNING_KEY ?? "").trim()) {
    throw new Error("WEBHOOK_SIGNING_KEY is required for the review worker");
  }
  const provider = String(process.env.REVIEW_AGENT_PROVIDER ?? "deterministic").trim().toLowerCase();
  if (["openai", "openai-compatible"].includes(provider)) {
    if (!String(process.env.REVIEW_AGENT_API_URL ?? "").trim()) {
      throw new Error("REVIEW_AGENT_API_URL is required for the configured review agent");
    }
    if (!String(process.env.REVIEW_AGENT_API_KEY ?? "").trim()) {
      throw new Error("REVIEW_AGENT_API_KEY is required for the configured review agent");
    }
  }
}
