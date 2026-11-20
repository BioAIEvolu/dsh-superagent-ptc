import test from "node:test";
import assert from "node:assert/strict";
import { SuperAgentCore } from "../../src/core/index.ts";
import type { CoreResult, GateDecision, HardCheck, WorkItem } from "../../src/core/index.ts";
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
  prepare,
  proofFor,
  report,
  running,
  snapshotDigest,
  state,
  submitPass
} from "./helpers.ts";

function passReview(core: SuperAgentCore, id: string): CoreResult<GateDecision> {
  const item = state(core).workItems[id];
  return core.submitReview({
    workItemId: id,
    mandateId: item.currentMandateId ?? "",
    attempt: item.attempt,
    reviewerId: "reviewer",
    result: "pass",
    evidenceIds: allCurrentEvidenceIds(core, id),
    ...guard(core)
  });
}

function release(core: SuperAgentCore, id: string): CoreResult<WorkItem> {
  return core.releaseWorkItem({ workItemId: id, reviewerId: "reviewer", ...guard(core) });
}

test("P0-1 rejected attempt can never be re-reviewed or released with old evidence", () => {
  const setup = (disabledChecks: HardCheck[] = []) => {
    const core = makeCore([], disabledChecks);
    plan(core, itemInput("a"));
    const mandate = running(core, "a");
    report(core, mandate);
    codeEvidence(core, "a");
    submitPass(core, "a");
    must(core.recordUserFeedback({
      workItemId: "a", verdict: "rejected", note: "wrong output", fingerprint: "wrong-output", ...guard(core)
    }));
    return { core, mandate };
  };
  const normal = setup();
  const before = state(normal.core);
  expectError(passReview(normal.core, "a"), "INVALID_TRANSITION");
  expectError(release(normal.core, "a"), "INVALID_TRANSITION");
  assert.deepEqual(state(normal.core), before);
  mutationEscapes("reviewState", "INVALID_TRANSITION", () => {
    const mutant = setup(["reviewState"]);
    return passReview(mutant.core, "a");
  });
  const mutant = setup(["reviewState"]);
  submitPass(mutant.core, "a");
  assert.equal(must(release(mutant.core, "a")).status, "accepted");
});

test("P0-1b running execution cannot skip worker reported_done review precursor", () => {
  const setup = (disabledChecks: HardCheck[] = []) => {
    const core = makeCore([], disabledChecks);
    plan(core, itemInput("a"));
    running(core, "a");
    codeEvidence(core, "a");
    return core;
  };
  const normal = setup();
  expectError(passReview(normal, "a"), "INVALID_TRANSITION");
  expectError(release(normal, "a"), "INVALID_TRANSITION");
  assert.equal(state(normal).audit.some(event => event.type === "worker.reported_done"), false);
  mutationEscapes("reviewState", "INVALID_TRANSITION", () => passReview(setup(["reviewState"]), "a"));
  const mutant = setup(["reviewState"]);
  submitPass(mutant, "a");
  assert.equal(must(release(mutant, "a")).status, "accepted");
});

test("P0-2 rejecting an accepted dependency revokes the transitive successor and blocks completion", () => {
  const setup = (disabledChecks: HardCheck[] = []) => {
    const core = makeCore([], disabledChecks);
    plan(core, [
      itemInput("a", { mandatory: false }),
      itemInput("b", { dependencies: ["a"], writeScopes: ["src/b"] }),
      itemInput("c", { dependencies: ["b"], writeScopes: ["src/c"], mandatory: false })
    ]);
    const first = running(core, "a");
    report(core, first);
    codeEvidence(core, "a");
    submitPass(core, "a");
    must(release(core, "a"));
    const second = running(core, "b");
    report(core, second);
    codeEvidence(core, "b");
    must(core.recordUserFeedback({
      workItemId: "a", verdict: "rejected", note: "bad dependency", fingerprint: "bad-dependency", ...guard(core)
    }));
    return core;
  };
  const normal = setup();
  assert.equal(state(normal).workItems.a.status, "rework");
  assert.equal(state(normal).workItems.b.status, "superseded");
  assert.equal(state(normal).workItems.c.status, "superseded");
  expectError(passReview(normal, "b"), "INVALID_TRANSITION");
  expectError(release(normal, "b"), "INVALID_TRANSITION");
  expectError(normal.completeRun(guard(normal)), "UNACCEPTED_ITEMS");
  mutationEscapes("dependency", "UNACCEPTED_ITEMS", () => {
    const mutant = setup(["dependency"]);
    submitPass(mutant, "b");
    must(release(mutant, "b"));
    return mutant.completeRun(guard(mutant));
  });
});

