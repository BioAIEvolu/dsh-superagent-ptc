import test from "node:test";
import assert from "node:assert/strict";
import { SuperAgentCore } from "../../src/core/index.ts";
import type { CoreResult, GateDecision, HardCheck, RunState, WorkItem } from "../../src/core/index.ts";
import {
  codeEvidence,
  evidence,
  expectError,
  guard,
  itemInput,
  makeCore,
  makeEmptyCore,
  mutationEscapes,
  must,
  plan,
  prepare,
  proofFor,
  report,
  running,
  state,
  submitPass
} from "./helpers.ts";

function runningSnapshot(withEvidence = false): { saved: RunState; mandateId: string } {
  const core = makeCore();
  plan(core, itemInput("a"));
  const mandate = running(core, "a");
  if (withEvidence) codeEvidence(core, "a");
  return { saved: state(core), mandateId: mandate.id };
}

function acceptedCore(): SuperAgentCore {
  const core = makeCore();
  plan(core, itemInput("a"));
  const mandate = running(core, "a");
  report(core, mandate);
  codeEvidence(core, "a");
  submitPass(core, "a");
  must(core.releaseWorkItem({ workItemId: "a", reviewerId: "reviewer", ...guard(core) }));
  return core;
}

let acceptedFixture: RunState | undefined;
function acceptedSnapshot(): RunState {
  acceptedFixture ??= state(acceptedCore());
  return structuredClone(acceptedFixture);
}

function completedSnapshot(): RunState {
  const core = acceptedCore();
  must(core.completeRun(guard(core)));
  return state(core);
}

function review(core: SuperAgentCore, result: "pass" | "unknown", evidenceIds?: string[]): CoreResult<GateDecision> {
  const item = state(core).workItems.a;
  return core.submitReview({
    workItemId: "a", mandateId: item.currentMandateId ?? "", attempt: item.attempt,
    reviewerId: "reviewer", result, evidenceIds: evidenceIds ?? [], ...guard(core)
  });
}

function release(core: SuperAgentCore): CoreResult<WorkItem> {
  return core.releaseWorkItem({ workItemId: "a", reviewerId: "reviewer", ...guard(core) });
}

function finishRecoveredAttempt(core: SuperAgentCore, expectedAttempt = 2): void {
  const mandate = prepare(core, "a");
  assert.equal(mandate.attempt, expectedAttempt);
  assert.equal(mandate.generation, state(core).run.generation);
  must(core.bindExecution({ mandateId: mandate.id, nativeTaskId: "native-a-2", workerAgentId: "agent-worker", ...guard(core) }));
  report(core, mandate);
  codeEvidence(core, "a");
  submitPass(core, "a");
  assert.equal(must(release(core)).status, "accepted");
  assert.equal(must(core.completeRun(guard(core))).status, "completed");
}

test("R1 receipt-less unknown recovery supports explicit replan and a new generation attempt", () => {
  const { saved } = runningSnapshot();
  const restored = makeEmptyCore();
  must(restored.restoreSnapshot(saved, [], proofFor(saved)));
  assert.equal(state(restored).workItems.a.status, "verifying");
  expectError(review(restored, "unknown"), "STALE_GENERATION");
  mutationEscapes("generation", "STALE_GENERATION", () => {
    const mutant = makeEmptyCore(["generation", "reviewState"]);
    must(mutant.restoreSnapshot(saved, [], proofFor(saved)));
    return review(mutant, "unknown");
  });
  plan(restored, itemInput("a"));
  assert.equal(state(restored).workItems.a.status, "ready");
  assert.equal(state(restored).workItems.a.currentMandateId, undefined);
  finishRecoveredAttempt(restored);
});

