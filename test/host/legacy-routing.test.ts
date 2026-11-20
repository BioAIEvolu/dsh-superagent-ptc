import test from "node:test";
import assert from "node:assert/strict";
import { SuperAgentCore, type RunState, type SnapshotProof } from "../../src/core/index.ts";
import { snapshotDigest } from "../../src/host/digest.ts";
import { SNAPSHOT_PROOF_RECORD } from "../../src/host/proof.ts";
import { storedRunRecordSchema } from "../../src/host/schema.ts";
import { routePath } from "../../src/shared/wire.ts";
import { RunRepository } from "../../src/host/store.ts";
import { createInput, drivers, MemoryProofStore, MemoryTable } from "./helpers.ts";

function acceptedSnapshot(): RunState {
  const core = new SuperAgentCore(drivers());
  assert.ok(core.createRun(createInput("root-legacy")).ok);
  assert.ok(core.planWorkItems({
    expectedRevision: 1, expectedGeneration: 1,
    items: [{ id: "accepted-item", title: "Historical work", dependencies: [], writeScopes: [], acceptance: ["independent evidence"], obligationIds: [], gateProfile: "code" }],
  }).ok);
  const prepared = core.prepareMandate({
    expectedRevision: 2, expectedGeneration: 1, workItemId: "accepted-item",
    workerId: "worker-native", reviewerId: "reviewer-native", knownFailures: [],
  });
  assert.ok(prepared.ok);
  assert.ok(core.bindExecution({ expectedRevision: 3, expectedGeneration: 1, mandateId: prepared.value.id, workerAgentId: "worker-native" }).ok);
  assert.ok(core.reportWorkerDone({ expectedRevision: 4, expectedGeneration: 1, mandateId: prepared.value.id, workerId: "worker-native", summary: "done" }).ok);
  const build = core.recordEvidence({
    expectedRevision: 5, expectedGeneration: 1, workItemId: "accepted-item", mandateId: prepared.value.id, attempt: 1,
    kind: "build", result: "pass", sourceActor: "reviewer-native", sourceRole: "reviewer", receipt: { exitCode: 0 }, summary: "build",
  });
  assert.ok(build.ok);
  const unit = core.recordEvidence({
    expectedRevision: 6, expectedGeneration: 1, workItemId: "accepted-item", mandateId: prepared.value.id, attempt: 1,
    kind: "unit", result: "pass", sourceActor: "reviewer-native", sourceRole: "reviewer", receipt: { passed: 1, failed: 0, total: 1 }, summary: "unit",
  });
  assert.ok(unit.ok);
  assert.ok(core.submitReview({
    expectedRevision: 7, expectedGeneration: 1, workItemId: "accepted-item", mandateId: prepared.value.id, attempt: 1,
    reviewerId: "reviewer-native", result: "pass", evidenceIds: [build.value.id, unit.value.id],
  }).ok);
  assert.ok(core.releaseWorkItem({ expectedRevision: 8, expectedGeneration: 1, workItemId: "accepted-item", reviewerId: "reviewer-native" }).ok);
  return core.snapshot()!;
}

test("legacy v2 snapshot loads with safe defaults, restores with its old proof and continues without losing history", async () => {
  const current = acceptedSnapshot();
  delete (current as Partial<RunState>).routeFailures;
  const { modelPolicy: _policy, ...legacyRun } = current.run;
  const legacyAudit = current.audit.map(event => {
    if (!event.changes.run) return event;
    const { modelPolicy: _after, ...runAfter } = event.changes.run;
    return { ...event, changes: { ...event.changes, run: runAfter } };
  });
  const legacy = { ...current, run: legacyRun, audit: legacyAudit } as unknown as RunState;
  const originalMandates = structuredClone(legacy.mandates);
  const originalEvidence = structuredClone(legacy.evidence);
  const originalAudit = structuredClone(legacy.audit);
  const normalizedOriginalAudit = originalAudit.map(event => event.changes.run
    ? { ...event, changes: { ...event.changes, run: { ...event.changes.run, modelPolicy: null } } }
    : event);
  const originalProof: SnapshotProof = {
    runId: legacy.run.id,
    snapshotSha256: snapshotDigest(legacy),
    revision: legacy.run.revision,
    generation: legacy.run.generation,
    nativeEventSeq: 1,
  };
  const loaded = storedRunRecordSchema.parse({ schemaVersion: 1, state: legacy, proof: originalProof });
  assert.equal(loaded.state.schemaVersion, 2);
  assert.deepEqual(loaded.state.routeFailures, {});
  assert.equal(loaded.state.run.modelPolicy, null);
  assert.deepEqual(loaded.state.mandates, originalMandates);
  assert.deepEqual(loaded.state.evidence, originalEvidence);
  assert.deepEqual(loaded.state.audit, normalizedOriginalAudit);
  assert.deepEqual(loaded.proof, originalProof);

  const table = new MemoryTable();
  const proofs = new MemoryProofStore();
  table.records.set("root-legacy", loaded);
  proofs.events.set("root-legacy", [structuredClone(originalProof)]);
  const repo = new RunRepository(table, drivers(), undefined, proofs);
  const recovered = await repo.recover("root-legacy");
  assert.ok(recovered.ok, JSON.stringify(recovered));
  const state = repo.read("root-legacy")!;
  assert.equal(state.run.id, legacy.run.id);
  assert.equal(state.run.generation, legacy.run.generation + 1);
  assert.equal(state.run.modelPolicy, null);
  assert.deepEqual(state.routeFailures, {});
  assert.deepEqual(state.mandates, originalMandates);
  assert.deepEqual(state.evidence, originalEvidence);
  assert.deepEqual(state.audit.slice(0, originalAudit.length), normalizedOriginalAudit);
  assert.equal(state.audit.at(-1)?.type, "run.recovered");
  assert.deepEqual(proofs.events.get("root-legacy")?.[0], originalProof, "historical proof remains immutable");
  assert.equal(proofs.events.get("root-legacy")?.length, 2);
  assert.equal(proofs.events.get("root-legacy")?.[1]?.generation, state.run.generation);

  const continued = await repo.transact("root-legacy", core => core.planWorkItems({
    expectedRevision: state.run.revision, expectedGeneration: state.run.generation,
    items: [{ id: "after-recovery", title: "Continue after legacy restore", dependencies: [], writeScopes: [], acceptance: ["new evidence"], obligationIds: [], gateProfile: "code" }],
  }));
  assert.ok(continued.ok);
  assert.equal(continued.state.run.revision, state.run.revision + 1);
  assert.equal(continued.state.run.generation, state.run.generation);
  assert.equal(continued.state.workItems["after-recovery"]?.status, "ready");
  assert.equal(SNAPSHOT_PROOF_RECORD, "plugin:dsh-super-agent-mode/proof");
  assert.equal(routePath("projection"), "/api/dsh-super-agent-mode/projection");
});
