import test from "node:test";
import assert from "node:assert/strict";
import type { HardCheck } from "../../src/core/index.ts";
import {
  allCurrentEvidenceIds,
  codeEvidence,
  expectError,
  guard,
  itemInput,
  makeCore,
  mutationEscapes,
  must,
  plan,
  prepare,
  report,
  running,
  state,
  submitPass
} from "./helpers.ts";

test("CAS rejection is atomic and revision-disabled mutation escapes", () => {
  const normal = makeCore();
  const before = state(normal);
  const rejected = normal.planWorkItems({ items: [itemInput("a")], expectedRevision: before.run.revision + 1, expectedGeneration: before.run.generation });
  expectError(rejected, "STALE_REVISION");
  assert.deepEqual(state(normal), before);
  assert.equal(rejected.events.length, 0);
  mutationEscapes("revision", "STALE_REVISION", () => {
    const mutant = makeCore([], ["revision"]);
    const current = state(mutant).run;
    return mutant.planWorkItems({ items: [itemInput("a")], expectedRevision: current.revision + 1, expectedGeneration: current.generation });
  });
});

test("C1 anchor replacement preserves token duty and only invalidates affected successors", () => {
  const setup = (disabledChecks: HardCheck[] = []) => {
    const core = makeCore([
      { id: "visual", kind: "requirement", text: "visual correction" },
      { id: "token", kind: "requirement", text: "reconcile token totals" }
    ], disabledChecks);
    plan(core, [
      itemInput("visual", { obligationIds: ["visual"] }),
      itemInput("token", { obligationIds: ["token"] }),
      itemInput("visual-docs", { dependencies: ["visual"], writeScopes: ["docs/visual"] })
    ]);
    const visualMandate = running(core, "visual");
    report(core, visualMandate);
    codeEvidence(core, "visual");
    running(core, "token");
    const evidenceIds = allCurrentEvidenceIds(core, "visual");
    const oldAttempt = state(core).workItems.visual.attempt;
    const applied = must(core.applyUserInstruction({
      runId: state(core).run.id,
      instruction: "change only the visual requirement",
      obligationDelta: [{ op: "amend", id: "visual", patch: { text: "use three modes in one tab" } }],
      ...guard(core)
    }));
    return { core, visualMandate, evidenceIds, oldAttempt, applied };
  };
  const normal = setup();
  assert.equal(normal.applied.version, 2);
  const firstAnchor = Object.values(state(normal.core).anchors).find(anchor => anchor.version === 1);
  assert.equal(normal.applied.supersedes, firstAnchor?.id);
  assert.equal(state(normal.core).obligations.token.status, "open");
  assert.equal(state(normal.core).workItems.visual.status, "superseded");
  assert.equal(state(normal.core).workItems["visual-docs"].status, "superseded");
  assert.equal(state(normal.core).workItems.token.status, "running");
  assert.equal(state(normal.core).mandates[normal.visualMandate.id].needsStop, false);
  const rejected = normal.core.submitReview({
    workItemId: "visual",
    mandateId: normal.visualMandate.id,
    attempt: normal.oldAttempt,
    reviewerId: "reviewer",
    result: "pass",
    evidenceIds: normal.evidenceIds,
    ...guard(normal.core)
  });
  expectError(rejected, "ANCHOR_STALE");
  mutationEscapes("anchor", "ANCHOR_STALE", () => {
    const mutant = setup(["anchor"]);
    assert.equal(state(mutant.core).workItems.token.status, "running");
    return mutant.core.submitReview({
      workItemId: "visual",
      mandateId: mutant.visualMandate.id,
      attempt: mutant.oldAttempt,
      reviewerId: "reviewer",
      result: "pass",
      evidenceIds: mutant.evidenceIds,
      ...guard(mutant.core)
    });
  });
});

