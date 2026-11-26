import test from "node:test";
import assert from "node:assert/strict";
import type { CoverageStatus, HardCheck } from "../../src/core/index.ts";
import {
  allCurrentEvidenceIds,
  codeEvidence,
  codeItemReadyForReview,
  evidence,
  expectError,
  guard,
  itemInput,
  makeCore,
  mutationEscapes,
  must,
  plan,
  report,
  running,
  state,
  submitPass,
  visualEvidence
} from "./helpers.ts";

test("C3 prohibition survives a later unrelated anchor and drop-shadow fails the total gate", () => {
  const setup = (disabledChecks: HardCheck[] = []) => {
    const core = makeCore([{ id: "no-glow", kind: "prohibition", text: "do not add artificial glow or drop-shadow" }], disabledChecks);
    plan(core, itemInput("visual", { gateProfile: "visual", obligationIds: ["no-glow"] }));
    const mandate = running(core, "visual");
    report(core, mandate);
    visualEvidence(core, "visual");
    must(core.applyUserInstruction({
      runId: state(core).run.id,
      instruction: "continue with an unrelated query",
      obligationDelta: [],
      ...guard(core)
    }));
    assert.equal(state(core).workItems.visual.status, "reported_done");
    assert.ok(state(core).anchors[state(core).run.currentAnchorId].obligationSnapshot.includes("no-glow"));
    evidence(core, "visual", { kind: "runtime_gui", receipt: { obligationId: "no-glow", violated: true, observed: "drop-shadow" } });
    return core;
  };
  const normal = setup();
  const gate = normal.evaluateGate("visual");
  assert.equal(gate.result, "fail");
  assert.ok(gate.reasons.includes("PROHIBITION_VIOLATED"));
  assert.deepEqual(gate.violatedObligations, ["no-glow"]);
  const mutant = setup(["prohibition"]);
  assert.throws(() => assert.equal(mutant.evaluateGate("visual").result, "fail"));
  assert.equal(mutant.evaluateGate("visual").result, "pass");
});

test("C4 scale/fade evidence cannot satisfy clockwise_sweep", () => {
  const setup = (disabledChecks: HardCheck[] = []) => {
    const core = makeCore([{ id: "sweep", kind: "requirement", text: "clockwise sweep", animation: "clockwise_sweep" }], disabledChecks);
    plan(core, itemInput("visual", { gateProfile: "visual", obligationIds: ["sweep"] }));
    const mandate = running(core, "visual");
    report(core, mandate);
    visualEvidence(core, "visual");
    evidence(core, "visual", { kind: "animation", receipt: { obligationId: "sweep", mode: "scale_fade", samples: 3 } });
    return core;
  };
  const gate = setup().evaluateGate("visual");
  assert.equal(gate.result, "fail");
  assert.ok(gate.reasons.includes("OBLIGATION_OPEN"));
  const mutant = setup(["animation"]);
  assert.throws(() => assert.equal(mutant.evaluateGate("visual").result, "fail"));
  assert.equal(mutant.evaluateGate("visual").result, "pass");
});

test("C5 65 unit passes plus build/static do not satisfy runtime animation or hover", () => {
  const setup = (disabledChecks: HardCheck[] = []) => {
    const core = makeCore([
      { id: "motion", kind: "requirement", text: "real animation", requiredEvidence: ["animation"] },
      { id: "hover", kind: "requirement", text: "real hover", requiredEvidence: ["hover"] }
    ], disabledChecks);
    plan(core, itemInput("visual", { gateProfile: "visual", obligationIds: ["motion", "hover"] }));
    const mandate = running(core, "visual");
    report(core, mandate);
    codeEvidence(core, "visual");
    evidence(core, "visual", { kind: "static", receipt: { screenshot: "static.png" } });
    evidence(core, "visual", { kind: "simulated", receipt: { screenshot: "simulated.png" } });
    return core;
  };
  const normal = setup();
  const gate = normal.evaluateGate("visual");
  assert.equal(gate.result, "unknown");
  assert.deepEqual(gate.missingEvidence.sort(), ["animation", "hover", "runtime_gui"].sort());
  const current = state(normal).workItems.visual;
  must(normal.submitReview({
    workItemId: "visual", mandateId: current.currentMandateId ?? "", attempt: current.attempt,
    reviewerId: "reviewer", result: "unknown", evidenceIds: allCurrentEvidenceIds(normal, "visual"), ...guard(normal)
  }));
  expectError(normal.releaseWorkItem({ workItemId: "visual", reviewerId: "reviewer", ...guard(normal) }), "EVIDENCE_MISSING");
  assert.equal(state(normal).workItems.visual.status, "verifying");
  const mutant = setup(["evidence"]);
  assert.throws(() => assert.equal(mutant.evaluateGate("visual").result, "unknown"));
  assert.equal(mutant.evaluateGate("visual").result, "pass");
  const mutantItem = state(mutant).workItems.visual;
  must(mutant.submitReview({
    workItemId: "visual", mandateId: mutantItem.currentMandateId ?? "", attempt: mutantItem.attempt,
    reviewerId: "reviewer", result: "pass", evidenceIds: allCurrentEvidenceIds(mutant, "visual"), ...guard(mutant)
  }));
  assert.equal(must(mutant.releaseWorkItem({ workItemId: "visual", reviewerId: "reviewer", ...guard(mutant) })).status, "accepted");
});

