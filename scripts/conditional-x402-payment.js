import { createHash } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { x402Client, x402HTTPClient } from "@x402/core/client";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

export const CONFIG = Object.freeze({
  network: "eip155:8453",
  chainId: 8453,
  rpcUrl: process.env.X402_TRIGGER_RPC_URL || "https://mainnet.base.org",
  usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  fundingAddress: "0x820a7bf90d944bb26bfD9b62Ab172Fc3A0829cB9",
  payerAddress: "0x98aA548A9cE3Ed957657E62B73cD44543FD5ac22",
  amountAtomic: 2_000_000n,
  confirmations: 3n,
  endpoint:
    "https://x402-wallet-readiness-service.vercel.app/api/readiness/0x820a7bf90d944bb26bfD9b62Ab172Fc3A0829cB9",
  walletPath:
    process.env.X402_TRIGGER_WALLET_PATH || resolve(homedir(), ".agentcash", "wallet.json"),
  statePath:
    process.env.X402_TRIGGER_STATE_PATH ||
    resolve(homedir(), ".agentcash", "x402-2usdc-trigger.json"),
});

export const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function normalizeAddress(value) {
  return String(value || "").toLowerCase();
}

function addressTopic(address) {
  return `0x${"0".repeat(24)}${normalizeAddress(address).slice(2)}`;
}

function quantity(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function atomicData(value) {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

export function isExpectedRequirement(requirement, config = CONFIG) {
  try {
    return (
      requirement?.scheme === "exact" &&
      requirement?.network === config.network &&
      normalizeAddress(requirement?.asset) === normalizeAddress(config.usdcAddress) &&
      normalizeAddress(requirement?.payTo) === normalizeAddress(config.fundingAddress) &&
      BigInt(requirement?.amount || 0) === config.amountAtomic
    );
  } catch {
    return false;
  }
}

export function isExpectedTransferLog(
  log,
  fromAddress,
  toAddress,
  amountAtomic = CONFIG.amountAtomic,
  tokenAddress = CONFIG.usdcAddress,
) {
  return (
    normalizeAddress(log?.address) === normalizeAddress(tokenAddress) &&
    normalizeAddress(log?.topics?.[0]) === TRANSFER_TOPIC &&
    normalizeAddress(log?.topics?.[1]) === addressTopic(fromAddress) &&
    normalizeAddress(log?.topics?.[2]) === addressTopic(toAddress) &&
    normalizeAddress(log?.data) === atomicData(amountAtomic)
  );
}

async function rpc(method, params, config = CONFIG) {
  const response = await fetch(config.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await response.json();
  if (!response.ok || body.error) {
    throw new Error(body.error?.message || `Base RPC returned HTTP ${response.status}`);
  }
  return body.result;
}

async function getTransferLogs(fromBlock, toBlock, fromAddress, toAddress, config = CONFIG) {
  if (toBlock < fromBlock) return [];
  return rpc(
    "eth_getLogs",
    [
      {
        address: config.usdcAddress,
        fromBlock: quantity(fromBlock),
        toBlock: quantity(toBlock),
        topics: [TRANSFER_TOPIC, addressTopic(fromAddress), addressTopic(toAddress)],
      },
    ],
    config,
  );
}

async function getUsdcBalance(address, config = CONFIG) {
  const data = `0x70a08231${addressTopic(address).slice(2)}`;
  const result = await rpc(
    "eth_call",
    [{ to: config.usdcAddress, data }, "latest"],
    config,
  );
  return BigInt(result);
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writePrivateJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, path);
  await chmod(path, 0o600);
}

async function acquireLock(path) {
  const lockPath = `${path}.lock`;
  try {
    return { handle: await open(lockPath, "wx", 0o600), lockPath };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const lockStat = await stat(lockPath);
    if (Date.now() - lockStat.mtimeMs < 10 * 60 * 1000) return null;
    await unlink(lockPath);
    return { handle: await open(lockPath, "wx", 0o600), lockPath };
  }
}

async function releaseLock(lock) {
  if (!lock) return;
  await lock.handle.close();
  await unlink(lock.lockPath).catch(() => {});
}

function publicLog(log) {
  return {
    transactionHash: log.transactionHash,
    blockNumber: Number(BigInt(log.blockNumber)),
    logIndex: Number(BigInt(log.logIndex)),
  };
}

async function findOutgoingSettlement(sourceTransfer, confirmedBlock, config = CONFIG) {
  const logs = await getTransferLogs(
    BigInt(sourceTransfer.blockNumber),
    confirmedBlock,
    config.payerAddress,
    config.fundingAddress,
    config,
  );
  return logs.find(log =>
    isExpectedTransferLog(
      log,
      config.payerAddress,
      config.fundingAddress,
      config.amountAtomic,
      config.usdcAddress,
    ),
  );
}

function authorizationExpiry(headers) {
  try {
    const encoded = headers["PAYMENT-SIGNATURE"] || headers["payment-signature"];
    const payload = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    return Number(payload?.payload?.authorization?.validBefore || 0);
  } catch {
    return 0;
  }
}

async function createAuthorization(config) {
  const challenge = await fetch(config.endpoint, {
    headers: { accept: "application/json" },
    redirect: "error",
  });
  const paymentRequiredHeader = challenge.headers.get("payment-required");
  if (challenge.status !== 402 || !paymentRequiredHeader) {
    throw new Error(`Expected an x402 challenge, received HTTP ${challenge.status}`);
  }

  const paymentRequired = decodePaymentRequiredHeader(paymentRequiredHeader);
  const expected = paymentRequired.accepts?.filter(requirement =>
    isExpectedRequirement(requirement, config),
  );
  if (
    paymentRequired.x402Version !== 2 ||
    paymentRequired.resource?.url !== config.endpoint ||
    expected?.length !== 1 ||
    paymentRequired.accepts?.length !== 1
  ) {
    throw new Error("The x402 challenge does not exactly match the authorized payment");
  }

  const wallet = await readJson(config.walletPath);
  if (
    normalizeAddress(wallet?.address) !== normalizeAddress(config.payerAddress) ||
    !/^0x[0-9a-fA-F]{64}$/.test(wallet?.privateKey || "")
  ) {
    throw new Error("The local AgentCash signer does not match the authorized payer wallet");
  }

  const account = privateKeyToAccount(wallet.privateKey);
  if (normalizeAddress(account.address) !== normalizeAddress(config.payerAddress)) {
    throw new Error("The local private key does not derive the authorized payer address");
  }

  const client = new x402Client();
  registerExactEvmScheme(client, { signer: account, networks: [config.network] });
  client.registerPolicy((_version, requirements) =>
    requirements.filter(requirement => isExpectedRequirement(requirement, config)),
  );
  const httpClient = new x402HTTPClient(client);
  const payload = await httpClient.createPaymentPayload(paymentRequired);
  return {
    headers: httpClient.encodePaymentSignatureHeader(payload),
    createdAt: new Date().toISOString(),
  };
}

async function waitForReceipt(transactionHash, config = CONFIG) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const receipt = await rpc("eth_getTransactionReceipt", [transactionHash], config);
    if (receipt) return receipt;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 2_000));
  }
  throw new Error(`Settlement receipt was not confirmed within 60 seconds: ${transactionHash}`);
}