test("R2 native reported_done receipt authorizes new-generation review but old evidence stays stale", () => {
  const { saved, mandateId } = runningSnapshot(true);
  const setup = (disabledChecks: HardCheck[] = []) => {
    const restored = makeEmptyCore(disabledChecks);
    must(restored.restoreSnapshot(saved, [{ mandateId, status: "reported_done" }], proofFor(saved)));
    return restored;
  };
  const restored = setup();
  const item = state(restored).workItems.a;
  const mandate = state(restored).mandates[item.currentMandateId ?? ""];
  assert.equal(mandate.status, "reported_done");
  assert.equal(mandate.generation, state(restored).run.generation);
  const oldEvidenceIds = Object.keys(saved.evidence);
  expectError(review(restored, "pass", oldEvidenceIds), "EVIDENCE_MISSING");
  mutationEscapes("evidenceFreshness", "EVIDENCE_MISSING", () => {
    const mutant = setup(["evidenceFreshness", "evidence"]);
    return review(mutant, "pass", oldEvidenceIds);
  });
  const freshEvidence = codeEvidence(restored, "a").map(entry => entry.id);
  must(review(restored, "pass", freshEvidence));
  assert.equal(must(release(restored)).status, "accepted");
  assert.equal(must(restored.completeRun(guard(restored))).status, "completed");
});

test("R2b native-done recovery snapshot remains valid on a second restore and can replan", () => {
  const { saved, mandateId } = runningSnapshot(true);
  const first = makeEmptyCore();
  must(first.restoreSnapshot(saved, [{ mandateId, status: "reported_done" }], proofFor(saved)));
  const recovered = state(first);
  const historical = recovered.mandates[mandateId];
  assert.equal(historical.generation, 1);
  assert.ok(Object.values(recovered.evidence).every(entry => entry.generation === 1 && entry.mandateId === mandateId));
  const current = recovered.mandates[recovered.workItems.a.currentMandateId ?? ""];
  assert.notEqual(current.id, mandateId);
  assert.equal(current.generation, 2);
  assert.equal(current.attempt, 2);

  const second = makeEmptyCore();
  must(second.restoreSnapshot(recovered, [], proofFor(recovered)));
  assert.equal(state(second).run.generation, 3);
  assert.equal(state(second).mandates[mandateId].generation, 1);
  assert.ok(Object.values(state(second).evidence).every(entry => entry.generation === 1));
  plan(second, itemInput("a"));
  finishRecoveredAttempt(second, 3);
});

test("R3 legitimate historical accepted work remains valid and completes after restore", () => {
  const saved = acceptedSnapshot();
  const restored = makeEmptyCore();
  must(restored.restoreSnapshot(saved, [], proofFor(saved)));
  assert.equal(state(restored).workItems.a.status, "accepted");
  assert.equal(state(restored).run.status, "active");
  const completed = must(restored.completeRun(guard(restored)));
  assert.equal(completed.status, "completed");
  assert.equal(state(restored).audit.at(-1)?.type, "run.completed");
});

test("R3b historical accepted work also has an explicit reverify path", () => {
  const restored = makeEmptyCore();
  must(restored.restoreSnapshot(acceptedSnapshot(), [], proofFor(acceptedSnapshot())));
  plan(restored, itemInput("a"));
  assert.equal(state(restored).workItems.a.status, "ready");
  finishRecoveredAttempt(restored);
});

test("R3c latest user rejection can revoke historical accepted work and reopen completion", () => {
  const restored = makeEmptyCore();
  must(restored.restoreSnapshot(acceptedSnapshot(), [], proofFor(acceptedSnapshot())));
  must(restored.recordUserFeedback({
    workItemId: "a", verdict: "rejected", note: "historical output is wrong", fingerprint: "historic-reject", ...guard(restored)
  }));
  assert.equal(state(restored).workItems.a.status, "rework");
  expectError(restored.completeRun(guard(restored)), "UNACCEPTED_ITEMS");
  mutationEscapes("completion", "UNACCEPTED_ITEMS", () => {
    const mutant = makeEmptyCore(["completion"]);
    must(mutant.restoreSnapshot(acceptedSnapshot(), [], proofFor(acceptedSnapshot())));
    must(mutant.recordUserFeedback({
      workItemId: "a", verdict: "rejected", note: "historical output is wrong", fingerprint: "historic-reject", ...guard(mutant)
    }));
    return mutant.completeRun(guard(mutant));
  });
});

