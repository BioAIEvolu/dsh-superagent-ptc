import test from "node:test";
import assert from "node:assert/strict";
import { SuperAgentCore } from "../../src/core/index.ts";
import type { CoreResult, GateDecision, HardCheck, Mandate, RunState, WorkItem } from "../../src/core/index.ts";
import {
  allCurrentEvidenceIds,
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
  proofFor,
  report,
  running,
  state,
  submitPass
} from "./helpers.ts";

function release(core: SuperAgentCore, id: string): CoreResult<WorkItem> {
  return core.releaseWorkItem({ workItemId: id, reviewerId: "reviewer", ...guard(core) });
}

function reviewResult(core: SuperAgentCore, id: string, evidenceIds: string[]): CoreResult<GateDecision> {
  const item = state(core).workItems[id];
  return core.submitReview({
    workItemId: id, mandateId: item.currentMandateId ?? "", attempt: item.attempt,
    reviewerId: "reviewer", result: "pass", evidenceIds, ...guard(core)
  });
}

interface ArkRecoveryFixture {
  saved: RunState;
  oldMandate: Mandate;
  oldEvidenceIds: string[];
}

function arkReportedDoneSnapshot(): ArkRecoveryFixture {
  const core = makeCore();
  plan(core, [
    itemInput("W1"),
    itemInput("W2", { dependencies: ["W1"], writeScopes: ["src/W2"] })
  ]);
  const oldMandate = running(core, "W1");
  report(core, oldMandate);
  codeEvidence(core, "W1");
  must(core.reconcileRecovery({ nativeReceipts: [], ...guard(core) }));
  assert.equal(state(core).run.generation, 2);
  const saved = state(core);
  return { saved, oldMandate, oldEvidenceIds: allCurrentEvidenceIds(core, "W1") };
}

function restoreSnapshot(snapshot: RunState): SuperAgentCore {
  const restored = makeEmptyCore();
  must(restored.restoreSnapshot(snapshot, [], proofFor(snapshot)));
  assert.equal(state(restored).run.generation, snapshot.run.generation + 1);
  assert.equal(state(restored).workItems.W2.status, "held");
  return restored;
}

function restoreArk(snapshot: RunState): SuperAgentCore {
  const restored = restoreSnapshot(snapshot);
  assert.equal(state(restored).workItems.W1.status, "reported_done");
  return restored;
}

function replanW1(core: SuperAgentCore): void {
  plan(core, itemInput("W1"));
  assert.equal(state(core).workItems.W1.status, "ready");
  assert.equal(state(core).workItems.W1.currentMandateId, undefined);
  assert.equal(state(core).workItems.W2.status, "held");
}

test("Ark v2 gen2 reported_done to gen3 recovery has a complete replan and successor-unlock path", () => {
  const fixture = arkReportedDoneSnapshot();
  const restored = restoreArk(fixture.saved);
  expectError(reviewResult(restored, "W1", fixture.oldEvidenceIds), "STALE_GENERATION");
  replanW1(restored);
  const mandate = must(restored.prepareMandate({
    workItemId: "W1", workerId: "worker", reviewerId: "reviewer", knownFailures: [], ...guard(restored)
  }));
  assert.equal(mandate.id === fixture.oldMandate.id, false);
  assert.equal(mandate.attempt, 2);
  assert.equal(mandate.generation, 3);
  must(restored.bindExecution({
    mandateId: mandate.id, nativeTaskId: "native-W1-new", workerAgentId: "agent-worker-new", ...guard(restored)
  }));
  report(restored, mandate);
  const newEvidence = codeEvidence(restored, "W1").map(entry => entry.id);
  assert.equal(newEvidence.some(id => fixture.oldEvidenceIds.includes(id)), false);
  submitPass(restored, "W1");
  assert.equal(must(release(restored, "W1")).status, "accepted");
  assert.equal(state(restored).workItems.W2.status, "ready");
  assert.equal(restored.evaluateGate("W1").staleEvidence.includes(fixture.oldEvidenceIds[0]), true);
});