test("C6 runtime_gui timeout degrades to unknown and cannot be released", () => {
  const setup = (disabledChecks: HardCheck[] = []) => {
    const core = makeCore([], disabledChecks);
    plan(core, itemInput("visual", { gateProfile: "visual" }));
    const mandate = running(core, "visual");
    report(core, mandate);
    codeEvidence(core, "visual");
    evidence(core, "visual", { kind: "runtime_gui", receipt: { timeout: true } });
    return { core, mandate };
  };
  const normal = setup();
  assert.equal(normal.core.evaluateGate("visual").result, "unknown");
  const rejected = normal.core.submitReview({
    workItemId: "visual",
    mandateId: normal.mandate.id,
    attempt: 1,
    reviewerId: "reviewer",
    result: "pass",
    evidenceIds: allCurrentEvidenceIds(normal.core, "visual"),
    ...guard(normal.core)
  });
  expectError(rejected, "EVIDENCE_UNKNOWN");
  assert.equal(state(normal.core).workItems.visual.status, "reported_done");
  mutationEscapes("evidence", "EVIDENCE_UNKNOWN", () => {
    const mutant = setup(["evidence"]);
    return mutant.core.submitReview({
      workItemId: "visual",
      mandateId: mutant.mandate.id,
      attempt: 1,
      reviewerId: "reviewer",
      result: "pass",
      evidenceIds: allCurrentEvidenceIds(mutant.core, "visual"),
      ...guard(mutant.core)
    });
  });
});

test("C8 reviewer write receipt invalidates the current review decision", () => {
  const setup = (disabledChecks: HardCheck[] = []) => {
    const core = makeCore([], disabledChecks);
    const mandate = codeItemReadyForReview(core, "code");
    codeEvidence(core, "code");
    evidence(core, "code", { kind: "artifact", receipt: { write: true, path: "src/implementation.ts" } });
    return { core, mandate };
  };
  const normal = setup();
  const rejected = normal.core.submitReview({
    workItemId: "code", mandateId: normal.mandate.id, attempt: 1, reviewerId: "reviewer", result: "pass",
    evidenceIds: allCurrentEvidenceIds(normal.core, "code"), ...guard(normal.core)
  });
  expectError(rejected, "REVIEWER_NOT_READONLY");
  mutationEscapes("reviewerReadonly", "REVIEWER_NOT_READONLY", () => {
    const mutant = setup(["reviewerReadonly"]);
    return mutant.core.submitReview({
      workItemId: "code", mandateId: mutant.mandate.id, attempt: 1, reviewerId: "reviewer", result: "pass",
      evidenceIds: allCurrentEvidenceIds(mutant.core, "code"), ...guard(mutant.core)
    });
  });
});

test("writer-produced self-pass evidence is not independent review evidence", () => {
  const setup = (disabledChecks: HardCheck[] = []) => {
    const core = makeCore([], disabledChecks);
    const mandate = codeItemReadyForReview(core, "code");
    codeEvidence(core, "code", "worker");
    return { core, mandate };
  };
  const normal = setup();
  const rejected = normal.core.submitReview({
    workItemId: "code", mandateId: normal.mandate.id, attempt: 1, reviewerId: "reviewer", result: "pass",
    evidenceIds: allCurrentEvidenceIds(normal.core, "code"), ...guard(normal.core)
  });
  expectError(rejected, "ACTOR_MISMATCH");
  mutationEscapes("actor", "ACTOR_MISMATCH", () => {
    const mutant = setup(["actor"]);
    return mutant.core.submitReview({
      workItemId: "code", mandateId: mutant.mandate.id, attempt: 1, reviewerId: "reviewer", result: "pass",
      evidenceIds: allCurrentEvidenceIds(mutant.core, "code"), ...guard(mutant.core)
    });
  });
});

