import test from "node:test";
import assert from "node:assert/strict";
import { SuperAgentCore, type CoreResult, type WriteGuard } from "../../src/core/index.ts";
import { HostError } from "../../src/host/errors.ts";
import { RunRepository } from "../../src/host/store.ts";
import { createInput, drivers, MemoryProofStore, MemoryTable } from "./helpers.ts";

async function mutate<T>(repo: RunRepository, operation: (core: SuperAgentCore, guard: WriteGuard) => CoreResult<T>) {
  return repo.transact("root-recovery", core => operation(core, {
    expectedRevision: core.snapshot()!.run.revision,
    expectedGeneration: core.snapshot()!.run.generation,
  }));
}

async function runningScenario() {
  const table = new MemoryTable();
  const proofs = new MemoryProofStore();
  const driver = drivers();
  const repo = new RunRepository(table, driver, undefined, proofs);
  await repo.create("root-recovery", createInput("root-recovery"));
  await mutate(repo, (core, guard) => core.planWorkItems({
    ...guard, items: [{ id: "item", title: "Recoverable work", dependencies: [], writeScopes: [], acceptance: ["proof"], obligationIds: [], gateProfile: "code" }],
  }));
  const prepared = await mutate(repo, (core, guard) => core.prepareMandate({
    ...guard, workItemId: "item", workerId: "worker-native", reviewerId: "reviewer-native", knownFailures: [],
  }));
  assert.ok(prepared.ok);
  await mutate(repo, (core, guard) => core.bindExecution({
    ...guard, mandateId: prepared.value.id, workerAgentId: "worker-native",
  }));
  const evidence = await mutate(repo, (core, guard) => core.recordEvidence({
    ...guard, workItemId: "item", mandateId: prepared.value.id, attempt: 1, kind: "build", result: "pass",
    sourceActor: "host", sourceRole: "host", receipt: { hostObserved: true, exitCode: 0 }, summary: "native build receipt",
  }));
  assert.ok(evidence.ok);
  return { table, proofs, driver, mandateId: prepared.value.id };
}

test("R2 native reported_done survives two Host restores with new recovery Mandate and immutable evidence", async () => {
  const scenario = await runningScenario();
  const firstRepo = new RunRepository(scenario.table, scenario.driver, async () => [
    { mandateId: scenario.mandateId, status: "reported_done" },
  ], scenario.proofs);
  const first = await mutate(firstRepo, (core, guard) => core.pauseRun(guard));
  assert.ok(first.ok);
  assert.equal(first.state.run.generation, 2);
  const firstItem = first.state.workItems.item!;
  assert.notEqual(firstItem.currentMandateId, scenario.mandateId);
  const recoveryMandate = first.state.mandates[firstItem.currentMandateId!]!;
  assert.equal(recoveryMandate.generation, 2);
  assert.equal(first.state.mandates[scenario.mandateId]?.generation, 1);
  assert.ok(Object.values(first.state.evidence).every(item => item.generation === 1));

  const secondRepo = new RunRepository(scenario.table, scenario.driver, undefined, scenario.proofs);
  const second = await mutate(secondRepo, (core, guard) => core.pauseRun(guard));
  assert.ok(second.ok);
  assert.equal(second.state.run.generation, 3);
  assert.equal(second.state.audit.filter(event => event.type === "run.recovered").length, 2);
  assert.ok(Object.values(second.state.evidence).every(item => item.generation === 1));
  assert.equal(second.state.mandates[scenario.mandateId]?.generation, 1);
});

async function rejectedAcceptedScenario() {
  const table = new MemoryTable();
  const proofs = new MemoryProofStore();
  const driver = drivers();
  const repo = new RunRepository(table, driver, undefined, proofs);
  await repo.create("root-recovery", createInput("root-recovery"));
  await mutate(repo, (core, guard) => core.planWorkItems({
    ...guard, items: [{ id: "item", title: "Accepted work", dependencies: [], writeScopes: [], acceptance: ["proof"], obligationIds: [], gateProfile: "code" }],
  }));
  const prepared = await mutate(repo, (core, guard) => core.prepareMandate({
    ...guard, workItemId: "item", workerId: "worker-native", reviewerId: "reviewer-native", knownFailures: [],
  }));
  assert.ok(prepared.ok);
  await mutate(repo, (core, guard) => core.bindExecution({ ...guard, mandateId: prepared.value.id, workerAgentId: "worker-native" }));
  await mutate(repo, (core, guard) => core.reportWorkerDone({ ...guard, mandateId: prepared.value.id, workerId: "worker-native", summary: "done" }));
  const build = await mutate(repo, (core, guard) => core.recordEvidence({
    ...guard, workItemId: "item", mandateId: prepared.value.id, attempt: 1, kind: "build", result: "pass",
    sourceActor: "reviewer-native", sourceRole: "reviewer", receipt: { exitCode: 0 }, summary: "build pass",
  }));
  assert.ok(build.ok);
  const unit = await mutate(repo, (core, guard) => core.recordEvidence({
    ...guard, workItemId: "item", mandateId: prepared.value.id, attempt: 1, kind: "unit", result: "pass",
    sourceActor: "reviewer-native", sourceRole: "reviewer", receipt: { passed: 1, failed: 0, total: 1 }, summary: "unit pass",
  }));
  assert.ok(unit.ok);
  const review = await mutate(repo, (core, guard) => core.submitReview({
    ...guard, workItemId: "item", mandateId: prepared.value.id, attempt: 1, reviewerId: "reviewer-native",
    result: "pass", evidenceIds: [build.value.id, unit.value.id],
  }));
  assert.ok(review.ok);
  await mutate(repo, (core, guard) => core.releaseWorkItem({ ...guard, workItemId: "item", reviewerId: "reviewer-native" }));
  const rejected = await mutate(repo, (core, guard) => core.recordUserFeedback({
    ...guard, workItemId: "item", verdict: "rejected", note: "user rejects historical result", fingerprint: "history-reject",
  }));
  assert.ok(rejected.ok);
  return { table, proofs, driver, mandateId: prepared.value.id };
}