test("R3d historical rejection can be restored again and continue with a clean attempt", () => {
  const first = makeEmptyCore();
  must(first.restoreSnapshot(acceptedSnapshot(), [], proofFor(acceptedSnapshot())));
  must(first.recordUserFeedback({
    workItemId: "a", verdict: "rejected", note: "historical output is wrong", fingerprint: "historic-reject", ...guard(first)
  }));
  const rejected = state(first);
  const mandate = rejected.mandates[rejected.workItems.a.currentMandateId ?? ""];
  const feedback = Object.values(rejected.evidence).find(entry => entry.kind === "user_feedback");
  assert.ok(feedback);
  assert.equal(feedback.generation, mandate.generation);
  const second = makeEmptyCore();
  must(second.restoreSnapshot(rejected, [], proofFor(rejected)));
  assert.equal(state(second).workItems.a.status, "rework");
  assert.equal(state(second).run.generation, rejected.run.generation + 1);
  finishRecoveredAttempt(second, 2);
});

test("SnapshotProof is required and detects coordinated state-plus-audit tampering", () => {
  const saved = acceptedSnapshot();
  expectError(makeEmptyCore().restoreSnapshot(saved), "SNAPSHOT_PROOF_REQUIRED");
  mutationEscapes("proof", "SNAPSHOT_PROOF_REQUIRED", () => makeEmptyCore(["proof"]).restoreSnapshot(saved));

  const forged = structuredClone(saved);
  forged.run.objective = "forged objective with matching diagnostic after";
  forged.audit[forged.audit.length - 1].changes.run = structuredClone(forged.run);
  const staleProof = proofFor(saved);
  expectError(makeEmptyCore().restoreSnapshot(forged, [], staleProof), "SNAPSHOT_PROOF_MISMATCH");
  mutationEscapes("proof", "SNAPSHOT_PROOF_MISMATCH", () => makeEmptyCore(["proof"]).restoreSnapshot(forged, [], staleProof));
});

test("S1-active forged waiver, met and mandatory flags are rejected by semantic provenance", () => {
  const waivedSource = makeCore([{ id: "source", kind: "coverage", text: "read full source", coverage: "unknown" }]);
  const waived = structuredClone(state(waivedSource));
  waived.obligations.source.status = "waived";
  expectError(makeEmptyCore().restoreSnapshot(waived, [], proofFor(waived)), "SNAPSHOT_INVALID");
  mutationEscapes("restore", "SNAPSHOT_INVALID", () => makeEmptyCore(["restore"]).restoreSnapshot(waived, [], proofFor(waived)));

  const metSource = makeCore([{ id: "duty", kind: "requirement", text: "verified duty" }]);
  const met = structuredClone(state(metSource));
  met.obligations.duty.status = "met";
  expectError(makeEmptyCore().restoreSnapshot(met, [], proofFor(met)), "SNAPSHOT_INVALID");
  mutationEscapes("restore", "SNAPSHOT_INVALID", () => makeEmptyCore(["restore"]).restoreSnapshot(met, [], proofFor(met)));

  const mandatory = structuredClone(acceptedSnapshot());
  mandatory.workItems.a.mandatory = false;
  expectError(makeEmptyCore().restoreSnapshot(mandatory, [], proofFor(mandatory)), "SNAPSHOT_INVALID");
  mutationEscapes("restore", "SNAPSHOT_INVALID", () => makeEmptyCore(["restore"]).restoreSnapshot(mandatory, [], proofFor(mandatory)));
});

test("S1 forged completed snapshot without evidence or run.completed is rejected atomically", () => {
  const forged = structuredClone(acceptedSnapshot());
  forged.evidence = {};
  for (const obligation of Object.values(forged.obligations)) obligation.evidenceIds = [];
  for (const decision of Object.values(forged.decisions)) decision.evidenceIds = [];
  forged.run.status = "completed";
  const restored = makeEmptyCore();
  expectError(restored.restoreSnapshot(forged, [], proofFor(forged)), "SNAPSHOT_INVALID");
  assert.equal(restored.snapshot(), null);
  mutationEscapes("restore", "SNAPSHOT_INVALID", () => {
    const mutant = makeEmptyCore(["restore"]);
    return mutant.restoreSnapshot(forged, [], proofFor(forged));
  });
});

test("S1-completed-audit accepted evidence alone cannot forge completed without final run.completed", () => {
  const forged = structuredClone(acceptedSnapshot());
  forged.run.status = "completed";
  expectError(makeEmptyCore().restoreSnapshot(forged, [], proofFor(forged)), "SNAPSHOT_INVALID");
  mutationEscapes("restore", "SNAPSHOT_INVALID", () => makeEmptyCore(["restore"]).restoreSnapshot(forged, [], proofFor(forged)));
});