test("C2 user scope expansion does not cancel unrelated work or close source coverage", () => {
  const setup = (disabledChecks: HardCheck[] = []) => {
    const core = makeCore([{ id: "source-full", kind: "coverage", text: "read full source", coverage: "unknown", sourceId: "repo" }], disabledChecks);
    plan(core, itemInput("visual", { mandatory: false }));
    running(core, "visual");
    must(core.applyUserInstruction({
      runId: state(core).run.id,
      instruction: "also inspect the supplied media",
      obligationDelta: [{ op: "add", obligation: { id: "media", kind: "coverage", text: "inspect media", coverage: "unknown" } }],
      ...guard(core)
    }));
    return core;
  };
  const normal = setup();
  assert.equal(state(normal).workItems.visual.status, "running");
  assert.equal(state(normal).obligations["source-full"].status, "open");
  assert.equal(state(normal).audit.at(-1)?.payload.classification, "user_scope_expansion");
  assert.equal(state(normal).audit.some(event => event.type === "agent_autonomous_drift"), false);
  expectError(normal.completeRun(guard(normal)), "COVERAGE_INCOMPLETE");
  mutationEscapes("coverage", "COVERAGE_INCOMPLETE", () => {
    const mutant = setup(["coverage"]);
    return mutant.completeRun(guard(mutant));
  });
});

test("C13 unknown dependencies, cycles and parallel write overlap are rejected", () => {
  const unknown = makeCore();
  expectError(unknown.planWorkItems({ items: [itemInput("a", { dependencies: ["missing"] })], ...guard(unknown) }), "DEPENDENCY_NOT_ACCEPTED");
  mutationEscapes("dependency", "DEPENDENCY_NOT_ACCEPTED", () => {
    const mutant = makeCore([], ["dependency"]);
    return mutant.planWorkItems({ items: [itemInput("a", { dependencies: ["missing"] })], ...guard(mutant) });
  });

  const cycle = makeCore();
  const cycleItems = [itemInput("a", { dependencies: ["b"] }), itemInput("b", { dependencies: ["a"] })];
  expectError(cycle.planWorkItems({ items: cycleItems, ...guard(cycle) }), "DEPENDENCY_CYCLE");
  mutationEscapes("dependency", "DEPENDENCY_CYCLE", () => {
    const mutant = makeCore([], ["dependency"]);
    return mutant.planWorkItems({ items: cycleItems, ...guard(mutant) });
  });

  const overlap = makeCore();
  const overlapItems = [itemInput("a", { writeScopes: ["src/plugin"] }), itemInput("b", { writeScopes: ["src/plugin/ui"] })];
  expectError(overlap.planWorkItems({ items: overlapItems, ...guard(overlap) }), "WRITE_SCOPE_OVERLAP");
  mutationEscapes("writeScope", "WRITE_SCOPE_OVERLAP", () => {
    const mutant = makeCore([], ["writeScope"]);
    return mutant.planWorkItems({ items: overlapItems, ...guard(mutant) });
  });
});

test("C7 worker/reviewer separation covers both mandate and submitted reviewer", () => {
  const normal = makeCore();
  plan(normal, itemInput("a"));
  expectError(normal.prepareMandate({ workItemId: "a", workerId: "same", reviewerId: "same", knownFailures: [], ...guard(normal) }), "REVIEWER_SAME_AS_WORKER");
  mutationEscapes("actor", "REVIEWER_SAME_AS_WORKER", () => {
    const mutant = makeCore([], ["actor"]);
    plan(mutant, itemInput("a"));
    return mutant.prepareMandate({ workItemId: "a", workerId: "same", reviewerId: "same", knownFailures: [], ...guard(mutant) });
  });

  const wrong = makeCore();
  plan(wrong, itemInput("a"));
  const mandate = running(wrong, "a");
  report(wrong, mandate);
  const review = { workItemId: "a", mandateId: mandate.id, attempt: 1, reviewerId: "other", result: "unknown" as const, evidenceIds: [] };
  expectError(wrong.submitReview({ ...review, ...guard(wrong) }), "ACTOR_MISMATCH");
  mutationEscapes("actor", "ACTOR_MISMATCH", () => {
    const mutant = makeCore([], ["actor"]);
    plan(mutant, itemInput("a"));
    const bound = running(mutant, "a");
    report(mutant, bound);
    return mutant.submitReview({ ...review, mandateId: bound.id, ...guard(mutant) });
  });
});