test("P0-2b rejection reopens obligations previously met by the revoked item", () => {
  const setup = (disabledChecks: HardCheck[] = []) => {
    const core = makeCore([{ id: "duty", kind: "requirement", text: "accepted output duty" }], disabledChecks);
    plan(core, itemInput("a", { obligationIds: ["duty"] }));
    const mandate = running(core, "a");
    report(core, mandate);
    codeEvidence(core, "a");
    submitPass(core, "a");
    must(release(core, "a"));
    must(core.recordUserFeedback({ workItemId: "a", verdict: "rejected", fingerprint: "bad", note: "bad", ...guard(core) }));
    return core;
  };
  const normal = setup();
  assert.equal(state(normal).obligations.duty.status, "open");
  expectError(normal.completeRun(guard(normal)), "OPEN_OBLIGATIONS");
  mutationEscapes("completion", "OPEN_OBLIGATIONS", () => {
    const mutant = setup(["completion"]);
    return mutant.completeRun(guard(mutant));
  });
});

test("P0-3 a valid violation on any nonmandatory item blocks the whole Run", () => {
  const setup = (disabledChecks: HardCheck[] = []) => {
    const core = makeCore([{ id: "no-glow", kind: "prohibition", text: "never add glow" }], disabledChecks);
    plan(core, [
      itemInput("main", { obligationIds: ["no-glow"] }),
      itemInput("observation", { mandatory: false })
    ]);
    const main = running(core, "main");
    report(core, main);
    codeEvidence(core, "main");
    submitPass(core, "main");
    must(release(core, "main"));
    const observation = running(core, "observation");
    report(core, observation);
    evidence(core, "observation", { kind: "runtime_gui", receipt: { obligationId: "no-glow", violated: true, observed: "drop-shadow" } });
    return core;
  };
  const normal = setup();
  assert.equal(normal.evaluateGate("main").result, "fail");
  expectError(normal.completeRun(guard(normal)), "PROHIBITION_VIOLATED");
  mutationEscapes("prohibition", "PROHIBITION_VIOLATED", () => {
    const mutant = setup(["prohibition"]);
    return mutant.completeRun(guard(mutant));
  });
});

test("P1-1 evidence must come from the mandated reviewer or a host-observed receipt", () => {
  const thirdParty = makeCore();
  plan(thirdParty, itemInput("a"));
  const thirdMandate = running(thirdParty, "a");
  report(thirdParty, thirdMandate);
  evidence(thirdParty, "a", { kind: "build", sourceActor: "unrelated-third-party", sourceRole: "reviewer", receipt: { exitCode: 0 } });
  evidence(thirdParty, "a", { kind: "unit", sourceActor: "unrelated-third-party", sourceRole: "reviewer", receipt: { passed: 1, failed: 0 } });
  expectError(passReview(thirdParty, "a"), "ACTOR_MISMATCH");
  mutationEscapes("actor", "ACTOR_MISMATCH", () => {
    const mutant = makeCore([], ["actor"]);
    plan(mutant, itemInput("a"));
    const mandate = running(mutant, "a");
    report(mutant, mandate);
    evidence(mutant, "a", { kind: "build", sourceActor: "unrelated-third-party", sourceRole: "reviewer", receipt: { exitCode: 0 } });
    evidence(mutant, "a", { kind: "unit", sourceActor: "unrelated-third-party", sourceRole: "reviewer", receipt: { passed: 1, failed: 0 } });
    return passReview(mutant, "a");
  });

  const host = makeCore();
  plan(host, itemInput("a"));
  const mandate = running(host, "a");
  report(host, mandate);
  evidence(host, "a", { kind: "build", sourceActor: "host-unverified", sourceRole: "host", receipt: { exitCode: 0, hostObserved: false } });
  evidence(host, "a", { kind: "unit", sourceActor: "host-unverified", sourceRole: "host", receipt: { passed: 1, failed: 0, hostObserved: false } });
  expectError(passReview(host, "a"), "ACTOR_MISMATCH");
  mutationEscapes("actor", "ACTOR_MISMATCH", () => {
    const mutant = makeCore([], ["actor"]);
    plan(mutant, itemInput("a"));
    const bound = running(mutant, "a");
    report(mutant, bound);
    evidence(mutant, "a", { kind: "build", sourceActor: "host-unverified", sourceRole: "host", receipt: { exitCode: 0, hostObserved: false } });
    evidence(mutant, "a", { kind: "unit", sourceActor: "host-unverified", sourceRole: "host", receipt: { passed: 1, failed: 0, hostObserved: false } });
    return passReview(mutant, "a");
  });
});

