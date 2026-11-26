import test from "node:test";
import assert from "node:assert/strict";
import { ToolArgsError } from "@deepseek-ai/dsh-tools";
import type { ModelRoute, SetModelPolicyInput } from "../../src/core/index.ts";
import {
  adaptNativeModelFailure,
  classifyModelFailure,
  inspectMandateRoute,
  registerModelFailureAdapter,
} from "../../src/host/routing.ts";
import { registerSuperTools } from "../../src/host/tools.ts";
import { RunRepository } from "../../src/host/store.ts";
import { createInput, drivers, MemoryProofStore, MemoryTable } from "./helpers.ts";

const routeA: ModelRoute = { provider: "provider-a", model: "model-a", reasoningEffort: "low" };
const routeB: ModelRoute = { provider: "provider-b", model: "model-b", reasoningEffort: "high" };
const validPolicy: SetModelPolicyInput["policy"] = {
  mode: "balanced", allowedRoutes: [routeA, routeB], workerRoute: routeA, reviewerRoute: routeB,
  allowFailureSwitch: true, maxSameRouteRetries: 1, maxRouteSwitches: 1,
};

type ToolValue = {
  ok: boolean;
  error?: { code: string; message: string };
  value?: any;
  state: any;
};
type Tool = { execute(args: unknown, exec: unknown): Promise<ToolValue> };

async function fixture(policy: SetModelPolicyInput["policy"] = validPolicy) {
  const table = new MemoryTable();
  const proofs = new MemoryProofStore();
  const repo = new RunRepository(table, drivers(), undefined, proofs);
  const selections = new Map<string, ModelRoute>();
  const requests = new Map<string, ModelRoute>();
  const agents = new Map<string, any>();
  const makeAgent = (id: string, preset: string, route: ModelRoute) => {
    const agent = {
      id, status: "running", currentPreset: preset, session: { header: { agentPreset: preset } },
      model: {
        current: () => selections.get(id),
        select: (selection: ModelRoute) => { selections.set(id, structuredClone(selection)); },
      },
    };
    agents.set(id, agent);
    selections.set(id, structuredClone(route));
    requests.set(id, structuredClone(route));
    return agent;
  };
  const root = makeAgent("root-route", "super-agent", routeA);
  const worker = makeAgent("worker-route", "super-agent", routeA);
  const reviewer = makeAgent("reviewer-route", "standard", routeB);
  const definitions = new Map<string, Tool>();
  const ctx = {
    tools: { register(definition: never) { definitions.set((definition as { name: string }).name, definition); return () => {}; } },
    on: (..._args: any[]) => () => {},
    agents: { get: (id: string) => agents.get(id) },
    subagents: {
      rootOf: () => root,
      listDescendants: async () => [worker, reviewer].map(agent => ({ kind: "child", id: agent.id })),
    },
    sessionQuery: {
      observeSession: async (id: string) => ({
        projections: { values: { agentPreset: agents.get(id)?.currentPreset ?? null } },
        [Symbol.dispose]: () => {},
      }),
      inspectSession: async (id: string, read: (session: unknown) => unknown) => read({
        requestHeader: () => requests.has(id) ? { config: requests.get(id) } : undefined,
      }),
    },
  };
  registerSuperTools(ctx as never, repo);
  const exec = { agent: root, signal: new AbortController().signal };
  const run = definitions.get("super_run")!;
  const input = createInput(root.id);
  assert.equal((await run.execute({ action: "create", objective: input.objective, definitionOfDone: input.definitionOfDone, obligations: input.obligations }, exec)).ok, true);
  const route = definitions.get("super_route")!;
  const set = await route.execute({ action: "set", expectedRevision: 1, expectedGeneration: 1, policy }, exec);
  assert.equal(set.ok, true);
  assert.equal((await run.execute({
    action: "plan", expectedRevision: 2, expectedGeneration: 1,
    items: [{ id: "item", title: "Routed work", dependencies: [], writeScopes: [], acceptance: ["independent review"], obligationIds: [], gateProfile: "code" }],
  }, exec)).ok, true);
  const prepared = await definitions.get("super_mandate")!.execute({
    action: "prepare", expectedRevision: 3, expectedGeneration: 1, workItemId: "item",
    workerAgentId: worker.id, reviewerAgentId: reviewer.id, knownFailures: [], routeReason: "explicit role routes",
  }, exec);
  assert.equal(prepared.ok, true);
  await definitions.get("super_mandate")!.execute({
    action: "bind", expectedRevision: 4, expectedGeneration: 1, mandateId: prepared.value.id, workerAgentId: worker.id,
  }, exec);
  return {
    ctx, repo, table, proofs, root, worker, reviewer, route, exec, definitions,
    mandate: repo.read(root.id)!.mandates[prepared.value.id]!,
    selections, requests,
  };
}

