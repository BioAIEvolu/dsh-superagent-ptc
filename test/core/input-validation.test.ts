import test from "node:test";
import assert from "node:assert/strict";
import type {
  ApplyUserInstructionInput,
  CoreResult,
  CreateRunInput,
  PlanWorkItemsInput,
  PrepareMandateInput,
  ReconcileRecoveryInput,
  RecordEvidenceInput,
  RecordUserFeedbackInput,
  SubmitReviewInput,
  WriteGuard
} from "../../src/core/index.ts";
import {
  expectError,
  guard,
  itemInput,
  makeCore,
  makeEmptyCore,
  plan,
  proofFor,
  report,
  running,
  state
} from "./helpers.ts";

function atomicFailure<T>(core: ReturnType<typeof makeCore>, before: ReturnType<typeof state>, result: CoreResult<T>, code = "INVALID_INPUT"): void {
  expectError(result, code);
  assert.deepEqual(state(core), before);
  assert.equal(result.events.length, 0);
}

test("Kimi live WorkItem missing dependencies/obligationIds/gateProfile returns structured atomic error", () => {
  const core = makeCore();
  const before = state(core);
  const liveInput = {
    items: [{
      id: "live-visual-fix",
      title: "修复真实界面",
      writeScopes: ["src/client"],
      acceptance: ["真实界面可见"]
    }],
    ...guard(core)
  };
  const result = core.planWorkItems(liveInput as unknown as PlanWorkItemsInput);
  atomicFailure(core, before, result);
});

test("dependsOn misuse and malformed WorkItem shapes never reach dependency traversal", () => {
  const core = makeCore();
  const before = state(core);
  const valid = itemInput("a");
  const variants: unknown[] = [
    null,
    {},
    { items: [] },
    { items: [null] },
    { items: [{ ...valid, dependencies: undefined, dependsOn: [] }] },
    { items: [{ ...valid, dependencies: "a" }] },
    { items: [{ ...valid, writeScopes: null }] },
    { items: [{ ...valid, obligationIds: [1] }] },
    { items: [{ ...valid, acceptance: [] }] },
    { items: [{ ...valid, acceptance: ["ok", 3] }] },
    { items: [{ ...valid, gateProfile: "unknown" }] },
    { items: [{ ...valid, mandatory: "yes" }] },
    { items: [{ ...valid, hostContractRequired: 1 }] },
    { items: [{ ...valid, id: "" }] },
    { items: [{ ...valid, title: "x".repeat(5000) }] }
  ];
  for (const variant of variants) {
    const input = isObject(variant) ? { ...variant, ...guard(core) } : variant;
    const result = core.planWorkItems(input as PlanWorkItemsInput);
    atomicFailure(core, before, result);
  }
});

test("obligationDelta malformed objects, ops, patches and replacements are atomic structured failures", () => {
  const core = makeCore([{ id: "duty", kind: "requirement", text: "valid duty" }]);
  const before = state(core);
  const variants: unknown[] = [
    null,
    {},
    { obligationDelta: null },
    { obligationDelta: [null] },
    { obligationDelta: [{ op: "unknown" }] },
    { obligationDelta: [{ op: "add" }] },
    { obligationDelta: [{ op: "add", obligation: null }] },
    { obligationDelta: [{ op: "amend", id: "duty" }] },
    { obligationDelta: [{ op: "amend", id: "duty", patch: null }] },
    { obligationDelta: [{ op: "supersede", id: "duty", replacement: null }] }
  ];
  for (const variant of variants) {
    const input = {
      runId: before.run.id,
      instruction: "malformed but non-empty instruction",
      ...(isObject(variant) ? variant : {}),
      ...guard(core)
    };
    if (variant === null) {
      const result = core.applyUserInstruction(null as unknown as ApplyUserInstructionInput);
      atomicFailure(core, before, result);
    } else {
      const result = core.applyUserInstruction(input as ApplyUserInstructionInput);
      atomicFailure(core, before, result);
    }
  }
});

test("public write APIs reject missing arrays, invalid receipts and malformed guards without TypeError", () => {
  const core = makeCore();
  plan(core, itemInput("a"));
  const mandate = running(core, "a");
  report(core, mandate);
  plan(core, itemInput("b"));

  let before = state(core);
  atomicFailure(core, before, core.prepareMandate({
    workItemId: "b", workerId: "worker", reviewerId: "reviewer", knownFailures: undefined, ...guard(core)
  } as unknown as PrepareMandateInput));

  const evidenceBase = {
    workItemId: "a", mandateId: mandate.id, attempt: 1, kind: "build", result: "pass",
    sourceActor: "reviewer", sourceRole: "reviewer", receipt: { exitCode: 0 }
  };
  atomicFailure(core, before, core.recordEvidence({
    ...evidenceBase, receipt: undefined, ...guard(core)
  } as unknown as RecordEvidenceInput), "INVALID_TRANSITION");
  atomicFailure(core, before, core.recordEvidence({
    ...evidenceBase, receipt: [], ...guard(core)
  } as unknown as RecordEvidenceInput), "INVALID_TRANSITION");
  atomicFailure(core, before, core.recordEvidence({
    ...evidenceBase, kind: "unknown", ...guard(core)
  } as unknown as RecordEvidenceInput));
  atomicFailure(core, before, core.submitReview({
    workItemId: "a", mandateId: mandate.id, attempt: 1, reviewerId: "reviewer", result: "pass",
    evidenceIds: undefined, ...guard(core)
  } as unknown as SubmitReviewInput));
  atomicFailure(core, before, core.recordUserFeedback({
    workItemId: "a", verdict: "rejected", note: { text: "bad" }, fingerprint: "bad", ...guard(core)
  } as unknown as RecordUserFeedbackInput));
  atomicFailure(core, before, core.reconcileRecovery({
    nativeReceipts: null, ...guard(core)
  } as unknown as ReconcileRecoveryInput));
  atomicFailure(core, before, core.pauseRun(null as unknown as WriteGuard));

  const saved = state(core);
  const fresh = makeEmptyCore();
  const restored = fresh.restoreSnapshot(saved, null as unknown as [], proofFor(saved));
  expectError(restored, "INVALID_INPUT");
  assert.equal(fresh.snapshot(), null);
  before = state(core);
  assert.deepEqual(state(core), before);
});

test("createRun malformed input and obligations return errors without creating state", () => {
  const nullCore = makeEmptyCore();
  const nullResult = nullCore.createRun(null as unknown as CreateRunInput);
  expectError(nullResult, "INVALID_INPUT");
  assert.equal(nullCore.snapshot(), null);

  const core = makeEmptyCore();
  const result = core.createRun({
    sessionId: "session", objective: "objective", definitionOfDone: "done", obligations: null
  } as unknown as CreateRunInput);
  expectError(result, "INVALID_INPUT");
  assert.equal(core.snapshot(), null);
});

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
