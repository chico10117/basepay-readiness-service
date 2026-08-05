import { runReviewWorker } from "../src/review/worker.js";

runReviewWorker().catch(error => {
  console.error(JSON.stringify({ event: "review.worker_fatal", error: error.message }));
  process.exitCode = 1;
});
