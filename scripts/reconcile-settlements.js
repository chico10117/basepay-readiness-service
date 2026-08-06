import {
  closeOrderStore,
  initializeOrderStore,
  markOrderSettled,
} from "../src/order-store.js";
import { reconcileSettlementJournal } from "../src/settlement-reconciler.js";

try {
  const configured = await initializeOrderStore();
  if (!configured) {
    throw new Error("ORDER_DATABASE_URL is required for settlement reconciliation");
  }

  const result = await reconcileSettlementJournal(
    async settlement => {
      const stored = await markOrderSettled(settlement);
      if (!stored?.stored) throw new Error("paid service order store is unavailable");
    },
    { force: true },
  );
  const summary = {
    event: "settlement.reconciliation_complete",
    observed_at: new Date().toISOString(),
    scanned: result.scanned,
    reconciled: result.reconciled,
    failed: result.failed,
    invalid: result.invalid,
    deferred: result.deferred,
  };
  console[result.failed || result.invalid ? "error" : "log"](
    JSON.stringify(summary),
  );
  if (result.failed || result.invalid) process.exitCode = 2;
} catch (error) {
  console.error(
    JSON.stringify({
      event: "settlement.reconciliation_error",
      observed_at: new Date().toISOString(),
      error: error?.message ?? "settlement reconciliation failed",
    }),
  );
  process.exitCode = 1;
} finally {
  await closeOrderStore();
}