test("super_route persists policy, freezes role routes in Mandate and reads actual child/header routes", async () => {
  const s = await fixture();
  assert.equal(s.mandate.workerRoute?.provider, "provider-a");
  assert.equal(s.mandate.reviewerRoute?.provider, "provider-b");
  assert.equal(s.mandate.routeReason, "explicit role routes");
  assert.equal(s.mandate.policyRevision, 1);
  const inspected = await s.route.execute({ action: "inspect", mandateId: s.mandate.id, targetRole: "worker" }, s.exec);
  assert.equal(inspected.ok, true);
  assert.equal(inspected.value.status, "matched");
  assert.equal(inspected.value.currentRoute.model, "model-a");
  assert.equal(inspected.value.lastRequestRoute.model, "model-a");
  const reviewer = await s.route.execute({ action: "inspect", mandateId: s.mandate.id, targetRole: "reviewer" }, s.exec);
  assert.equal(reviewer.value.status, "matched");
  assert.equal(reviewer.value.currentRoute.model, "model-b");
  s.selections.set(s.worker.id, routeB);
  const mismatch = await inspectMandateRoute(s.ctx as never, s.repo.read(s.root.id), s.mandate.id, "worker");
  assert.equal(mismatch.status, "unknown");
  assert.equal(mismatch.reason, "ROUTE_MISMATCH");
  await assert.rejects(s.route.execute({
    action: "set", expectedRevision: 5, expectedGeneration: 1,
    policy: { ...validPolicy, allowedRoutes: [{ provider: "only-provider" }] },
  }, s.exec), (error: unknown) => error instanceof ToolArgsError);
  const shown = await s.route.execute({ action: "show" }, s.exec);
  assert.equal(shown.value.modelPolicy.allowedRoutes.length, 2);
  assert.equal(shown.value.routeFailures.length, 0);
});

test("native request failure retries once, then blocks without model.select or evidence rewriting", async () => {
  const s = await fixture();
  const selects = [];
  s.worker.model.select = (route: ModelRoute) => { selects.push(route); s.selections.set(s.worker.id, route); };
  const failure = { code: "ECONNRESET", message: "network body must not be persisted", status: 0 };
  assert.equal(await adaptNativeModelFailure(s.ctx as never, s.repo, s.worker as never, failure, new AbortController().signal), "retry");
  let state = s.repo.read(s.root.id)!;
  assert.equal(Object.values(state.routeFailures).length, 1);
  assert.equal(Object.values(state.routeFailures)[0]?.action, "retry_recorded");
  assert.equal(JSON.stringify(state.routeFailures).includes(failure.message), false);
  assert.equal(selects.length, 0);
  assert.equal(await adaptNativeModelFailure(s.ctx as never, s.repo, s.worker as never, failure, new AbortController().signal), "blocked");
  state = s.repo.read(s.root.id)!;
  assert.equal(state.run.status, "blocked");
  assert.equal(state.workItems.item?.attempt, 1);
  assert.equal(Object.keys(state.evidence).length, 0);
});

test("quota failure switches authorized worker route once and recovery retains policy/budget/history", async () => {
  const s = await fixture();
  const failure = { code: "QUOTA_EXCEEDED", message: "sensitive response is not stored", status: 402 };
  assert.equal(await adaptNativeModelFailure(s.ctx as never, s.repo, s.worker as never, failure, new AbortController().signal), "switch");
  let state = s.repo.read(s.root.id)!;
  const mandate = state.mandates[s.mandate.id]!;
  assert.equal(mandate.workerRoute?.provider, "provider-b");
  assert.equal(mandate.reviewerRoute?.provider, "provider-b", "Reviewer tool preset/route must not be changed by Worker failure");
  assert.equal(mandate.routeSwitches?.length, 1);
  assert.equal(mandate.routeSwitches?.[0]?.status, "requested");
  assert.equal(s.selections.get(s.worker.id)?.provider, "provider-b");
  assert.equal(mandate.attempt, 1);
  assert.equal(Object.keys(state.evidence).length, 0);
  const switchedReport = await s.definitions.get("super_mandate")!.execute({
    action: "report", mandateId: mandate.id, summary: "new work after switch must not use old mandate",
  }, { agent: s.worker, signal: new AbortController().signal });
  assert.equal(switchedReport.ok, false);
  assert.equal(switchedReport.error?.code, "ROUTE_SWITCH_REQUIRES_NEW_MANDATE");
  assert.deepEqual(s.repo.read(s.root.id)!.evidence, state.evidence);
  assert.equal(await adaptNativeModelFailure(s.ctx as never, s.repo, s.worker as never, failure, new AbortController().signal), "blocked");
  assert.equal(s.repo.read(s.root.id)?.run.status, "blocked");

  const restoredRepo = new RunRepository(s.table, drivers(), undefined, s.proofs);
  const restored = await restoredRepo.recover(s.root.id);
  assert.ok(restored.ok);
  assert.equal(restored.state.run.generation, 2);
  assert.equal(restored.state.run.modelPolicy?.allowedRoutes.length, 2);
  assert.equal(Object.keys(restored.state.routeFailures).length, 2);
  assert.equal(restored.state.mandates[s.mandate.id]?.routeSwitches?.length, 1);
});