async function executeAuthorizedPayment(state, config = CONFIG) {
  let authorization = state.authorization;
  const expiry = authorization ? authorizationExpiry(authorization.headers) : 0;
  if (!authorization || (expiry && expiry <= Math.floor(Date.now() / 1000) + 15)) {
    authorization = await createAuthorization(config);
    state.authorization = authorization;
    state.status = "authorized";
    await writePrivateJson(config.statePath, state);
  }

  const response = await fetch(config.endpoint, {
    headers: { accept: "application/json", ...authorization.headers },
    redirect: "error",
  });
  const responseText = await response.text();
  const paymentResponseHeader =
    response.headers.get("payment-response") || response.headers.get("x-payment-response");

  if (!response.ok || !paymentResponseHeader) {
    state.lastAttempt = {
      at: new Date().toISOString(),
      httpStatus: response.status,
      responseBody: responseText.slice(0, 500),
    };
    await writePrivateJson(config.statePath, state);
    throw new Error(`Paid request failed with HTTP ${response.status}`);
  }

  const settlement = JSON.parse(Buffer.from(paymentResponseHeader, "base64").toString("utf8"));
  if (
    settlement.success !== true ||
    settlement.network !== config.network ||
    normalizeAddress(settlement.payer) !== normalizeAddress(config.payerAddress) ||
    !/^0x[0-9a-fA-F]{64}$/.test(settlement.transaction || "")
  ) {
    throw new Error("The paid response did not contain the expected successful settlement");
  }

  const receipt = await waitForReceipt(settlement.transaction, config);
  if (receipt.status !== "0x1") throw new Error("The settlement transaction reverted");
  const transferLog = receipt.logs?.find(log =>
    isExpectedTransferLog(
      log,
      config.payerAddress,
      config.fundingAddress,
      config.amountAtomic,
      config.usdcAddress,
    ),
  );
  if (!transferLog) throw new Error("The settlement receipt lacks the authorized USDC transfer");

  const proof = {
    status: "completed",
    completedAt: new Date().toISOString(),
    network: config.network,
    asset: config.usdcAddress,
    amountAtomic: config.amountAtomic.toString(),
    amountUsdc: "2.000000",
    fundingAddress: config.fundingAddress,
    payerAddress: config.payerAddress,
    endpoint: config.endpoint,
    sourceTransfer: state.sourceTransfer,
    settlement: {
      transactionHash: settlement.transaction,
      blockNumber: Number(BigInt(receipt.blockNumber)),
      payer: settlement.payer,
    },
    response: {
      httpStatus: response.status,
      bodySha256: createHash("sha256").update(responseText).digest("hex"),
    },
  };
  await writePrivateJson(config.statePath, proof);
  return { event: "x402-trigger", ...proof };
}