test("C9 numeric reconciliation needs equal actual values in the same scope", () => {
  const setup = (disabledChecks: HardCheck[] = [], receipt: Record<string, import("../../src/core/index.ts").JsonValue> = {
    leftValue: 162, rightValue: 162, leftScope: "session-A/week", rightScope: "all-sessions/week", delta: 0
  }) => {
    const core = makeCore([], disabledChecks);
    const mandate = codeItemReadyForReview(core, "numbers", "numeric_reconcile");
    evidence(core, "numbers", { kind: "numeric_reconcile", receipt });
    return { core, mandate };
  };
  const normal = setup();
  assert.equal(normal.core.evaluateGate("numbers").result, "unknown");
  assert.ok(normal.core.evaluateGate("numbers").reasons.includes("EVIDENCE_UNKNOWN"));
  const mutant = setup(["evidence"]);
  assert.throws(() => assert.equal(mutant.core.evaluateGate("numbers").result, "unknown"));
  assert.equal(mutant.core.evaluateGate("numbers").result, "pass");

  const formulaOnly = setup([], { formulaPresent: true });
  assert.equal(formulaOnly.core.evaluateGate("numbers").result, "unknown");
  const formulaMutant = setup(["evidence"], { formulaPresent: true });
  assert.throws(() => assert.equal(formulaMutant.core.evaluateGate("numbers").result, "unknown"));
});

test("C10 source/build/loaded hash mismatches fail deployment", () => {
  const setup = (disabledChecks: HardCheck[] = [], loadedHash = "build-hash") => {
    const core = makeCore([], disabledChecks);
    codeItemReadyForReview(core, "deploy", "deployment");
    evidence(core, "deploy", { kind: "source_hash", receipt: { hash: "source-hash" } });
    evidence(core, "deploy", { kind: "build_hash", receipt: { hash: "different-build" } });
    evidence(core, "deploy", { kind: "loaded_hash", receipt: { hash: loadedHash } });
    evidence(core, "deploy", { kind: "host_receipt", sourceActor: "host", sourceRole: "host", receipt: { application: "applied" } });
    return core;
  };
  const normal = setup();
  assert.equal(normal.evaluateGate("deploy").result, "fail");
  assert.ok(normal.evaluateGate("deploy").reasons.includes("SOURCE_ARTIFACT_MISMATCH"));
  const mutant = setup(["deploymentHash"]);
  assert.throws(() => assert.equal(mutant.evaluateGate("deploy").result, "fail"));
  assert.equal(mutant.evaluateGate("deploy").result, "pass");

  const loaded = setup([], "stale-loaded");
  assert.equal(loaded.evaluateGate("deploy").result, "fail");
  assert.ok(loaded.evaluateGate("deploy").reasons.includes("RUNTIME_HASH_MISMATCH"));
  const loadedMutant = setup(["deploymentHash"], "stale-loaded");
  assert.throws(() => assert.equal(loadedMutant.evaluateGate("deploy").result, "fail"));
  assert.equal(loadedMutant.evaluateGate("deploy").result, "pass");
});

test("C11 restart-required/unmanaged host receipt is not deployed", () => {
  const setup = (disabledChecks: HardCheck[] = []) => {
    const core = makeCore([], disabledChecks);
    codeItemReadyForReview(core, "deploy", "deployment");
    for (const kind of ["source_hash", "build_hash", "loaded_hash"] as const) {
      evidence(core, "deploy", { kind, receipt: { hash: "same-hash" } });
    }
    evidence(core, "deploy", { kind: "host_receipt", sourceActor: "host", sourceRole: "host", receipt: { application: "restart-required", restartReason: "unmanaged-plugin" } });
    return core;
  };
  const normal = setup();
  assert.equal(normal.evaluateGate("deploy").result, "fail");
  assert.ok(normal.evaluateGate("deploy").reasons.includes("RESTART_REQUIRED"));
  const mutant = setup(["hostReceipt"]);
  assert.throws(() => assert.equal(mutant.evaluateGate("deploy").result, "fail"));
  assert.equal(mutant.evaluateGate("deploy").result, "pass");
});

