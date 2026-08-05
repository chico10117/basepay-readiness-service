import { closeOrderStore, getReviewQueueStats, initializeOrderStore } from "../src/order-store.js";

try {
  await initializeOrderStore();
  console.log(JSON.stringify({
    event: "review.metrics",
    observed_at: new Date().toISOString(),
    ...(await getReviewQueueStats()),
  }));
} finally {
  await closeOrderStore();
}