test("worker actor mismatch rejects and valid reported_done is still not accepted", () => {
  const normal = makeCore();
  plan(normal, itemInput("a"));
  const mandate = running(normal, "a");
  expectError(normal.reportWorkerDone({ mandateId: mandate.id, workerId: "intruder", summary: "false done", ...guard(normal) }), "ACTOR_MISMATCH");
  mutationEscapes("actor", "ACTOR_MISMATCH", () => {
    const mutant = makeCore([], ["actor"]);
    plan(mutant, itemInput("a"));
    const bound = running(mutant, "a");
    return mutant.reportWorkerDone({ mandateId: bound.id, workerId: "intruder", summary: "false done", ...guard(mutant) });
  });
  report(normal, mandate);
  assert.equal(state(normal).workItems.a.status, "reported_done");
  assert.notEqual(state(normal).workItems.a.status, "accepted");
});

test("C12 two identical user rejections invalidate self-pass and block the next mandate", () => {
  const setup = (disabledChecks: HardCheck[] = []) => {
    const core = makeCore([], disabledChecks, 2);
    plan(core, itemInput("visual"));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const mandate = running(core, "visual");
      report(core, mandate);
      codeEvidence(core, "visual");
      submitPass(core, "visual");
      must(core.recordUserFeedback({ workItemId: "visual", verdict: "rejected", note: "same visual failure", fingerprint: "empty_graph", ...guard(core) }));
      assert.equal(Object.values(state(core).decisions).filter(decision => decision.workItemId === "visual" && decision.attempt === attempt + 1)[0].invalidated, true);
    }
    return core;
  };
  const normal = setup();
  assert.equal(state(normal).workItems.visual.status, "blocked");
  assert.equal(state(normal).workItems.visual.failureFingerprints.empty_graph, 2);
  expectError(normal.prepareMandate({ workItemId: "visual", workerId: "worker", reviewerId: "reviewer", knownFailures: ["empty_graph"], ...guard(normal) }), "REPEATED_FAILURE");
  mutationEscapes("failureBudget", "REPEATED_FAILURE", () => {
    const mutant = setup(["failureBudget"]);
    return mutant.prepareMandate({ workItemId: "visual", workerId: "worker", reviewerId: "reviewer", knownFailures: ["empty_graph"], ...guard(mutant) });
  });
});

test("C16 recovery marks receipt-less running mandate unknown and rejects old generation", () => {
  const setup = (disabledChecks: HardCheck[] = []) => {
    const core = makeCore([], disabledChecks);
    plan(core, itemInput("a"));
    const mandate = running(core, "a");
    const oldGeneration = state(core).run.generation;
    must(core.reconcileRecovery({ nativeReceipts: [], ...guard(core) }));
    return { core, mandate, oldGeneration };
  };
  const normal = setup();
  assert.equal(state(normal.core).mandates[normal.mandate.id].status, "unknown");
  assert.equal(state(normal.core).workItems.a.status, "verifying");
  assert.notEqual(state(normal.core).workItems.a.status, "accepted");
  const before = state(normal.core);
  const rejected = normal.core.pauseRun({ expectedRevision: before.run.revision, expectedGeneration: normal.oldGeneration });
  expectError(rejected, "STALE_GENERATION");
  assert.deepEqual(state(normal.core), before);
  mutationEscapes("generation", "STALE_GENERATION", () => {
    const mutant = setup(["generation"]);
    return mutant.core.pauseRun({ expectedRevision: state(mutant.core).run.revision, expectedGeneration: mutant.oldGeneration });
  });
});

test("prepareMandate embeds all six Worker execution contract rules", () => {
  const core = makeCore();
  plan(core, itemInput("a"));
  const mandate = prepare(core, "a");
  const rules = [
    "1. 不静默改道 / No silent rerouting:",
    "2. 读后再改 / Read before edit:",
    "3. 写域不外扩 / Stay within write scopes:",
    "4. 歧义分级 / Grade ambiguity:",
    "5. 按验收自验 / Verify against acceptance:",
    "6. 报告自带证据 / Report with evidence:"
  ];
  assert.ok(mandate.mandateText.includes("Worker execution contract (六条执行契约):"));
  for (const rule of rules) assert.ok(mandate.mandateText.includes(rule), "missing Worker rule: " + rule);
  assert.equal(mandate.mandateText.split("\n").filter(line => /^[1-6]\. /.test(line)).length, 6);
});

