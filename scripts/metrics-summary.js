import {
  closeOrderStore,
  getCommercialMetricsSummary,
} from "../src/order-store.js";

try {
  console.log(JSON.stringify(await getCommercialMetricsSummary(), null, 2));
} finally {
  await closeOrderStore();
}