test("S1-gate-evidence completed audit cannot compensate for missing build evidence", () => {
  const forged = structuredClone(acceptedSnapshot());
  const build = Object.values(forged.evidence).find(entry => entry.kind === "build");
  assert.ok(build);
  delete forged.evidence[build.id];
  for (const obligation of Object.values(forged.obligations)) {
    obligation.evidenceIds = obligation.evidenceIds.filter(id => id !== build.id);
  }
  for (const decision of Object.values(forged.decisions)) {
    decision.evidenceIds = decision.evidenceIds.filter(id => id !== build.id);
  }
  forged.run.status = "completed";
  forged.run.revision += 1;
  forged.audit.push({
    id: "audit-forged-completion", runId: forged.run.id, revision: forged.run.revision,
    generation: forged.run.generation, type: "run.completed", payload: {},
    changes: { run: structuredClone(forged.run) }, actor: "lead", timestamp: forged.run.updatedAt
  });
  expectError(makeEmptyCore().restoreSnapshot(forged, [], proofFor(forged)), "SNAPSHOT_INVALID");
  mutationEscapes("restore", "SNAPSHOT_INVALID", () => makeEmptyCore(["restore"]).restoreSnapshot(forged, [], proofFor(forged)));
});

test("S1-worker-chain accepted snapshot without worker-done audit is rejected", () => {
  const forged = structuredClone(acceptedSnapshot());
  const workerDone = forged.audit.find(event => event.type === "worker.reported_done");
  assert.ok(workerDone);
  workerDone.type = "worker.unverified_note";
  expectError(makeEmptyCore().restoreSnapshot(forged, [], proofFor(forged)), "SNAPSHOT_INVALID");
  mutationEscapes("restore", "SNAPSHOT_INVALID", () => makeEmptyCore(["restore"]).restoreSnapshot(forged, [], proofFor(forged)));
});

test("S1-decision-chain accepted snapshot without a valid pass decision is rejected", () => {
  const forged = structuredClone(acceptedSnapshot());
  for (const decision of Object.values(forged.decisions)) decision.invalidated = true;
  expectError(makeEmptyCore().restoreSnapshot(forged, [], proofFor(forged)), "SNAPSHOT_INVALID");
  mutationEscapes("restore", "SNAPSHOT_INVALID", () => makeEmptyCore(["restore"]).restoreSnapshot(forged, [], proofFor(forged)));
});

test("S1-coverage forged full-to-partial coverage cannot restore as accepted", () => {
  const core = makeCore([{ id: "source", kind: "coverage", text: "full source", sourceId: "repo", coverage: "unknown" }]);
  plan(core, itemInput("a", { gateProfile: "coverage", obligationIds: ["source"] }));
  const mandate = running(core, "a");
  report(core, mandate);
  evidence(core, "a", {
    kind: "coverage", sourceActor: "host", sourceRole: "host",
    receipt: { obligationId: "source", sourceId: "repo", coverage: "full" }
  });
  submitPass(core, "a");
  must(release(core));
  const forged = structuredClone(state(core));
  const coverage = Object.values(forged.evidence).find(entry => entry.kind === "coverage");
  assert.ok(coverage);
  coverage.receipt.coverage = "partial";
  expectError(makeEmptyCore().restoreSnapshot(forged, [], proofFor(forged)), "SNAPSHOT_INVALID");
  mutationEscapes("restore", "SNAPSHOT_INVALID", () => makeEmptyCore(["restore"]).restoreSnapshot(forged, [], proofFor(forged)));
});

test("S1-positive legitimate completed snapshot reopens final acceptance and never restores directly completed", () => {
  const saved = completedSnapshot();
  const restored = makeEmptyCore();
  must(restored.restoreSnapshot(saved, [], proofFor(saved)));
  assert.equal(state(restored).run.status, "active");
  assert.notEqual(state(restored).run.status, "completed");
  assert.equal(must(restored.completeRun(guard(restored))).status, "completed");
  assert.equal(state(restored).audit.filter(event => event.type === "run.completed").length, 2);
});