test("Ark recovery replan snapshot survives a second restore and keeps immutable old evidence", () => {
  const fixture = arkReportedDoneSnapshot();
  const first = restoreArk(fixture.saved);
  replanW1(first);
  const replanned = state(first);
  const second = restoreSnapshot(replanned);
  assert.equal(state(second).workItems.W1.status, "ready");
  assert.equal(state(second).workItems.W1.attempt, 1);
  assert.equal(state(second).workItems.W1.currentMandateId, undefined);
  const originalGeneration = fixture.saved.mandates[fixture.oldMandate.id].generation;
  assert.equal(state(second).mandates[fixture.oldMandate.id].generation, originalGeneration);
  assert.ok(Object.values(state(second).evidence).filter(entry => fixture.oldEvidenceIds.includes(entry.id))
    .every(entry => entry.generation === originalGeneration && entry.mandateId === fixture.oldMandate.id));
  const next = must(second.prepareMandate({
    workItemId: "W1", workerId: "worker", reviewerId: "reviewer", knownFailures: [], ...guard(second)
  }));
  assert.equal(next.attempt, 2);
  assert.equal(next.generation, 4);
});

test("recovery replan locks every contract field", () => {
  const fixture = arkReportedDoneSnapshot();
  const restored = restoreArk(fixture.saved);
  const before = state(restored);
  const original = state(restored).workItems.W1;
  const variants = [
    itemInput("W1", { title: "expanded title" }),
    itemInput("W1", { dependencies: ["missing"] }),
    itemInput("W1", { writeScopes: ["src/W1", "src/expanded"] }),
    itemInput("W1", { acceptance: ["changed acceptance"] }),
    itemInput("W1", { obligationIds: ["unknown-obligation"] }),
    itemInput("W1", { gateProfile: "visual" }),
    itemInput("W1", { hostContractRequired: true }),
    itemInput("W1", { mandatory: false })
  ];
  for (const item of variants) {
    const expected = item.obligationIds.includes("unknown-obligation") ? "OBLIGATION_OPEN" : "INVALID_TRANSITION";
    expectError(restored.planWorkItems({ items: [item], ...guard(restored) }), expected);
    assert.deepEqual(state(restored), before);
  }
  assert.equal(original.status, "reported_done");
});

test("ordinary same-generation reported_done cannot be rewritten by planWorkItems", () => {
  const core = makeCore();
  plan(core, itemInput("W1"));
  const mandate = running(core, "W1");
  report(core, mandate);
  const before = state(core);
  expectError(core.planWorkItems({ items: [itemInput("W1")], ...guard(core) }), "INVALID_TRANSITION");
  assert.deepEqual(state(core), before);
  codeEvidence(core, "W1");
  submitPass(core, "W1");
  assert.equal(must(release(core, "W1")).status, "accepted");
});

test("latest valid unknown Decision permits same-contract replan with fresh evidence", () => {
  const core = makeCore();
  plan(core, itemInput("W1"));
  const originalMandate = running(core, "W1");
  report(core, originalMandate);
  const oldEvidenceIds = codeEvidence(core, "W1").map(entry => entry.id);
  const originalAttempt = state(core).workItems.W1.attempt;
  must(core.submitReview({
    workItemId: "W1", mandateId: originalMandate.id, attempt: originalAttempt,
    reviewerId: "reviewer", result: "unknown", evidenceIds: oldEvidenceIds, ...guard(core)
  }));
  const unknownDecision = Object.values(state(core).decisions).find(decision => decision.mandateId === originalMandate.id);
  assert.ok(unknownDecision);
  assert.equal(state(core).workItems.W1.status, "verifying");
  assert.equal(state(core).mandates[originalMandate.id].status, "verifying");

  plan(core, itemInput("W1"));
  assert.equal(state(core).workItems.W1.status, "ready");
  assert.equal(state(core).workItems.W1.currentMandateId, undefined);
  const next = running(core, "W1");
  assert.notEqual(next.id, originalMandate.id);
  assert.equal(next.attempt, originalAttempt + 1);
  report(core, next);
  expectError(reviewResult(core, "W1", oldEvidenceIds), "EVIDENCE_MISSING");
  assert.deepEqual(state(core).decisions[unknownDecision.id], unknownDecision);

  codeEvidence(core, "W1");
  submitPass(core, "W1");
  assert.equal(must(release(core, "W1")).status, "accepted");
});

test("same-generation verifying with a valid pass cannot be replanned", () => {
  const core = makeCore();
  plan(core, itemInput("W1"));
  const mandate = running(core, "W1");
  report(core, mandate);
  codeEvidence(core, "W1");
  submitPass(core, "W1");
  const before = state(core);
  expectError(core.planWorkItems({ items: [itemInput("W1")], ...guard(core) }), "INVALID_TRANSITION");
  assert.deepEqual(state(core), before);
  assert.equal(must(release(core, "W1")).status, "accepted");
});