test("C14 activity plus no_activity projection is a host data-contract failure", () => {
  const setup = (disabledChecks: HardCheck[] = []) => {
    const core = makeCore([], disabledChecks);
    plan(core, itemInput("projection", { hostContractRequired: true }));
    const mandate = running(core, "projection");
    report(core, mandate);
    codeEvidence(core, "projection");
    evidence(core, "projection", {
      kind: "host_contract", sourceActor: "host", sourceRole: "host",
      receipt: { activityCount: 67, emptyReason: "no_activity" }
    });
    return core;
  };
  const normal = setup();
  assert.equal(normal.evaluateGate("projection").result, "fail");
  assert.ok(normal.evaluateGate("projection").reasons.includes("HOST_CONTRACT_UNKNOWN"));
  const mutant = setup(["hostProjection"]);
  assert.throws(() => assert.equal(mutant.evaluateGate("projection").result, "fail"));
  assert.equal(mutant.evaluateGate("projection").result, "pass");
});

test("C15 partial/substitute/unknown mandatory coverage cannot complete without waiver", () => {
  const levels: CoverageStatus[] = ["partial", "substitute", "unknown"];
  const setup = (disabledChecks: HardCheck[] = []) => {
    const core = makeCore(levels.map(level => ({
      id: "coverage-" + level,
      kind: "coverage",
      text: "mandatory source " + level,
      coverage: level,
      sourceId: "source-" + level
    })), disabledChecks);
    plan(core, itemInput("coverage", { gateProfile: "coverage", obligationIds: levels.map(level => "coverage-" + level) }));
    const mandate = running(core, "coverage");
    report(core, mandate);
    for (const level of levels) {
      evidence(core, "coverage", {
        kind: "coverage",
        sourceActor: "host",
        sourceRole: "host",
        receipt: { obligationId: "coverage-" + level, sourceId: "source-" + level, coverage: level }
      });
    }
    return core;
  };
  const normal = setup();
  assert.equal(normal.evaluateGate("coverage").result, "fail");
  assert.ok(normal.evaluateGate("coverage").reasons.includes("COVERAGE_INCOMPLETE"));
  expectError(normal.completeRun(guard(normal)), "COVERAGE_INCOMPLETE");
  mutationEscapes("coverage", "COVERAGE_INCOMPLETE", () => {
    const mutant = setup(["coverage"]);
    const current = state(mutant).workItems.coverage;
    must(mutant.submitReview({
      workItemId: "coverage", mandateId: current.currentMandateId ?? "", attempt: current.attempt,
      reviewerId: "reviewer", result: "pass", evidenceIds: allCurrentEvidenceIds(mutant, "coverage"), ...guard(mutant)
    }));
    must(mutant.releaseWorkItem({ workItemId: "coverage", reviewerId: "reviewer", ...guard(mutant) }));
    return mutant.completeRun(guard(mutant));
  });
});

test("coverage requires independent evidence even without requiredEvidence", () => {
  const setup = (disabledChecks: HardCheck[] = []) => {
    const core = makeCore([{ id: "duty", kind: "coverage", text: "independently observed behavior", coverage: "unknown" }], disabledChecks);
    plan(core, itemInput("coverage", { gateProfile: "coverage", obligationIds: ["duty"] }));
    const mandate = running(core, "coverage");
    report(core, mandate);
    evidence(core, "coverage", {
      kind: "coverage", sourceActor: "worker", sourceRole: "worker",
      receipt: { obligationId: "duty", coverage: "full" }
    });
    return core;
  };
  const normal = setup();
  assert.equal(normal.evaluateGate("coverage").result, "fail");
  assert.ok(normal.evaluateGate("coverage").reasons.includes("ACTOR_MISMATCH"));
  const current = state(normal).workItems.coverage;
  const review = {
    workItemId: "coverage", mandateId: current.currentMandateId ?? "", attempt: current.attempt,
    reviewerId: "reviewer", result: "pass" as const, evidenceIds: allCurrentEvidenceIds(normal, "coverage")
  };
  expectError(normal.submitReview({ ...review, ...guard(normal) }), "ACTOR_MISMATCH");
  mutationEscapes("actor", "ACTOR_MISMATCH", () => {
    const mutant = setup(["actor"]);
    const item = state(mutant).workItems.coverage;
    return mutant.submitReview({
      workItemId: "coverage", mandateId: item.currentMandateId ?? "", attempt: item.attempt,
      reviewerId: "reviewer", result: "pass", evidenceIds: allCurrentEvidenceIds(mutant, "coverage"), ...guard(mutant)
    });
  });

  evidence(normal, "coverage", { kind: "coverage", receipt: { obligationId: "duty", coverage: "full" } });
  submitPass(normal, "coverage");
  assert.equal(must(normal.releaseWorkItem({ workItemId: "coverage", reviewerId: "reviewer", ...guard(normal) })).status, "accepted");
  assert.equal(state(normal).obligations.duty.status, "met");
});