test("P1-2 production constructor ignores foreign disabledChecks and cannot disable completion", () => {
  let sequence = 0;
  const drivers = {
    createId: (kind: string) => kind + "-" + ++sequence,
    now: () => "2026-11-18T03:00:00.000Z",
    digestSnapshot: snapshotDigest,
    disabledChecks: ["completion"]
  };
  const production = new SuperAgentCore(drivers);
  must(production.createRun({
    sessionId: "production", objective: "safe completion", definitionOfDone: "duties met",
    obligations: [{ id: "open-duty", kind: "requirement", text: "must remain open" }]
  }));
  expectError(production.completeRun(guard(production)), "OPEN_OBLIGATIONS");
  mutationEscapes("completion", "OPEN_OBLIGATIONS", () => {
    const mutant = makeCore([{ id: "open-duty", kind: "requirement", text: "must remain open" }], ["completion"]);
    return mutant.completeRun(guard(mutant));
  });
});

test("P1-3 restoreSnapshot deep-validates, restores and immediately reconciles generation", () => {
  const original = makeCore([{ id: "duty", kind: "requirement", text: "persist me" }]);
  plan(original, itemInput("a"));
  running(original, "a");
  const saved = state(original);
  const fresh = makeCore();
  const emptyDrivers = {
    createId: (kind: string) => "restored-" + kind,
    now: () => "2026-11-18T03:01:00.000Z",
    digestSnapshot: snapshotDigest
  };
  const restored = new SuperAgentCore(emptyDrivers);
  const recovered = must(restored.restoreSnapshot(saved, [], proofFor(saved)));
  assert.equal(recovered.generation, saved.run.generation + 1);
  assert.equal(recovered.unknownMandateIds.length, 1);
  assert.equal(state(restored).schemaVersion, 2);
  assert.equal(state(restored).run.revision, saved.run.revision + 1);
  assert.equal(state(restored).audit.at(-1)?.type, "run.recovered");
  assert.equal(state(restored).workItems.a.status, "verifying");
  void fresh;

  const corrupted = structuredClone(saved);
  corrupted.audit[0].revision = 99;
  const reject = new SuperAgentCore(emptyDrivers).restoreSnapshot(corrupted, [], proofFor(corrupted));
  expectError(reject, "SNAPSHOT_INVALID");
  mutationEscapes("restore", "SNAPSHOT_INVALID", () => {
    const mutant = makeEmptyCore(["restore"]);
    return mutant.restoreSnapshot(corrupted, [], proofFor(corrupted));
  });
});

test("P1-4 old-generation running mandate cannot report done after recovery", () => {
  const setup = (disabledChecks: HardCheck[] = []) => {
    const core = makeCore([], disabledChecks);
    plan(core, itemInput("a"));
    const mandate = running(core, "a");
    must(core.reconcileRecovery({ nativeReceipts: [{ mandateId: mandate.id, status: "running" }], ...guard(core) }));
    return { core, mandate };
  };
  const normal = setup();
  expectError(normal.core.reportWorkerDone({
    mandateId: normal.mandate.id, workerId: "worker", summary: "late report", ...guard(normal.core)
  }), "STALE_GENERATION");
  mutationEscapes("generation", "STALE_GENERATION", () => {
    const mutant = setup(["generation"]);
    return mutant.core.reportWorkerDone({ mandateId: mutant.mandate.id, workerId: "worker", summary: "late report", ...guard(mutant.core) });
  });
});

