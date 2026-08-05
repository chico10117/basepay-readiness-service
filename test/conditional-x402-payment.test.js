import assert from "node:assert/strict";
import test from "node:test";

import {
  CONFIG,
  TRANSFER_TOPIC,
  isExpectedRequirement,
  isExpectedTransferLog,
} from "../scripts/conditional-x402-payment.js";

function topic(address) {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
}

function data(value) {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

test("matches only the exact authorized Base USDC funding transfer", () => {
  const log = {
    address: CONFIG.usdcAddress,
    topics: [TRANSFER_TOPIC, topic(CONFIG.fundingAddress), topic(CONFIG.payerAddress)],
    data: data(CONFIG.amountAtomic),
  };

  assert.equal(
    isExpectedTransferLog(
      log,
      CONFIG.fundingAddress,
      CONFIG.payerAddress,
      CONFIG.amountAtomic,
      CONFIG.usdcAddress,
    ),
    true,
  );
  assert.equal(
    isExpectedTransferLog(
      { ...log, data: data(2_000_001n) },
      CONFIG.fundingAddress,
      CONFIG.payerAddress,
      CONFIG.amountAtomic,
      CONFIG.usdcAddress,
    ),
    false,
  );
  assert.equal(
    isExpectedTransferLog(
      { ...log, topics: [TRANSFER_TOPIC, topic(CONFIG.payerAddress), topic(CONFIG.payerAddress)] },
      CONFIG.fundingAddress,
      CONFIG.payerAddress,
      CONFIG.amountAtomic,
      CONFIG.usdcAddress,
    ),
    false,
  );
});

test("accepts only the exact two-USDC x402 challenge", () => {
  const requirement = {
    scheme: "exact",
    network: CONFIG.network,
    amount: CONFIG.amountAtomic.toString(),
    asset: CONFIG.usdcAddress,
    payTo: CONFIG.fundingAddress,
  };

  assert.equal(isExpectedRequirement(requirement), true);
  assert.equal(isExpectedRequirement({ ...requirement, amount: "2000001" }), false);
  assert.equal(isExpectedRequirement({ ...requirement, amount: "not-a-number" }), false);
  assert.equal(isExpectedRequirement({ ...requirement, network: "eip155:1" }), false);
  assert.equal(isExpectedRequirement({ ...requirement, payTo: CONFIG.payerAddress }), false);
});
