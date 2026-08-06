import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const JOURNAL_VERSION = 1;
const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_MAX_BACKOFF_MS = 300_000;
const activeRuns = new Map();

export function settlementReconcilerConfig(env = process.env) {
  const configuredDirectory = String(env.SETTLEMENT_JOURNAL_DIR ?? "").trim();
  return {
    directory: resolve(
      configuredDirectory || join(homedir(), ".x402-wallet-readiness", "settlements"),
    ),
    intervalMs: boundedInteger(
      env.SETTLEMENT_RECONCILE_INTERVAL_MS,
      DEFAULT_INTERVAL_MS,
      1_000,
      300_000,
    ),
    maxBackoffMs: boundedInteger(
      env.SETTLEMENT_RECONCILE_MAX_BACKOFF_MS,
      DEFAULT_MAX_BACKOFF_MS,
      1_000,
      3_600_000,
    ),
  };
}

export function sanitizeSettlementRecord(settlement) {
  const orderId = requiredText(settlement?.orderId, "orderId", 200);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(orderId)) {
    throw new Error("settlement orderId contains unsupported characters");
  }

  const transaction = requiredText(settlement?.transaction, "transaction", 66);
  if (!/^0x[0-9a-fA-F]{64}$/.test(transaction)) {
    throw new Error("settlement transaction must be a 32-byte EVM hash");
  }

  const payerAddress = optionalAddress(settlement?.payerAddress, "payerAddress");
  const payTo = optionalAddress(settlement?.payTo, "payTo");
  const network = optionalText(settlement?.network, 100);
  const amountAtomic = optionalText(settlement?.amountAtomic, 78);
  if (amountAtomic && !/^\d+$/.test(amountAtomic)) {
    throw new Error("settlement amountAtomic must contain only decimal digits");
  }

  return {
    orderId,
    transaction: transaction.toLowerCase(),
    payerAddress,
    network,
    amountAtomic,
    payTo,
  };
}

export async function journalSettlement(settlement, options = {}) {
  const config = resolveOptions(options);
  const normalized = sanitizeSettlementRecord(settlement);
  await ensureDirectory(config.directory);
  const path = journalPath(config.directory, normalized.orderId);
  const existing = await readEntry(path, { allowMissing: true });

  if (existing) {
    const stored = sanitizeSettlementRecord(existing);
    if (stored.transaction !== normalized.transaction) {
      throw new Error("settlement journal conflict: order already has another transaction");
    }
    return { path, entry: existing, created: false };
  }

  const entry = {
    version: JOURNAL_VERSION,
    ...normalized,
    recordedAt: nowIso(options),
    attemptCount: 0,
    nextAttemptAt: nowIso(options),
    lastAttemptAt: null,
    lastError: null,
  };
  try {
    await writeEntry(path, entry, { exclusive: true });
    return { path, entry, created: true };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const concurrentlyStored = await readEntry(path);
    if (
      sanitizeSettlementRecord(concurrentlyStored).transaction !==
      normalized.transaction
    ) {
      throw new Error(
        "settlement journal conflict: order already has another transaction",
      );
    }
    return { path, entry: concurrentlyStored, created: false };
  }
}

export async function acknowledgeSettlement(settlement, options = {}) {
  const config = resolveOptions(options);
  const normalized = sanitizeSettlementRecord(settlement);
  const path = journalPath(config.directory, normalized.orderId);
  const existing = await readEntry(path, { allowMissing: true });
  if (!existing) return false;
  if (sanitizeSettlementRecord(existing).transaction !== normalized.transaction) {
    throw new Error("refusing to acknowledge a different settlement transaction");
  }
  await unlink(path);
  return true;
}

export async function reconcileSettlementJournal(applySettlement, options = {}) {
  if (typeof applySettlement !== "function") {
    throw new Error("applySettlement callback is required");
  }
  const config = resolveOptions(options);
  const existingRun = activeRuns.get(config.directory);
  if (existingRun) return existingRun;

  const run = reconcileEntries(applySettlement, config, options).finally(() => {
    activeRuns.delete(config.directory);
  });
  activeRuns.set(config.directory, run);
  return run;
}