test("prepared Reviewer placeholder remains unhandled before formal binding", async () => {
  const s = await fixture();
  assert.equal(await adaptNativeModelFailure(s.ctx as never, s.repo, s.reviewer as never,
    { code: "PROVIDER_UNAVAILABLE", message: "no body" }, new AbortController().signal), "unhandled");
  assert.equal(Object.keys(s.repo.read(s.root.id)?.routeFailures ?? {}).length, 0);
});

test("Reviewer failure uses reviewerRoute independently and does not change standard composition", async () => {
  const s = await fixture();
  // Route adaptation intentionally requires a formally bound Reviewer; a prepared placeholder stays unhandled.
  assert.ok((await s.repo.transact(s.root.id, core => core.reportWorkerDone({
    expectedRevision: 5, expectedGeneration: 1, mandateId: s.mandate.id, workerId: s.worker.id, summary: "ready for review",
  }))).ok);
  assert.ok((await s.repo.transact(s.root.id, core => core.bindReviewer({
    expectedRevision: 6, expectedGeneration: 1, mandateId: s.mandate.id, reviewerAgentId: s.reviewer.id,
  }))).ok);
  assert.equal(await adaptNativeModelFailure(s.ctx as never, s.repo, s.reviewer as never, { code: "PROVIDER_UNAVAILABLE", message: "no body" }, new AbortController().signal), "switch");
  const state = s.repo.read(s.root.id)!;
  const failure = Object.values(state.routeFailures)[0]!;
  assert.equal(failure.route?.model, "model-b");
  assert.equal(state.mandates[s.mandate.id]?.reviewerRoute?.provider, "provider-a");
  assert.equal(state.mandates[s.mandate.id]?.workerRoute?.provider, "provider-a");
  assert.equal(s.reviewer.currentPreset, "standard");
  const decision = await s.definitions.get("super_review")!.execute({
    action: "decide", expectedRevision: state.run.revision, expectedGeneration: state.run.generation,
    workItemId: "item", mandateId: s.mandate.id, result: "unknown", evidenceIds: [],
  }, { agent: s.reviewer, signal: new AbortController().signal });
  assert.equal(decision.ok, false);
  assert.equal(decision.error?.code, "ROUTE_SWITCH_REQUIRES_NEW_MANDATE");
  assert.deepEqual(s.repo.read(s.root.id)!.decisions, state.decisions);
});

test("switchable failure with no alternate route is durably blocked without model.select", async () => {
  const { reviewerRoute: _inheritedReviewer, ...workerOnlyPolicy } = validPolicy;
  const s = await fixture({ ...workerOnlyPolicy, allowedRoutes: [routeA], workerRoute: routeA });
  const selects = [];
  s.worker.model.select = (route: ModelRoute) => { selects.push(route); };
  const outcome = await adaptNativeModelFailure(s.ctx as never, s.repo, s.worker as never,
    { code: "PROVIDER_UNAVAILABLE", message: "no response body" }, new AbortController().signal);
  assert.equal(outcome, "blocked");
  const state = s.repo.read(s.root.id)!;
  assert.equal(state.run.status, "blocked");
  assert.equal(Object.values(state.routeFailures)[0]?.action, "rejected");
  assert.equal(selects.length, 0);
});

test("business/auth/unknown failures never select another model", async () => {
  assert.equal(classifyModelFailure({ code: "EVIDENCE_FAIL" }), "business_acceptance");
  assert.equal(classifyModelFailure({ code: "INVALID_API_KEY" }), "authentication");
  assert.equal(classifyModelFailure({ code: "MYSTERY" }), "unknown");
  const s = await fixture();
  const selects = [];
  s.worker.model.select = (route: ModelRoute) => { selects.push(route); };
  for (const failure of [{ code: "EVIDENCE_FAIL", message: "business" }, { code: "INVALID_API_KEY", message: "auth" }, { code: "MYSTERY", message: "unknown" }]) {
    assert.equal(await adaptNativeModelFailure(s.ctx as never, s.repo, s.worker as never, failure, new AbortController().signal), "delegate");
  }
  assert.equal(selects.length, 0);
  assert.equal(Object.keys(s.repo.read(s.root.id)!.routeFailures).length, 3);
});