test("C17 valid independent evidence releases work and unlocks only satisfied successors", () => {
  const core = makeCore([{ id: "deliver", kind: "requirement", text: "deliver accepted implementation" }]);
  plan(core, [
    itemInput("a", { obligationIds: ["deliver"] }),
    itemInput("b", { dependencies: ["a"], writeScopes: ["src/b"] }),
    itemInput("c", { dependencies: ["b"], writeScopes: ["src/c"] })
  ]);
  assert.equal(state(core).workItems.b.status, "held");
  const mandate = running(core, "a");
  assert.match(mandate.mandateText, /Definition of done/);
  assert.ok(mandate.mandateText.includes("Write scopes: src/a"));
  assert.match(mandate.mandateText, /worker done is not acceptance/);
  assert.deepEqual({ nativeTaskId: mandate.nativeTaskId, workerAgentId: mandate.workerAgentId }, { nativeTaskId: "native-a", workerAgentId: "agent-worker" });
  report(core, mandate);
  codeEvidence(core, "a");
  submitPass(core, "a");
  const released = must(core.releaseWorkItem({ workItemId: "a", reviewerId: "reviewer", ...guard(core) }));
  assert.equal(released.status, "accepted");
  assert.equal(state(core).workItems.b.status, "ready");
  assert.equal(state(core).workItems.c.status, "held");
  assert.equal(state(core).obligations.deliver.status, "met");
});

test("unrelated scope expansion keeps a prepared mandate bindable across anchors", () => {
  const core = makeCore([{ id: "visual", kind: "requirement", text: "visual work" }]);
  plan(core, itemInput("a", { obligationIds: ["visual"], mandatory: false }));
  const mandate = prepare(core, "a");
  must(core.applyUserInstruction({
    runId: state(core).run.id,
    instruction: "add a separate media inquiry",
    obligationDelta: [{ op: "add", obligation: { id: "media", kind: "coverage", text: "media coverage", coverage: "unknown" } }],
    ...guard(core)
  }));
  const bound = must(core.bindExecution({ mandateId: mandate.id, nativeTaskId: "native-a", workerAgentId: "agent-worker", ...guard(core) }));
  assert.equal(bound.status, "running");
  assert.equal(bound.anchorVersion, 1);
  must(core.pauseRun(guard(core)));
  assert.equal(state(core).run.status, "paused");
  must(core.resumeRun(guard(core)));
  assert.equal(state(core).run.status, "active");
});

test("explicit user waiver is audited and exempts only the named coverage obligation", () => {
  const core = makeCore([{ id: "optional-source", kind: "coverage", text: "optional source", coverage: "partial" }]);
  must(core.applyUserInstruction({
    runId: state(core).run.id,
    instruction: "waive only the named optional source",
    obligationDelta: [{ op: "waive", id: "optional-source", reason: "user explicitly accepted the substitute" }],
    ...guard(core)
  }));
  assert.equal(state(core).obligations["optional-source"].status, "waived");
  assert.equal(state(core).obligations["optional-source"].userWaiver, "user explicitly accepted the substitute");
  const completed = must(core.completeRun(guard(core)));
  assert.equal(completed.status, "completed");
});

test("supersede delta retires only the old obligation and carries the replacement", () => {
  const core = makeCore([{ id: "old", kind: "requirement", text: "old acceptance" }]);
  const anchor = must(core.applyUserInstruction({
    runId: state(core).run.id,
    instruction: "replace the old acceptance explicitly",
    obligationDelta: [{ op: "supersede", id: "old", replacement: { id: "new", kind: "requirement", text: "new acceptance" } }],
    ...guard(core)
  }));
  assert.equal(state(core).obligations.old.status, "superseded");
  assert.equal(state(core).obligations.new.status, "open");
  assert.deepEqual(anchor.obligationSnapshot, ["new"]);
});