export function startSettlementReconciler({ applySettlement, logger = console, ...options }) {
  if (typeof applySettlement !== "function") {
    throw new Error("applySettlement callback is required");
  }
  const config = resolveOptions(options);
  let stopped = false;
  let running = false;
  let timer;

  const run = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const result = await reconcileSettlementJournal(applySettlement, {
        ...options,
        directory: config.directory,
        maxBackoffMs: config.maxBackoffMs,
      });
      if (result.reconciled > 0) {
        logger.log(
          JSON.stringify({ event: "settlement.reconciled", ...publicResult(result) }),
        );
      }
      if (result.failed > 0 || result.invalid > 0) {
        logger.error(
          JSON.stringify({ event: "settlement.reconciliation_pending", ...publicResult(result) }),
        );
      }
    } catch (error) {
      logger.error(
        JSON.stringify({
          event: "settlement.reconciler_error",
          error: safeErrorMessage(error),
        }),
      );
    } finally {
      running = false;
    }
  };

  void run();
  timer = setInterval(() => void run(), config.intervalMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export async function getSettlementJournalStats(options = {}) {
  const config = resolveOptions(options);
  const files = await journalFiles(config.directory);
  let pending = 0;
  let invalid = 0;
  let attempts = 0;
  let oldestRecordedAt = null;
  let nextAttemptAt = null;

  for (const path of files) {
    try {
      const entry = await readEntry(path);
      validateJournalEntry(entry);
      pending += 1;
      attempts += Number(entry.attemptCount || 0);
      oldestRecordedAt = earlierIso(oldestRecordedAt, entry.recordedAt);
      nextAttemptAt = earlierIso(nextAttemptAt, entry.nextAttemptAt);
    } catch {
      invalid += 1;
    }
  }

  return {
    configured: true,
    available: true,
    pending,
    invalid,
    attempts,
    oldest_recorded_at: oldestRecordedAt,
    next_attempt_at: nextAttemptAt,
  };
}

async function reconcileEntries(applySettlement, config, options) {
  const files = await journalFiles(config.directory);
  const result = {
    scanned: files.length,
    reconciled: 0,
    failed: 0,
    invalid: 0,
    deferred: 0,
  };
  const now = nowMillis(options);

  for (const path of files.slice(0, config.maxEntries)) {
    let entry;
    try {
      entry = await readEntry(path);
      validateJournalEntry(entry);
    } catch (error) {
      result.invalid += 1;
      options.logger?.error?.(
        JSON.stringify({
          event: "settlement.journal_invalid",
          file: path.split("/").pop(),
          error: safeErrorMessage(error),
        }),
      );
      continue;
    }

    const dueAt = Date.parse(entry.nextAttemptAt);
    if (!options.force && Number.isFinite(dueAt) && dueAt > now) {
      result.deferred += 1;
      continue;
    }

    try {
      await applySettlement(sanitizeSettlementRecord(entry));
      await unlink(path).catch(error => {
        if (error?.code !== "ENOENT") throw error;
      });
      result.reconciled += 1;
    } catch (error) {
      const attemptCount = Number(entry.attemptCount || 0) + 1;
      const delay = retryDelay(attemptCount, config.maxBackoffMs, entry.orderId);
      await writeEntry(path, {
        ...entry,
        attemptCount,
        lastAttemptAt: new Date(now).toISOString(),
        nextAttemptAt: new Date(now + delay).toISOString(),
        lastError: safeErrorMessage(error),
      });
      result.failed += 1;
    }
  }

  return result;
}

function validateJournalEntry(entry) {
  if (entry?.version !== JOURNAL_VERSION) {
    throw new Error("unsupported settlement journal version");
  }
  sanitizeSettlementRecord(entry);
  if (!Number.isInteger(entry.attemptCount) || entry.attemptCount < 0) {
    throw new Error("invalid settlement journal attemptCount");
  }
  if (!Number.isFinite(Date.parse(entry.recordedAt))) {
    throw new Error("invalid settlement journal recordedAt");
  }
  if (!Number.isFinite(Date.parse(entry.nextAttemptAt))) {
    throw new Error("invalid settlement journal nextAttemptAt");
  }
}

async function journalFiles(directory) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter(entry => entry.isFile() && isJournalFile(entry.name))
      .map(entry => join(directory, entry.name))
      .sort();
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function isJournalFile(name) {
  return (
    /^[a-f0-9]{64}\.json$/.test(name) ||
    /^[a-f0-9]{64}\.json\.\d+\.[a-f0-9-]{36}\.tmp$/.test(name)
  );
}

async function readEntry(path, { allowMissing = false } = {}) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return null;
    throw error;
  }
}