test("unknown-Decision replan rejects every contract mutation atomically", () => {
  const core = makeCore([{ id: "duty", kind: "requirement", text: "preserve the contracted duty" }]);
  const original = itemInput("W1", { obligationIds: ["duty"] });
  plan(core, original);
  const mandate = running(core, "W1");
  report(core, mandate);
  const evidenceIds = codeEvidence(core, "W1").map(entry => entry.id);
  must(core.submitReview({
    workItemId: "W1", mandateId: mandate.id, attempt: 1,
    reviewerId: "reviewer", result: "unknown", evidenceIds, ...guard(core)
  }));
  const before = state(core);
  const variants = [
    itemInput("W1", { obligationIds: ["duty"], title: "changed title" }),
    itemInput("W1", { obligationIds: ["duty"], dependencies: ["missing"] }),
    itemInput("W1", { obligationIds: ["duty"], writeScopes: ["src/expanded"] }),
    itemInput("W1", { obligationIds: ["duty"], acceptance: ["changed acceptance"] }),
    itemInput("W1", { obligationIds: [] }),
    itemInput("W1", { obligationIds: ["duty"], gateProfile: "visual" }),
    itemInput("W1", { obligationIds: ["duty"], hostContractRequired: true }),
    itemInput("W1", { obligationIds: ["duty"], mandatory: false })
  ];
  for (const item of variants) {
    expectError(core.planWorkItems({ items: [item], ...guard(core) }), "INVALID_TRANSITION");
    assert.deepEqual(state(core), before);
  }
  plan(core, original);
  assert.equal(state(core).workItems.W1.status, "ready");
});

test("post-pass contradictory evidence permits same-contract replan and approved revision", () => {
  const setup = (result: "fail" | "unknown") => {
    const core = makeCore();
    plan(core, itemInput("W1"));
    const mandate = running(core, "W1");
    report(core, mandate);
    codeEvidence(core, "W1");
    submitPass(core, "W1");
    evidence(core, "W1", {
      kind: "build", result, sourceActor: "host", sourceRole: "host",
      receipt: { exitCode: result === "fail" ? 1 : 0 }
    });
    return core;
  };

  const replanned = setup("fail");
  expectError(release(replanned, "W1"), "EVIDENCE_FAIL");
  assert.equal(replanned.evaluateGate("W1").result, "fail");
  plan(replanned, itemInput("W1"));
  assert.equal(state(replanned).workItems.W1.status, "ready");
  const next = running(replanned, "W1");
  assert.equal(next.attempt, 2);
  report(replanned, next);
  codeEvidence(replanned, "W1");
  submitPass(replanned, "W1");
  assert.equal(must(release(replanned, "W1")).status, "accepted");

  const revised = setup("unknown");
  assert.equal(revised.evaluateGate("W1").result, "unknown");
  const oldDecision = Object.values(state(revised).decisions).find(decision => decision.workItemId === "W1");
  assert.ok(oldDecision);
  const revisedContract = itemInput("W1", { title: "User revised contract after contradictory evidence" });
  must(revised.applyUserInstruction({
    runId: state(revised).run.id,
    instruction: "User approves revision because the former pass no longer has a passing gate",
    obligationDelta: [],
    workItemRevisions: [revisedContract],
    ...guard(revised)
  }));
  assert.equal(state(revised).decisions[oldDecision.id].invalidated, true);
  assert.equal(state(revised).workItems.W1.status, "superseded");
  plan(revised, revisedContract);
  assert.equal(state(revised).workItems.W1.title, revisedContract.title);
  assert.equal(state(revised).workItems.W1.status, "ready");
});

test("Ark old evidence and old decision cannot be replayed into the new attempt", () => {
  const fixture = arkReportedDoneSnapshot();
  const restored = restoreArk(fixture.saved);
  replanW1(restored);
  const next = must(restored.prepareMandate({
    workItemId: "W1", workerId: "worker", reviewerId: "reviewer", knownFailures: [], ...guard(restored)
  }));
  must(restored.bindExecution({ mandateId: next.id, ...guard(restored) }));
  report(restored, next);
  expectError(reviewResult(restored, "W1", fixture.oldEvidenceIds), "EVIDENCE_MISSING");
  codeEvidence(restored, "W1");
  expectError(reviewResult(restored, "W1", [...allCurrentEvidenceIds(restored, "W1"), ...fixture.oldEvidenceIds]), "EVIDENCE_MISSING");
});