export async function runConditionalPayment(config = CONFIG) {
  const lock = await acquireLock(config.statePath);
  if (!lock) return { event: "x402-trigger", status: "locked" };

  try {
    let state = (await readJson(config.statePath)) || {};
    if (state.status === "completed") {
      return { event: "x402-trigger", ...state, alreadyCompleted: true };
    }

    const latestBlock = BigInt(await rpc("eth_blockNumber", [], config));
    const confirmedBlock = latestBlock - config.confirmations + 1n;
    if (confirmedBlock < 0n) {
      return { event: "x402-trigger", status: "waiting", latestBlock: Number(latestBlock) };
    }

    if (!state.startedAtBlock) {
      state = {
        status: "waiting",
        createdAt: new Date().toISOString(),
        startedAtBlock: Number(latestBlock > 20n ? latestBlock - 20n : 0n),
      };
      await writePrivateJson(config.statePath, state);
    }

    if (!state.sourceTransfer) {
      const fromBlock = BigInt(state.nextBlock ?? state.startedAtBlock);
      const logs = await getTransferLogs(
        fromBlock,
        confirmedBlock,
        config.fundingAddress,
        config.payerAddress,
        config,
      );
      const matching = logs.find(log =>
        isExpectedTransferLog(
          log,
          config.fundingAddress,
          config.payerAddress,
          config.amountAtomic,
          config.usdcAddress,
        ),
      );
      if (!matching) {
        state.nextBlock = Number(confirmedBlock + 1n);
        state.lastCheckedAt = new Date().toISOString();
        await writePrivateJson(config.statePath, state);
        return {
          event: "x402-trigger",
          status: "waiting",
          confirmedThroughBlock: Number(confirmedBlock),
        };
      }
      state.sourceTransfer = publicLog(matching);
      state.status = "funding_confirmed";
      await writePrivateJson(config.statePath, state);
    }

    const outgoing = await findOutgoingSettlement(state.sourceTransfer, confirmedBlock, config);
    if (outgoing) {
      const recovered = {
        status: "completed",
        completedAt: new Date().toISOString(),
        network: config.network,
        asset: config.usdcAddress,
        amountAtomic: config.amountAtomic.toString(),
        amountUsdc: "2.000000",
        fundingAddress: config.fundingAddress,
        payerAddress: config.payerAddress,
        endpoint: config.endpoint,
        sourceTransfer: state.sourceTransfer,
        settlement: publicLog(outgoing),
        recoveredFromChain: true,
      };
      await writePrivateJson(config.statePath, recovered);
      return { event: "x402-trigger", ...recovered };
    }

    const balance = await getUsdcBalance(config.payerAddress, config);
    if (balance < config.amountAtomic) {
      state.status = "funding_spent_or_missing";
      state.observedBalanceAtomic = balance.toString();
      await writePrivateJson(config.statePath, state);
      throw new Error("The authorized funding transfer exists, but the payer balance is below 2 USDC");
    }

    return executeAuthorizedPayment(state, config);
  } finally {
    await releaseLock(lock);
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  try {
    console.log(JSON.stringify(await runConditionalPayment()));
  } catch (error) {
    console.error(
      JSON.stringify({ event: "x402-trigger", status: "error", error: error.message }),
    );
    process.exitCode = 1;
  }
}