test("P1-5 every unknown or mutating reviewer operation fails closed", () => {
  for (const operation of ["patch", "delete", "shell", "mystery", "WRITE"]) {
    const setup = (disabledChecks: HardCheck[] = []) => {
      const core = makeCore([], disabledChecks);
      plan(core, itemInput("a"));
      const mandate = running(core, "a");
      report(core, mandate);
      codeEvidence(core, "a");
      evidence(core, "a", { kind: "artifact", receipt: { operation, path: "src/product.ts" } });
      return core;
    };
    expectError(passReview(setup(), "a"), "REVIEWER_NOT_READONLY");
    mutationEscapes("reviewerReadonly", "REVIEWER_NOT_READONLY", () => passReview(setup(["reviewerReadonly"]), "a"));
  }
});

test("P1-6 coverage requires exact obligationId or nonempty exact sourceId", () => {
  const setup = (disabledChecks: HardCheck[] = []) => {
    const core = makeCore([
      { id: "source-a", kind: "coverage", text: "read A", coverage: "unknown" },
      { id: "source-b", kind: "coverage", text: "read B", coverage: "unknown" }
    ], disabledChecks);
    plan(core, itemInput("coverage", { gateProfile: "coverage", obligationIds: ["source-a", "source-b"] }));
    const mandate = running(core, "coverage");
    report(core, mandate);
    evidence(core, "coverage", { kind: "coverage", sourceActor: "host", sourceRole: "host", receipt: { coverage: "full" } });
    return core;
  };
  const normal = setup();
  assert.equal(normal.evaluateGate("coverage").result, "unknown");
  expectError(passReview(normal, "coverage"), "COVERAGE_INCOMPLETE");
  mutationEscapes("coverage", "COVERAGE_INCOMPLETE", () => passReview(setup(["coverage"]), "coverage"));

  const exact = makeCore([{ id: "source-a", kind: "coverage", text: "read A", sourceId: "repo-a", coverage: "unknown" }]);
  plan(exact, itemInput("coverage", { gateProfile: "coverage", obligationIds: ["source-a"] }));
  const mandate = running(exact, "coverage");
  report(exact, mandate);
  evidence(exact, "coverage", { kind: "coverage", sourceActor: "host", sourceRole: "host", receipt: { coverage: "full", sourceId: "repo-a" } });
  assert.equal(exact.evaluateGate("coverage").result, "pass");
});

test("P1-7 contradictory build/unit receipt fields cannot pass", () => {
  const setup = (disabledChecks: HardCheck[] = []) => {
    const core = makeCore([], disabledChecks);
    plan(core, itemInput("a"));
    const mandate = running(core, "a");
    report(core, mandate);
    evidence(core, "a", { kind: "build", receipt: { exitCode: 1 } });
    evidence(core, "a", { kind: "unit", receipt: { passed: 0, failed: 65 } });
    return core;
  };
  expectError(passReview(setup(), "a"), "EVIDENCE_FAIL");
  mutationEscapes("evidence", "EVIDENCE_FAIL", () => passReview(setup(["evidence"]), "a"));

  const missing = makeCore();
  plan(missing, itemInput("a"));
  const mandate = running(missing, "a");
  report(missing, mandate);
  evidence(missing, "a", { kind: "build", receipt: {} });
  evidence(missing, "a", { kind: "unit", receipt: { passed: 0, failed: 0 } });
  expectError(passReview(missing, "a"), "EVIDENCE_UNKNOWN");
  const mutant = makeCore([], ["evidence"]);
  plan(mutant, itemInput("a"));
  const mutantMandate = running(mutant, "a");
  report(mutant, mutantMandate);
  evidence(mutant, "a", { kind: "build", receipt: {} });
  evidence(mutant, "a", { kind: "unit", receipt: { passed: 0, failed: 0 } });
  mutationEscapes("evidence", "EVIDENCE_UNKNOWN", () => passReview(mutant, "a"));
});

test("P2-1 sensitive key variants never enter snapshots", () => {
  for (const key of ["access_token", "cookie", "Authorization", "private_key", "session_id"]) {
    const setup = (disabledChecks: HardCheck[] = []) => {
      const core = makeCore([], disabledChecks);
      plan(core, itemInput("a"));
      const mandate = running(core, "a");
      report(core, mandate);
      return core;
    };
    const normal = setup();
    const before = state(normal);
    const rejected = normal.recordEvidence({
      workItemId: "a", mandateId: before.workItems.a.currentMandateId ?? "", attempt: 1,
      kind: "artifact", result: "pass", sourceActor: "reviewer", sourceRole: "reviewer",
      receipt: { [key]: "synthetic-secret" }, ...guard(normal)
    });
    expectError(rejected, "INVALID_TRANSITION");
    assert.deepEqual(state(normal), before);
    mutationEscapes("receipt", "INVALID_TRANSITION", () => {
      const mutant = setup(["receipt"]);
      const current = state(mutant);
      return mutant.recordEvidence({
        workItemId: "a", mandateId: current.workItems.a.currentMandateId ?? "", attempt: 1,
        kind: "artifact", result: "pass", sourceActor: "reviewer", sourceRole: "reviewer",
        receipt: { [key]: "synthetic-secret" }, ...guard(mutant)
      });
    });
  }
});