async function ensureDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

async function writeEntry(path, entry, { exclusive = false } = {}) {
  const directory = dirname(path);
  await ensureDirectory(directory);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  let published = false;
  try {
    await handle.writeFile(`${JSON.stringify(entry, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    if (exclusive) {
      await link(temporaryPath, path);
      await unlink(temporaryPath);
    } else {
      await rename(temporaryPath, path);
    }
    published = true;
    await chmod(path, 0o600);
    await syncDirectory(directory);
  } finally {
    if (!published) {
      await unlink(temporaryPath).catch(error => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
  }
}

async function syncDirectory(directory) {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function journalPath(directory, orderId) {
  return join(directory, `${createHash("sha256").update(orderId).digest("hex")}.json`);
}

function resolveOptions(options) {
  const envConfig = settlementReconcilerConfig(options.env ?? process.env);
  return {
    directory: resolve(options.directory || envConfig.directory),
    intervalMs: boundedInteger(
      options.intervalMs,
      envConfig.intervalMs,
      1_000,
      300_000,
    ),
    maxBackoffMs: boundedInteger(
      options.maxBackoffMs,
      envConfig.maxBackoffMs,
      1_000,
      3_600_000,
    ),
    maxEntries: boundedInteger(options.maxEntries, 100, 1, 10_000),
  };
}

function retryDelay(attemptCount, maxBackoffMs, orderId) {
  const exponential = Math.min(maxBackoffMs, 1_000 * 2 ** Math.min(attemptCount - 1, 12));
  const jitter = Number.parseInt(createHash("sha256").update(orderId).digest("hex").slice(0, 4), 16) % 1_000;
  return Math.min(maxBackoffMs, exponential + jitter);
}

function requiredText(value, name, maxLength) {
  const normalized = optionalText(value, maxLength);
  if (!normalized) throw new Error(`settlement ${name} is required`);
  return normalized;
}

function optionalText(value, maxLength) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  if (normalized.length > maxLength) throw new Error("settlement field is too long");
  return normalized;
}

function optionalAddress(value, name) {
  const normalized = optionalText(value, 42);
  if (!normalized) return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(normalized)) {
    throw new Error(`settlement ${name} must be an EVM address`);
  }
  return normalized.toLowerCase();
}

function safeErrorMessage(error) {
  return String(error?.message || "settlement reconciliation failed")
    .replace(/\b(postgres(?:ql)?|https?):\/\/[^\s/@:]+:[^\s/@]+@/gi, "$1://[redacted]@")
    .replace(/\b(password|token|secret|api[-_ ]?key)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .slice(0, 1_000);
}

function nowMillis(options) {
  const value = options.now instanceof Date
    ? options.now.getTime()
    : Number(options.now ?? Date.now());
  if (!Number.isFinite(value)) throw new Error("invalid settlement journal clock");
  return value;
}

function nowIso(options) {
  return new Date(nowMillis(options)).toISOString();
}

function earlierIso(current, candidate) {
  if (!candidate) return current;
  if (!current) return candidate;
  return Date.parse(candidate) < Date.parse(current) ? candidate : current;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(number)));
}

function publicResult(result) {
  return {
    scanned: result.scanned,
    reconciled: result.reconciled,
    failed: result.failed,
    invalid: result.invalid,
    deferred: result.deferred,
  };
}