test("user-approved workItemRevisions supersedes empty-obligation work and requires fresh acceptance", () => {
  const core = makeCore();
  plan(core, itemInput("a", { hostContractRequired: true }));
  const oldMandate = running(core, "a");
  report(core, oldMandate);
  const oldEvidenceIds = codeEvidence(core, "a").map(entry => entry.id);
  must(core.submitReview({
    workItemId: "a", mandateId: oldMandate.id, attempt: 1,
    reviewerId: "reviewer", result: "unknown", evidenceIds: oldEvidenceIds, ...guard(core)
  }));
  const before = state(core);
  const oldAnchor = before.anchors[before.run.currentAnchorId];
  const oldDecision = Object.values(before.decisions).find(decision => decision.mandateId === oldMandate.id);
  assert.ok(oldDecision);
  const revised = itemInput("a", {
    title: "Behavior acceptance contract",
    acceptance: ["native delivery and three behavior scenarios are covered"],
    hostContractRequired: false
  });
  const applied = must(core.applyUserInstruction({
    runId: before.run.id,
    instruction: "User approves replacing the generic host flag with explicit behavior evidence",
    obligationDelta: [],
    workItemRevisions: [revised],
    ...guard(core)
  }));
  assert.equal(applied.version, oldAnchor.version + 1);
  assert.equal(applied.supersedes, oldAnchor.id);
  assert.equal(state(core).workItems.a.status, "superseded");
  assert.equal(state(core).mandates[oldMandate.id].status, "superseded");
  assert.equal(state(core).decisions[oldDecision.id].invalidated, true);
  const audit = state(core).audit.at(-1);
  assert.equal(audit?.type, "anchor.applied");
  assert.equal(audit?.actor, "user");
  assert.equal(audit?.payload.classification, "user_contract_revision");
  assert.deepEqual(audit?.payload.revisedWorkItemIds, ["a"]);
  const revisionAudit = JSON.stringify(audit?.payload.workItemRevisionAudits);
  assert.ok(revisionAudit.includes('"hostContractRequired":true'));
  assert.ok(revisionAudit.includes('"hostContractRequired":false'));

  const beforeWrongPlan = state(core);
  expectError(core.planWorkItems({
    items: [itemInput("a", { ...revised, mandatory: false })], ...guard(core)
  }), "INVALID_TRANSITION");
  assert.deepEqual(state(core), beforeWrongPlan);

  plan(core, revised);
  assert.equal(state(core).workItems.a.status, "ready");
  assert.equal(state(core).workItems.a.hostContractRequired, false);
  const next = running(core, "a");
  assert.equal(next.attempt, 2);
  assert.equal(next.anchorVersion, applied.version);
  report(core, next);
  expectError(core.submitReview({
    workItemId: "a", mandateId: next.id, attempt: next.attempt,
    reviewerId: "reviewer", result: "pass", evidenceIds: oldEvidenceIds, ...guard(core)
  }), "EVIDENCE_MISSING");
  codeEvidence(core, "a");
  submitPass(core, "a");
  assert.equal(must(core.releaseWorkItem({ workItemId: "a", reviewerId: "reviewer", ...guard(core) })).status, "accepted");
});

test("workItemRevisions cannot revoke accepted work or a current valid pass", () => {
  const attemptRevision = (core: ReturnType<typeof makeCore>) => core.applyUserInstruction({
    runId: state(core).run.id,
    instruction: "attempt to replace an already passing contract",
    obligationDelta: [],
    workItemRevisions: [itemInput("a", { title: "replacement", hostContractRequired: true })],
    ...guard(core)
  });
  const accepted = makeCore();
  plan(accepted, itemInput("a"));
  const acceptedMandate = running(accepted, "a");
  report(accepted, acceptedMandate);
  codeEvidence(accepted, "a");
  submitPass(accepted, "a");
  must(accepted.releaseWorkItem({ workItemId: "a", reviewerId: "reviewer", ...guard(accepted) }));
  const acceptedBefore = state(accepted);
  expectError(attemptRevision(accepted), "INVALID_TRANSITION");
  assert.deepEqual(state(accepted), acceptedBefore);

  const passing = makeCore();
  plan(passing, itemInput("a"));
  const passingMandate = running(passing, "a");
  report(passing, passingMandate);
  codeEvidence(passing, "a");
  submitPass(passing, "a");
  const passingBefore = state(passing);
  expectError(attemptRevision(passing), "INVALID_TRANSITION");
  assert.deepEqual(state(passing), passingBefore);
  assert.equal(must(passing.releaseWorkItem({ workItemId: "a", reviewerId: "reviewer", ...guard(passing) })).status, "accepted");
});

