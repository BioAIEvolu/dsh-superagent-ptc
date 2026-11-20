import test from "node:test";
import assert from "node:assert/strict";
import type {
  ModelFailureKind,
  ModelPolicy,
  ModelRoute,
  RecordRouteFailureInput,
  SetModelPolicyInput,
  SwitchMandateRouteInput
} from "../../src/core/index.ts";
import {
  codeEvidence,
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

const alpha: ModelRoute = { provider: "ark", model: "model-alpha", reasoningEffort: "high" };
const beta: ModelRoute = { provider: "ark", model: "model-beta", reasoningEffort: "low" };

function policy(overrides: Partial<Omit<ModelPolicy, "revision">> = {}): Omit<ModelPolicy, "revision"> {
  return {
    mode: "balanced",
    allowedRoutes: [alpha, beta],
    workerRoute: alpha,
    reviewerRoute: alpha,
    allowFailureSwitch: true,
    maxSameRouteRetries: 1,
    maxRouteSwitches: 1,
    ...overrides
  };
}

function setPolicy(core: ReturnType<typeof makeCore>, value = policy()): ModelPolicy {
  return must(core.setModelPolicy({ policy: value, ...guard(core) }));
}

function failure(core: ReturnType<typeof makeCore>, mandateId: string, failureKind: ModelFailureKind, retrySameRoute = false, failureCode = failureKind) {
  const input: RecordRouteFailureInput = { mandateId, failureKind, failureCode, retrySameRoute, ...guard(core) };
  return must(core.recordRouteFailure(input));
}

function switchRoute(core: ReturnType<typeof makeCore>, mandateId: string, failureCode = "quota") {
  const input: SwitchMandateRouteInput = {
    mandateId, targetRole: "worker", to: beta, failureCode, reason: "authorized bounded provider failover", ...guard(core)
  };
  return must(core.switchMandateRoute(input));
}

test("default no-policy behavior keeps null inherited routes and native standard reviewer", () => {
  const core = makeCore();
  plan(core, itemInput("a"));
  const mandate = prepare(core, "a");
  assert.equal(mandate.workerRoute, null);
  assert.equal(mandate.reviewerRoute, null);
  assert.equal(mandate.policyRevision, 0);
  assert.deepEqual(mandate.routeSwitches, []);
  assert.match(mandate.mandateText, /native standard tool preset/);
  assert.equal(state(core).run.modelPolicy, null);
  assert.deepEqual(state(core).routeFailures, {});
  must(core.bindExecution({ mandateId: mandate.id, ...guard(core) }));
  report(core, mandate);
  codeEvidence(core, "a");
  submitPass(core, "a");
  assert.equal(must(core.releaseWorkItem({ workItemId: "a", reviewerId: "reviewer", ...guard(core) })).status, "accepted");
});

test("policy pins both Mandate routes and records immutable policy revision and route reason", () => {
  const core = makeCore();
  const configured = setPolicy(core);
  assert.equal(configured.revision, 1);
  plan(core, itemInput("a"));
  const mandate = prepare(core, "a");
  assert.deepEqual(mandate.workerRoute, alpha);
  assert.deepEqual(mandate.reviewerRoute, alpha);
  assert.equal(mandate.policyRevision, 1);
  assert.equal(mandate.routeReason, "inherit current native model pool");
  assert.ok(mandate.mandateText.includes("ark/model-alpha/high"));
});

test("invalid policy, unauthorized locked routes, empty provider/model and negative budgets are rejected atomically", () => {
  const core = makeCore();
  const before = state(core);
  const invalid: { candidate: Omit<ModelPolicy, "revision">; code: string }[] = [
    { candidate: policy({ workerRoute: { provider: "", model: "missing-provider" } }), code: "INVALID_INPUT" },
    { candidate: policy({ maxSameRouteRetries: -1 }), code: "INVALID_INPUT" },
    { candidate: policy({ maxRouteSwitches: 1.5 }), code: "INVALID_INPUT" },
    { candidate: policy({ mode: "locked", allowedRoutes: [alpha], reviewerRoute: beta }), code: "ROUTE_NOT_ALLOWED" },
    { candidate: policy({ mode: "balanced", workerRoute: { provider: "unapproved", model: "rogue" } }), code: "ROUTE_NOT_ALLOWED" },
    { candidate: policy({ mode: "economy", allowedRoutes: [], workerRoute: alpha }), code: "ROUTE_NOT_ALLOWED" },
    { candidate: policy({ allowedRoutes: [alpha, alpha] }), code: "INVALID_INPUT" }
  ];
  for (const { candidate, code } of invalid) {
    const result = core.setModelPolicy({ policy: candidate, ...guard(core) });
    expectError(result, code);
    assert.deepEqual(state(core), before);
  }
  expectError(core.setModelPolicy({ policy: policy({ mode: "locked", allowedRoutes: [] }), ...guard(core) }), "INVALID_INPUT");
});

test("business, identity, proof, scope, tool and unknown failures never become route switches", () => {
  const core = makeCore();
  setPolicy(core);
  plan(core, itemInput("a"));
  const mandate = prepare(core, "a");
  const kinds: ModelFailureKind[] = ["business_acceptance", "identity", "snapshot_proof", "write_scope", "tool_input", "authentication", "permission", "unknown"];
  for (const kind of kinds) {
    const record = failure(core, mandate.id, kind, false);
    assert.equal(record.action, "rejected");
    const before = state(core);
    expectError(core.switchMandateRoute({
      mandateId: mandate.id, targetRole: "worker", to: beta, failureCode: kind, reason: "not allowed", ...guard(core)
    }), "ROUTE_FAILURE_REQUIRED");
    assert.deepEqual(state(core), before);
  }
});

test("same-route retry and route-switch budgets are independently bounded", () => {
  const core = makeCore();
  setPolicy(core);
  plan(core, itemInput("a"));
  const mandate = prepare(core, "a");
  const first = failure(core, mandate.id, "transient", true);
  assert.equal(first.action, "retry_recorded");
  const exhaustedRetry = failure(core, mandate.id, "transient", true);
  assert.equal(exhaustedRetry.action, "rejected");
  assert.equal(exhaustedRetry.sameRouteRetries, 1);
  assert.equal(state(core).run.status, "blocked");

  const quota = failure(core, mandate.id, "quota");
  assert.equal(quota.action, "switch_required");
  const switched = switchRoute(core, mandate.id);
  assert.equal(switched.status, "requested");
  assert.deepEqual(switched.from, alpha);
  assert.deepEqual(switched.to, beta);
  must(core.pauseRun(guard(core)));
  must(core.resumeRun(guard(core)));
  const exhaustedSwitch = failure(core, mandate.id, "quota");
  assert.equal(exhaustedSwitch.action, "rejected");
  assert.equal(exhaustedSwitch.routeSwitches, 1);
  expectError(core.switchMandateRoute({
    mandateId: mandate.id, targetRole: "worker", to: beta, failureCode: "quota",
    reason: "exhausted", ...guard(core)
  }), "ROUTE_BUDGET_EXHAUSTED");
});

test("switch is disabled by default and unauthorized target is rejected without changing Mandate", () => {
  const core = makeCore();
  setPolicy(core, policy({ allowFailureSwitch: false }));
  plan(core, itemInput("a"));
  const mandate = prepare(core, "a");
  const before = state(core);
  expectError(core.switchMandateRoute({
    mandateId: mandate.id, targetRole: "worker", to: beta, failureCode: "quota", reason: "not enabled", ...guard(core)
  }), "ROUTE_SWITCH_DISABLED");
  assert.deepEqual(state(core), before);

  const unauthorized = makeCore();
  setPolicy(unauthorized);
  plan(unauthorized, itemInput("a"));
  const second = prepare(unauthorized, "a");
  failure(unauthorized, second.id, "quota");
  const beforeUnauthorized = state(unauthorized);
  expectError(unauthorized.switchMandateRoute({
    mandateId: second.id, targetRole: "worker", to: { provider: "other", model: "not-allowed" },
    failureCode: "quota", reason: "not authorized", ...guard(unauthorized)
  }), "ROUTE_NOT_ALLOWED");
  assert.deepEqual(state(unauthorized), beforeUnauthorized);
});

test("routing mutation is isolated to test helpers and bypass proves the gate is real", () => {
  const mutant = makeCore([], ["routing"]);
  const invalidPolicy = { ...policy(), maxSameRouteRetries: -1 };
  mutationEscapes("routing", "INVALID_INPUT", () => mutant.setModelPolicy({ policy: invalidPolicy, ...guard(mutant) }));
});

test("switchable failure without a distinct authorized alternate records durable blocked no-route state", () => {
  const core = makeCore();
  setPolicy(core, policy({ allowedRoutes: [alpha] }));
  plan(core, itemInput("a"));
  const mandate = prepare(core, "a");
  const noRoute = failure(core, mandate.id, "quota");
  assert.equal(noRoute.action, "rejected");
  assert.equal(state(core).run.status, "blocked");
  assert.equal(state(core).routeFailures[noRoute.id].routeSwitches, 0);
  const before = state(core);
  expectError(core.switchMandateRoute({
    mandateId: mandate.id, targetRole: "worker", to: beta, failureCode: "quota",
    reason: "no authorized route exists", ...guard(core)
  }), "ROUTE_NOT_ALLOWED");
  assert.deepEqual(state(core), before);
});

test("policy, budgets and immutable route history survive SnapshotProof restore", () => {
  const core = makeCore();
  setPolicy(core);
  plan(core, itemInput("a"));
  const mandate = prepare(core, "a");
  failure(core, mandate.id, "quota");
  switchRoute(core, mandate.id);
  const saved = state(core);
  const restored = makeEmptyCore();
  must(restored.restoreSnapshot(saved, [], proofFor(saved)));
  assert.deepEqual(state(restored).run.modelPolicy, saved.run.modelPolicy);
  assert.deepEqual(state(restored).mandates[mandate.id], saved.mandates[mandate.id]);
  assert.deepEqual(state(restored).routeFailures, saved.routeFailures);
  assert.equal(state(restored).mandates[mandate.id].routeSwitches?.length, 1);
  expectError(restored.recordRouteFailure({
    mandateId: mandate.id, failureKind: "quota", failureCode: "quota", ...guard(restored)
  }), "STALE_GENERATION");
});