test("R3c rejected historical acceptance survives two restores with feedback bound to original Mandate generation", async () => {
  const scenario = await rejectedAcceptedScenario();
  const originalGeneration = scenario.table.records.get("root-recovery")!.state.mandates[scenario.mandateId]!.generation;
  const firstRepo = new RunRepository(scenario.table, scenario.driver, undefined, scenario.proofs);
  const first = await mutate(firstRepo, (core, guard) => core.pauseRun(guard));
  assert.ok(first.ok);
  assert.equal(first.state.run.generation, 2);
  const feedback = Object.values(first.state.evidence).find(item => item.kind === "user_feedback");
  assert.equal(feedback?.generation, originalGeneration);
  assert.equal(feedback?.mandateId, scenario.mandateId);

  const secondRepo = new RunRepository(scenario.table, scenario.driver, undefined, scenario.proofs);
  const second = await mutate(secondRepo, (core, guard) => core.pauseRun(guard));
  assert.ok(second.ok);
  assert.equal(second.state.run.generation, 3);
  assert.equal(second.state.audit.filter(event => event.type === "run.recovered").length, 2);
  assert.equal(Object.values(second.state.evidence).find(item => item.kind === "user_feedback")?.generation, originalGeneration);
});

test("missing proof and coordinated state+audit tampering refuse restore without storage mutation", async () => {
  const table = new MemoryTable();
  const proofs = new MemoryProofStore();
  const repo = new RunRepository(table, drivers(), undefined, proofs);
  await repo.create("root-recovery", createInput("root-recovery"));
  const original = repo.read("root-recovery")!;
  proofs.events.delete("root-recovery");
  const missingRepo = new RunRepository(table, drivers(), undefined, proofs);
  await assert.rejects(missingRepo.transact("root-recovery", core => core.pauseRun({ expectedRevision: 1, expectedGeneration: 1 })),
    (error: unknown) => error instanceof HostError && error.code === "SNAPSHOT_PROOF_REQUIRED");
  assert.deepEqual(repo.read("root-recovery"), original);

  const validProofs = new MemoryProofStore();
  const tamperedTable = new MemoryTable();
  const validRepo = new RunRepository(tamperedTable, drivers(), undefined, validProofs);
  await validRepo.create("root-recovery", createInput("root-recovery"));
  const record = tamperedTable.records.get("root-recovery")!;
  record.state.run.objective = "coordinated tamper";
  record.state.audit[0]!.payload.objective = "coordinated tamper";
  record.state.audit[0]!.changes.run!.objective = "coordinated tamper";
  tamperedTable.records.set("root-recovery", record);
  const tamperedRepo = new RunRepository(tamperedTable, drivers(), undefined, validProofs);
  await assert.rejects(tamperedRepo.transact("root-recovery", core => core.pauseRun({ expectedRevision: 1, expectedGeneration: 1 })),
    (error: unknown) => error instanceof HostError && error.code === "SNAPSHOT_PROOF_MISMATCH");
  assert.equal(tamperedTable.records.get("root-recovery")!.state.run.objective, "coordinated tamper");
});

test("proof persistence failure advances neither storage nor live core", async () => {
  const table = new MemoryTable();
  const proofs = new MemoryProofStore();
  proofs.failNextAppend = true;
  const repo = new RunRepository(table, drivers(), undefined, proofs);
  await assert.rejects(repo.create("root-recovery", createInput("root-recovery")),
    (error: unknown) => error instanceof HostError && error.code === "SNAPSHOT_PROOF_PERSISTENCE_UNCONFIRMED");
  assert.equal(table.records.size, 0);
  assert.equal(repo.hasLiveCore("root-recovery"), false);
});
