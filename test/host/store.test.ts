import test from "node:test";
import assert from "node:assert/strict";
import { RunRepository } from "../../src/host/store.ts";
import { HostError } from "../../src/host/errors.ts";
import { createInput, drivers, MemoryTable, MemoryProofStore } from "./helpers.ts";

test("repository isolates two native root sessions and enforces CAS", async () => {
  const table = new MemoryTable();
  const repo = new RunRepository(table, drivers(), undefined, new MemoryProofStore());
  const a = await repo.create("root-a", createInput("ignored"));
  const b = await repo.create("root-b", createInput("ignored"));
  assert.ok(a.ok && b.ok);
  assert.equal(a.state.run.sessionId, "root-a");
  assert.equal(b.state.run.sessionId, "root-b");
  assert.notEqual(a.state.run.id, b.state.run.id);
  const before = repo.read("root-a")!;
  const stale = await repo.transact("root-a", core => core.pauseRun({ expectedRevision: 0, expectedGeneration: 1 }));
  assert.equal(stale.ok, false);
  assert.deepEqual(repo.read("root-a"), before);
  assert.equal(repo.read("root-b")?.run.id, b.state.run.id);
});

test("per-root writes serialize and durability precedes live-core replacement", async () => {
  const table = new MemoryTable();
  const repo = new RunRepository(table, drivers(), undefined, new MemoryProofStore());
  await repo.create("root-a", createInput("root-a"));
  const [paused, resumed] = await Promise.all([
    repo.transact("root-a", core => core.pauseRun({ expectedRevision: 1, expectedGeneration: 1 })),
    repo.transact("root-a", core => core.resumeRun({ expectedRevision: 2, expectedGeneration: 1 })),
  ]);
  assert.equal(paused.ok, true);
  assert.equal(resumed.ok, true);
  assert.equal(repo.read("root-a")?.run.status, "active");
  assert.equal(repo.read("root-a")?.run.revision, 3);
});

test("public restoreSnapshot reconciles exactly once and missing running receipt is unknown", async () => {
  const table = new MemoryTable();
  const proofs = new MemoryProofStore();
  const repo = new RunRepository(table, drivers(), undefined, proofs);
  await repo.create("root-a", createInput("root-a"));
  const planned = await repo.transact("root-a", core => core.planWorkItems({
    expectedRevision: 1, expectedGeneration: 1,
    items: [{ id: "item", title: "Work", dependencies: [], writeScopes: [], acceptance: ["verified"], obligationIds: [], gateProfile: "code" }],
  }));
  assert.ok(planned.ok);
  const prepared = await repo.transact("root-a", core => core.prepareMandate({
    expectedRevision: 2, expectedGeneration: 1, workItemId: "item", workerId: "worker-native", reviewerId: "reviewer-native", knownFailures: [],
  }));
  assert.ok(prepared.ok);
  const bound = await repo.transact("root-a", core => core.bindExecution({
    expectedRevision: 3, expectedGeneration: 1, mandateId: prepared.value.id, workerAgentId: "worker-native",
  }));
  assert.ok(bound.ok);

  const restoredRepo = new RunRepository(table, drivers(), undefined, proofs);
  const result = await restoredRepo.transact("root-a", core => {
    const state = core.snapshot()!;
    return core.pauseRun({ expectedRevision: state.run.revision, expectedGeneration: state.run.generation });
  });
  assert.ok(result.ok);
  assert.equal(result.state.run.generation, 2);
  assert.equal(Object.values(result.state.mandates)[0]?.status, "unknown");
  assert.equal(result.state.audit.filter(event => event.type === "run.recovered").length, 1);
});

test("storage commit failure quarantines writes and run/session mismatch fails closed", async () => {
  const table = new MemoryTable();
  table.failNextPut = true;
  const proofs = new MemoryProofStore();
  const repo = new RunRepository(table, drivers(), undefined, proofs);
  await assert.rejects(repo.create("root-a", createInput("root-a")), (error: unknown) => error instanceof HostError && error.code === "STORAGE_COMMIT_FAILED");
  assert.equal(table.records.size, 0);
  assert.equal(repo.hasLiveCore("root-a"), false);
  assert.equal(proofs.events.get("root-a")?.length, 1, "orphan proof is not a storage success receipt");
  await assert.rejects(repo.create("root-a", createInput("root-a")), (error: unknown) => error instanceof HostError && error.code === "STORAGE_QUARANTINED");

  const good = new MemoryTable();
  const other = new RunRepository(good, drivers(), undefined, new MemoryProofStore());
  await other.create("root-b", createInput("root-b"));
  const record = good.records.get("root-b")!;
  record.state.run.sessionId = "root-c";
  good.records.set("root-b", record);
  assert.throws(() => other.read("root-b"), (error: unknown) => error instanceof HostError && error.code === "SESSION_RUN_MISMATCH");
});