test("malformed duplicate and unknown workItemRevisions fail atomically", () => {
  const core = makeCore();
  plan(core, itemInput("a"));
  const before = state(core);
  const variants: { revisions: unknown; code: string }[] = [
    { revisions: null, code: "INVALID_INPUT" },
    { revisions: [null], code: "INVALID_INPUT" },
    { revisions: [{ ...itemInput("a"), dependencies: undefined }], code: "INVALID_INPUT" },
    { revisions: [itemInput("a"), itemInput("a")], code: "INVALID_INPUT" },
    { revisions: [itemInput("missing")], code: "INVALID_TRANSITION" }
  ];
  for (const variant of variants) {
    const result = core.applyUserInstruction({
      runId: before.run.id,
      instruction: "invalid contract revision must not commit",
      obligationDelta: [],
      workItemRevisions: variant.revisions as never,
      ...guard(core)
    });
    expectError(result, variant.code);
    assert.deepEqual(state(core), before);
    assert.equal(result.events.length, 0);
  }
});

test("A-only revision locks every downstream B contract field", () => {
  const core = makeCore([{ id: "duty", kind: "requirement", text: "preserve B duty" }]);
  const originalA = itemInput("a");
  const originalB = itemInput("b", { dependencies: ["a"], obligationIds: ["duty"] });
  plan(core, [originalA, originalB]);
  const revisedA = itemInput("a", { title: "User revised A only" });
  must(core.applyUserInstruction({
    runId: state(core).run.id,
    instruction: "User approves changing A only",
    obligationDelta: [],
    workItemRevisions: [revisedA],
    ...guard(core)
  }));
  assert.equal(state(core).workItems.b.status, "superseded");
  const before = state(core);
  const variants = [
    itemInput("b", { ...originalB, title: "Unapproved B" }),
    itemInput("b", { ...originalB, dependencies: [] }),
    itemInput("b", { ...originalB, writeScopes: ["src/b", "src/expanded"] }),
    itemInput("b", { ...originalB, acceptance: ["unapproved B"] }),
    itemInput("b", { ...originalB, obligationIds: [] }),
    itemInput("b", { ...originalB, gateProfile: "visual" }),
    itemInput("b", { ...originalB, hostContractRequired: true }),
    itemInput("b", { ...originalB, mandatory: false })
  ];
  for (const item of variants) {
    expectError(core.planWorkItems({ items: [item], ...guard(core) }), "INVALID_TRANSITION");
    assert.deepEqual(state(core), before);
  }
  plan(core, originalB);
  assert.equal(state(core).workItems.b.status, "held");
  assert.deepEqual(state(core).workItems.b, {
    ...state(core).workItems.b,
    ...originalB,
    hostContractRequired: false,
    mandatory: true
  });

  const approved = makeCore([{ id: "duty", kind: "requirement", text: "preserve B duty" }]);
  const revisedB = itemInput("b", { dependencies: ["a"], obligationIds: ["duty"], title: "User also revised B" });
  plan(approved, [originalA, originalB]);
  must(approved.applyUserInstruction({
    runId: state(approved).run.id,
    instruction: "User approves changing both A and B",
    obligationDelta: [],
    workItemRevisions: [revisedA, revisedB],
    ...guard(approved)
  }));
  plan(approved, revisedB);
  assert.equal(state(approved).workItems.b.title, "User also revised B");
});