test("P2-2 obligation deltas and all native IDs share text bounds", () => {
  const normal = makeCore();
  expectError(normal.applyUserInstruction({
    runId: state(normal).run.id, instruction: "invalid add",
    obligationDelta: [{ op: "add", obligation: { id: "", kind: "requirement", text: "" } }], ...guard(normal)
  }), "INVALID_TRANSITION");
  mutationEscapes("input", "INVALID_TRANSITION", () => {
    const mutant = makeCore([], ["input"]);
    return mutant.applyUserInstruction({
      runId: state(mutant).run.id, instruction: "invalid add",
      obligationDelta: [{ op: "add", obligation: { id: "", kind: "requirement", text: "" } }], ...guard(mutant)
    });
  });

  const amended = makeCore([{ id: "duty", kind: "requirement", text: "valid" }]);
  expectError(amended.applyUserInstruction({
    runId: state(amended).run.id, instruction: "invalid amend",
    obligationDelta: [{ op: "amend", id: "duty", patch: { text: "" } }], ...guard(amended)
  }), "INVALID_TRANSITION");
  mutationEscapes("input", "INVALID_TRANSITION", () => {
    const mutant = makeCore([{ id: "duty", kind: "requirement", text: "valid" }], ["input"]);
    return mutant.applyUserInstruction({
      runId: state(mutant).run.id, instruction: "invalid amend",
      obligationDelta: [{ op: "amend", id: "duty", patch: { text: "" } }], ...guard(mutant)
    });
  });

  const setup = (disabledChecks: HardCheck[] = []) => {
    const core = makeCore([], disabledChecks);
    plan(core, itemInput("a"));
    return { core, mandate: prepare(core, "a") };
  };
  const oversized = "x".repeat(5000);
  const execution = setup();
  expectError(execution.core.bindExecution({
    mandateId: execution.mandate.id, nativeTaskId: oversized, workerAgentId: oversized, ...guard(execution.core)
  }), "INVALID_TRANSITION");
  mutationEscapes("input", "INVALID_TRANSITION", () => {
    const mutant = setup(["input"]);
    return mutant.core.bindExecution({ mandateId: mutant.mandate.id, nativeTaskId: oversized, workerAgentId: oversized, ...guard(mutant.core) });
  });
  expectError(execution.core.bindReviewer({ mandateId: execution.mandate.id, reviewerAgentId: oversized, ...guard(execution.core) }), "INVALID_TRANSITION");
  mutationEscapes("input", "INVALID_TRANSITION", () => {
    const mutant = setup(["input"]);
    return mutant.core.bindReviewer({ mandateId: mutant.mandate.id, reviewerAgentId: oversized, ...guard(mutant.core) });
  });
});

test("bindReviewer stores only the native reviewer reference and enforces generation", () => {
  const core = makeCore();
  plan(core, itemInput("a"));
  const mandate = prepare(core, "a");
  const bound = must(core.bindReviewer({ mandateId: mandate.id, reviewerAgentId: "native-reviewer-session", ...guard(core) }));
  assert.equal(bound.reviewerAgentId, "native-reviewer-session");
  must(core.reconcileRecovery({ nativeReceipts: [], ...guard(core) }));
  expectError(core.bindReviewer({ mandateId: mandate.id, reviewerAgentId: "late-reviewer", ...guard(core) }), "STALE_GENERATION");
  const mutant = makeCore([], ["generation"]);
  plan(mutant, itemInput("a"));
  const old = prepare(mutant, "a");
  must(mutant.reconcileRecovery({ nativeReceipts: [], ...guard(mutant) }));
  mutationEscapes("generation", "STALE_GENERATION", () => mutant.bindReviewer({ mandateId: old.id, reviewerAgentId: "late-reviewer", ...guard(mutant) }));
});
