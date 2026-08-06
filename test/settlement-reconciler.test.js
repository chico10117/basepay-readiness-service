import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acknowledgeSettlement,
  getSettlementJournalStats,
  journalSettlement,
  reconcileSettlementJournal,
} from "../src/settlement-reconciler.js";

const settlement = {
  orderId: "quick-test-order",
  transaction: `0x${"1".repeat(64)}`,
  payerAddress: "0x0000000000000000000000000000000000000001",
  network: "eip155:8453",
  amountAtomic: "50000000",
  payTo: "0x820a7bf90d944bb26bfd9b62ab172fc3a0829cb9",
};

test("journals only the public settlement proof with private file permissions", async t => {
  const directory = await temporaryJournal(t);
  const secret = "payment-authorization-must-not-be-stored";
  const created = await journalSettlement(
    { ...settlement, paymentPayload: { authorization: secret } },
    { directory, now: new Date("2026-08-05T12:00:00.000Z") },
  );

  assert.equal(created.created, true);
  const files = await readdir(directory);
  assert.equal(files.length, 1);
  assert.equal(files[0].includes(settlement.orderId), false);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(directory, files[0]))).mode & 0o777, 0o600);

  const raw = await readFile(join(directory, files[0]), "utf8");
  assert.equal(raw.includes(secret), false);
  const entry = JSON.parse(raw);
  assert.equal(entry.orderId, settlement.orderId);
  assert.equal(entry.transaction, settlement.transaction);
  assert.equal(entry.paymentPayload, undefined);

  const duplicate = await journalSettlement(settlement, { directory });
  assert.equal(duplicate.created, false);
  assert.equal((await readdir(directory)).length, 1);
  assert.deepEqual(await getSettlementJournalStats({ directory }), {
    configured: true,
    available: true,
    pending: 1,
    invalid: 0,
    attempts: 0,
    oldest_recorded_at: "2026-08-05T12:00:00.000Z",
    next_attempt_at: "2026-08-05T12:00:00.000Z",
  });

  assert.equal(await acknowledgeSettlement(settlement, { directory }), true);
  assert.equal((await getSettlementJournalStats({ directory })).pending, 0);
});

test("rejects a second transaction for the same order", async t => {
  const directory = await temporaryJournal(t);
  await journalSettlement(settlement, { directory });

  await assert.rejects(
    () =>
      journalSettlement(
        { ...settlement, transaction: `0x${"2".repeat(64)}` },
        { directory },
      ),
    /another transaction/,
  );
  assert.equal((await readdir(directory)).length, 1);
});

test("retains failed settlements and idempotently reconciles them later", async t => {
  const directory = await temporaryJournal(t);
  const now = new Date("2026-08-05T12:00:00.000Z");
  await journalSettlement(settlement, { directory, now });

  const failed = await reconcileSettlementJournal(
    async () => {
      throw new Error(
        "postgres://alice:swordfish@db.example/x token=private-token",
      );
    },
    { directory, force: true, maxBackoffMs: 1_000, now },
  );
  assert.equal(failed.failed, 1);
  assert.equal(failed.reconciled, 0);

  const [file] = await readdir(directory);
  const retryEntry = JSON.parse(await readFile(join(directory, file), "utf8"));
  assert.equal(retryEntry.attemptCount, 1);
  assert.equal(retryEntry.lastAttemptAt, now.toISOString());
  assert.ok(Date.parse(retryEntry.nextAttemptAt) > now.getTime());
  assert.equal(retryEntry.lastError.includes("swordfish"), false);
  assert.equal(retryEntry.lastError.includes("private-token"), false);
  assert.match(retryEntry.lastError, /postgres:\/\/\[redacted\]@/);
  assert.match(retryEntry.lastError, /token=\[redacted\]/);

  let appliedEarly = false;
  const deferred = await reconcileSettlementJournal(
    async () => {
      appliedEarly = true;
    },
    {
      directory,
      now: new Date("2026-08-05T12:00:00.500Z"),
    },
  );
  assert.equal(deferred.deferred, 1);
  assert.equal(appliedEarly, false);

  let applied;
  const recovered = await reconcileSettlementJournal(
    async value => {
      applied = value;
    },
    { directory, force: true, now: new Date("2026-08-05T12:01:00.000Z") },
  );
  assert.equal(recovered.reconciled, 1);
  assert.equal(recovered.failed, 0);
  assert.deepEqual(applied, settlement);
  assert.equal((await getSettlementJournalStats({ directory })).pending, 0);
});

test("recovers a complete temporary record left by an interrupted publish", async t => {
  const directory = await temporaryJournal(t);
  await journalSettlement(settlement, { directory });
  const [file] = await readdir(directory);
  const interruptedPath = join(
    directory,
    `${file}.123.00000000-0000-4000-8000-000000000000.tmp`,
  );
  await rename(join(directory, file), interruptedPath);
  let applied;

  const result = await reconcileSettlementJournal(
    async value => {
      applied = value;
    },
    { directory, force: true },
  );

  assert.equal(result.reconciled, 1);
  assert.deepEqual(applied, settlement);
  assert.deepEqual(await readdir(directory), []);
});

test("keeps malformed interrupted records visible instead of discarding them", async t => {
  const directory = await temporaryJournal(t);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const malformedName = `${"a".repeat(64)}.json.123.00000000-0000-4000-8000-000000000000.tmp`;
  await writeFile(join(directory, malformedName), "{not-json\n", { mode: 0o600 });
  let applied = false;

  const result = await reconcileSettlementJournal(
    async () => {
      applied = true;
    },
    { directory, force: true },
  );

  assert.equal(applied, false);
  assert.equal(result.scanned, 1);
  assert.equal(result.invalid, 1);
  assert.equal((await getSettlementJournalStats({ directory })).invalid, 1);
  assert.deepEqual(await readdir(directory), [malformedName]);
});

async function temporaryJournal(t) {
  const directory = await mkdtemp(join(tmpdir(), "x402-settlements-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