test("model.select failure is explicit after durable Core switch and never reported as pass", async () => {
  const s = await fixture();
  const evidence = await s.repo.transact(s.root.id, core => core.recordEvidence({
    expectedRevision: s.repo.read(s.root.id)!.run.revision, expectedGeneration: 1,
    workItemId: "item", mandateId: s.mandate.id, attempt: 1, kind: "build", result: "unknown",
    sourceActor: s.reviewer.id, sourceRole: "reviewer", receipt: { exitCode: 0 }, summary: "pre-switch evidence",
  }));
  assert.ok(evidence.ok);
  const beforeEvidence = structuredClone(s.repo.read(s.root.id)!.evidence);
  const beforeAgentCount = s.ctx.agents ? new Set(s.selections.keys()).size : 0;
  const recorded = await s.repo.transact(s.root.id, core => core.recordRouteFailure({
    expectedRevision: s.repo.read(s.root.id)!.run.revision, expectedGeneration: 1,
    mandateId: s.mandate.id, targetRole: "worker", failureKind: "quota", failureCode: "QUOTA_EXCEEDED",
  }));
  assert.ok(recorded.ok);
  s.worker.model.select = () => { throw new Error("native selection failed"); };
  const result = await s.route.execute({
    action: "switch", mandateId: s.mandate.id, targetRole: "worker", to: routeB,
    failureCode: "QUOTA_EXCEEDED", reason: "authorized bounded switch",
  }, s.exec);
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "ROUTE_SELECT_FAILED_AFTER_COMMIT");
  const state = s.repo.read(s.root.id)!;
  assert.equal(state.mandates[s.mandate.id]?.routeSwitches?.length, 1, "durable Core switch remains explicit, not rolled back falsely");
  assert.equal(state.workItems.item?.attempt, 1);
  assert.deepEqual(state.evidence, beforeEvidence);
  assert.equal(new Set(s.selections.keys()).size, beforeAgentCount, "route switch must not create another Agent");
  assert.equal(state.mandates[s.mandate.id]?.status, "running");
});

test("super_route is root-only and Core rejects unauthorized locked routes", async () => {
  const s = await fixture();
  const before = s.repo.read(s.root.id);
  const descendant = await s.route.execute({ action: "show" }, { agent: s.worker, signal: new AbortController().signal });
  assert.equal(descendant.ok, false);
  assert.equal(descendant.error?.code, "ACTOR_MISMATCH");
  assert.deepEqual(s.repo.read(s.root.id), before);
  const invalid = await s.route.execute({
    action: "set", expectedRevision: before!.run.revision, expectedGeneration: 1,
    policy: { ...validPolicy, mode: "locked", workerRoute: { provider: "not-allowed", model: "not-allowed" } },
  }, s.exec);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error?.code, "ROUTE_NOT_ALLOWED");
  assert.deepEqual(s.repo.read(s.root.id), before);
});

test("native request-error registration preserves delegation without policy and retries under policy", async () => {
  const s = await fixture();
  let listener: ((payload: any, next: () => Promise<undefined>) => Promise<unknown>) | undefined;
  s.ctx.on = (_event: string, callback: typeof listener) => { listener = callback; return () => {}; };
  registerModelFailureAdapter(s.ctx as never, s.repo);
  assert.ok(listener);
  const retry = await listener!({
    agent: s.worker, failure: { code: "TIMEOUT", message: "timeout" }, signal: new AbortController().signal,
  }, async () => undefined);
  assert.deepEqual(retry, { kind: "retry" });

  const emptyRepo = new RunRepository(new MemoryTable(), drivers(), undefined, new MemoryProofStore());
  await emptyRepo.create(s.root.id, createInput(s.root.id));
  let noPolicyListener: ((payload: any, next: () => Promise<undefined>) => Promise<unknown>) | undefined;
  s.ctx.on = (_event: string, callback: typeof noPolicyListener) => { noPolicyListener = callback; return () => {}; };
  registerModelFailureAdapter(s.ctx as never, emptyRepo);
  let delegated = 0;
  const result = await noPolicyListener!({
    agent: s.worker, failure: { code: "MYSTERY", message: "unknown" }, signal: new AbortController().signal,
  }, async () => { delegated += 1; return undefined; });
  assert.equal(result, undefined);
  assert.equal(delegated, 1);
});