test("mandate_delivery coverage requires exact host verification and cannot launder unrelated obligations", () => {
  const ready = (obligations: Parameters<typeof makeCore>[0]) => {
    const core = makeCore(obligations);
    plan(core, itemInput("coverage", {
      gateProfile: "coverage",
      obligationIds: (obligations ?? []).map(obligation => obligation.id)
    }));
    const mandate = running(core, "coverage");
    report(core, mandate);
    return core;
  };
  const unrelated = ready([{ id: "stale-stop", kind: "coverage", text: "stop on stale instructions", coverage: "unknown" }]);
  const unrelatedEvidence = evidence(unrelated, "coverage", {
    kind: "coverage", sourceActor: "host", sourceRole: "host",
    receipt: { obligationId: "stale-stop", coverage: "full", verification: "mandate_delivery" }
  });
  const unrelatedItem = state(unrelated).workItems.coverage;
  expectError(unrelated.submitReview({
    workItemId: "coverage", mandateId: unrelatedItem.currentMandateId ?? "", attempt: unrelatedItem.attempt,
    reviewerId: "reviewer", result: "pass", evidenceIds: [unrelatedEvidence.id], ...guard(unrelated)
  }), "EVIDENCE_VERIFICATION_MISMATCH");
  assert.notEqual(state(unrelated).workItems.coverage.status, "accepted");

  const modeled = ready([{ id: "delivery", kind: "coverage", text: "verify actual delivery", coverage: "unknown", verification: "mandate_delivery" }]);
  const modeledEvidence = evidence(modeled, "coverage", {
    kind: "coverage", receipt: { obligationId: "delivery", coverage: "full", verification: "mandate_delivery" }
  });
  const modeledItem = state(modeled).workItems.coverage;
  expectError(modeled.submitReview({
    workItemId: "coverage", mandateId: modeledItem.currentMandateId ?? "", attempt: modeledItem.attempt,
    reviewerId: "reviewer", result: "pass", evidenceIds: [modeledEvidence.id], ...guard(modeled)
  }), "ACTOR_MISMATCH");
  assert.notEqual(state(modeled).workItems.coverage.status, "accepted");

  const valid = ready([
    { id: "stale-stop", kind: "coverage", text: "independently review stale instruction behavior", coverage: "unknown" },
    { id: "delivery", kind: "coverage", text: "verify actual delivery", coverage: "unknown", verification: "mandate_delivery" }
  ]);
  evidence(valid, "coverage", {
    kind: "coverage", sourceActor: "host", sourceRole: "host",
    receipt: { obligationId: "delivery", coverage: "full", verification: "mandate_delivery" }
  });
  evidence(valid, "coverage", { kind: "coverage", receipt: { obligationId: "stale-stop", coverage: "full" } });
  submitPass(valid, "coverage");
  assert.equal(must(valid.releaseWorkItem({ workItemId: "coverage", reviewerId: "reviewer", ...guard(valid) })).status, "accepted");
  assert.equal(state(valid).obligations.delivery.status, "met");
  assert.equal(state(valid).obligations["stale-stop"].status, "met");
});

test("release revalidates reviewer read-only after a passing decision", () => {
  const setup = (disabledChecks: HardCheck[] = []) => {
    const core = makeCore([], disabledChecks);
    codeItemReadyForReview(core, "code");
    codeEvidence(core, "code");
    submitPass(core, "code");
    evidence(core, "code", { kind: "artifact", receipt: { operation: "write", path: "src/late-change.ts" } });
    return core;
  };
  const normal = setup();
  expectError(normal.releaseWorkItem({ workItemId: "code", reviewerId: "reviewer", ...guard(normal) }), "REVIEWER_NOT_READONLY");
  assert.equal(state(normal).workItems.code.status, "verifying");
  mutationEscapes("reviewerReadonly", "REVIEWER_NOT_READONLY", () => {
    const mutant = setup(["reviewerReadonly"]);
    return mutant.releaseWorkItem({ workItemId: "code", reviewerId: "reviewer", ...guard(mutant) });
  });
});
