import { closeOrderStore, getReviewQueueStats, initializeOrderStore } from "../src/order-store.js";

const queueAlertSeconds = Number(process.env.REVIEW_QUEUE_ALERT_SECONDS ?? "60");
const settlementAlertSeconds = Number(
  process.env.SETTLEMENT_RECONCILE_ALERT_SECONDS ?? "60",
);
const failedAlertCount = Number(process.env.REVIEW_FAILED_ALERT_COUNT ?? "1");

try {
  await initializeOrderStore();
  const stats = await getReviewQueueStats();
  const alerts = [];
  const oldest = stats.oldest_queued_at ? Date.parse(stats.oldest_queued_at) : null;
  if (oldest && Date.now() - oldest > queueAlertSeconds * 1000) {
    alerts.push(`oldest queued job exceeds ${queueAlertSeconds} seconds`);
  }
  const oldestSettlement = stats.oldest_awaiting_settlement_at
    ? Date.parse(stats.oldest_awaiting_settlement_at)
    : null;
  if (
    oldestSettlement &&
    Date.now() - oldestSettlement > settlementAlertSeconds * 1000
  ) {
    alerts.push(
      `${stats.awaiting_settlement_jobs} job(s) have awaited settlement reconciliation for more than ${settlementAlertSeconds} seconds`,
    );
  }
  if (Number(stats.failed_jobs || 0) >= failedAlertCount) {
    alerts.push(`${stats.failed_jobs} failed review job(s) require attention`);
  }
  if (Number(stats.failed_deliveries || 0) >= failedAlertCount) {
    alerts.push(`${stats.failed_deliveries} webhook delivery attempt(s) exhausted retries`);
  }
  const payload = {
    event: alerts.length ? "review.alert" : "review.alerts_clear",
    observed_at: new Date().toISOString(),
    alerts,
    stats,
  };
  console[alerts.length ? "error" : "log"](JSON.stringify(payload));
  if (alerts.length) process.exitCode = 2;
} finally {
  await closeOrderStore();
}
